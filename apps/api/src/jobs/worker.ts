import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { claim, complete, fail, requeueStale, type Job } from './queue.ts';
import { materializeProposal } from '../proposals/materialize.ts';
import { ExtractionError, type ExtractionProvider } from '../extraction/provider.ts';
import { type Storage, UPLOADS_BUCKET } from '../storage/index.ts';

/**
 * Background worker.
 *
 * Extraction runs here rather than inside the upload request. A multi-file upload
 * can take a minute or more and an HTTP request held open that long will be cut
 * by a proxy somewhere between the browser and the process; the analyzing screen
 * polls instead.
 */

export interface WorkerDeps {
  db: Db;
  storage: Storage;
  extractor: ExtractionProvider;
}

export interface WorkerHandle {
  stop(): Promise<void>;
  /** Run one poll cycle. Exposed for tests so they need not wait on a timer. */
  tick(): Promise<boolean>;
}

const POLL_MS = 1500;

export function startWorker(deps: WorkerDeps): WorkerHandle {
  const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  let running = true;
  let current: Promise<void> = Promise.resolve();

  async function tick(): Promise<boolean> {
    const job = await claim(deps.db, workerId);
    if (!job) return false;

    try {
      await handle(deps, job);
      await complete(deps.db, job.id);
    } catch (err) {
      const retryable = err instanceof ExtractionError ? err.retryable : false;
      const { willRetry } = await fail(deps.db, job, err, retryable);
      if (!willRetry) await recordTerminalFailure(deps.db, job, err);
    }
    return true;
  }

  async function loop() {
    // Reclaim anything a previous process died holding, so a crash does not leave
    // the analyzing screen spinning on a job nobody owns.
    await requeueStale(deps.db).catch(() => {});

    /*
     * A blip must not kill the loop — but a failure that keeps happening must not
     * be silent either. Swallowing every error meant the worker could spin
     * forever claiming nothing while an upload sat at "Waiting for the next
     * file…", with no line in the log to say so.
     *
     * So: shrug off the first couple, then say something, and keep saying it
     * occasionally rather than once. Backing off also stops a persistent failure
     * hammering the database several times a second.
     */
    let consecutiveFailures = 0;

    while (running) {
      let did = false;
      try {
        did = await tick();
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures === 3 || consecutiveFailures % 20 === 0) {
          console.warn(
            `[worker] ${consecutiveFailures} consecutive failures claiming or running a job; ` +
            `queued work is not being processed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const backoff = consecutiveFailures > 0
        ? Math.min(POLL_MS * 2 ** Math.min(consecutiveFailures, 5), 30_000)
        : POLL_MS;
      if (!did || consecutiveFailures > 0) {
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  current = loop();

  return {
    async stop() {
      running = false;
      await current;
    },
    tick,
  };
}

async function handle(deps: WorkerDeps, job: Job): Promise<void> {
  switch (job.kind) {
    case 'extract_file':
      return extractFile(deps, job.payload as { file_id: string });
    case 'generate_document':
      // Generation runs synchronously in the request today — a broker is waiting
      // and wants the PDF, not a spinner. Kept here for when batch regeneration
      // needs it.
      return;
    default:
      throw new Error(`Unknown job kind: ${job.kind}`);
  }
}

async function extractFile(deps: WorkerDeps, payload: { file_id: string }): Promise<void> {
  const { db, storage, extractor } = deps;

  const { rows } = await db.query<{
    id: string; proposal_id: string; storage_path: string; original_filename: string;
  }>(
    `select id, proposal_id, storage_path, original_filename from sp_files where id = $1`,
    [payload.file_id],
  );
  const file = rows[0];
  if (!file) return; // Deleted while queued — nothing to do.

  await db.query(`update sp_files set extraction_status = 'running' where id = $1`, [file.id]);

  const { rows: runRows } = await db.query<{ id: string }>(
    `insert into sp_extractions (file_id, proposal_id, provider, model, status)
     values ($1,$2,$3,$4,'running') returning id`,
    [file.id, file.proposal_id, extractor.name, extractor.model],
  );
  const runId = runRows[0].id;

  try {
    const pdf = await storage.download(UPLOADS_BUCKET, file.storage_path);
    const outcome = await extractor.extract({ pdf, filename: file.original_filename });

    await db.query(
      `update sp_extractions
          set status = 'succeeded', raw_response = $2, parsed = $3,
              input_tokens = $4, output_tokens = $5, model = $6, completed_at = now()
        where id = $1`,
      [
        runId,
        JSON.stringify(outcome.raw),
        JSON.stringify(outcome.result),
        outcome.usage.inputTokens,
        outcome.usage.outputTokens,
        outcome.model,
      ],
    );
    await db.query(
      `update sp_files set extraction_status = 'succeeded', error_text = null where id = $1`,
      [file.id],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query(
      `update sp_extractions set status = 'failed', error_text = $2, completed_at = now() where id = $1`,
      [runId, message],
    );
    // Name the file on the row the UI reads, so the analyzing screen can say
    // which file failed and offer to continue without it.
    await db.query(
      `update sp_files set extraction_status = 'failed', error_text = $2 where id = $1`,
      [file.id, message],
    );
    throw err;
  }

  await materializeIfComplete(db, file.proposal_id);
}

/**
 * Build the editable draft once every file has stopped moving.
 *
 * Deliberately "no longer pending" rather than "all succeeded": a proposal where
 * one of three quotes failed should still be reviewable with the other two.
 */
async function materializeIfComplete(db: Db, proposalId: string): Promise<void> {
  const { rows } = await db.query<{ outstanding: number }>(
    `select count(*)::int as outstanding
       from sp_files
      where proposal_id = $1 and extraction_status in ('pending','running')`,
    [proposalId],
  );
  if (rows[0].outstanding > 0) return;
  await materializeProposal(db, proposalId).catch(() => {});
}

async function recordTerminalFailure(db: Db, job: Job, err: unknown): Promise<void> {
  if (job.kind !== 'extract_file') return;
  const fileId = (job.payload as { file_id?: string }).file_id;
  if (!fileId) return;

  await db.query(
    `update sp_files set extraction_status = 'failed', error_text = $2 where id = $1`,
    [fileId, err instanceof Error ? err.message : String(err)],
  );
  const { rows } = await db.query<{ proposal_id: string }>(
    `select proposal_id from sp_files where id = $1`, [fileId],
  );
  if (rows[0]) await materializeIfComplete(db, rows[0].proposal_id);
}
