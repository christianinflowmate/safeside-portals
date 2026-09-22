import type { Db } from '../db/index.ts';

/**
 * Database-backed job queue.
 *
 * At this volume — a handful of brokers, a few proposals a day — standing up
 * Redis would be infrastructure to maintain for no benefit. Postgres already
 * gives durability and atomicity; `for update skip locked` gives safe concurrent
 * claiming, so more than one worker process stays correct.
 *
 * The important property is that claiming is atomic. Two workers polling the
 * same table must never both pick up the same file: extraction costs money per
 * run, and a duplicated run also writes a second sp_extractions row that makes
 * the history harder to read.
 */

export type JobKind = 'extract_file' | 'generate_document';

export interface Job {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function enqueue(
  db: Db,
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: { runAfter?: Date; maxAttempts?: number } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into sp_jobs (kind, payload, run_after, max_attempts)
     values ($1, $2, coalesce($3, now()), coalesce($4, 3))
     returning id`,
    [kind, JSON.stringify(payload), opts.runAfter ?? null, opts.maxAttempts ?? null],
  );
  return rows[0].id;
}

/**
 * Atomically take the next due job.
 *
 * `skip locked` is what makes this safe under concurrency: a second worker
 * running the same statement skips rows the first has locked rather than
 * blocking on them or, worse, reading them as available.
 */
export async function claim(db: Db, workerId: string): Promise<Job | null> {
  const { rows } = await db.query<Job>(
    `update sp_jobs
        set status = 'running',
            attempts = attempts + 1,
            locked_at = now(),
            locked_by = $1
      where id = (
        select id from sp_jobs
         where status = 'queued' and run_after <= now()
         order by run_after
         for update skip locked
         limit 1
      )
      returning id, kind, payload, attempts, max_attempts`,
    [workerId],
  );
  return rows[0] ?? null;
}

export async function complete(db: Db, jobId: string): Promise<void> {
  await db.query(
    `update sp_jobs set status = 'succeeded', locked_at = null, locked_by = null where id = $1`,
    [jobId],
  );
}

/**
 * Record a failure.
 *
 * A retryable job that has attempts left goes back to queued with exponential
 * backoff. Anything else is terminal — retrying a malformed PDF forever costs
 * money and never succeeds.
 */
export async function fail(
  db: Db,
  job: Job,
  error: unknown,
  retryable: boolean,
): Promise<{ willRetry: boolean }> {
  const message = error instanceof Error ? error.message : String(error);
  const willRetry = retryable && job.attempts < job.max_attempts;

  if (willRetry) {
    const backoffSeconds = Math.min(300, 2 ** job.attempts * 15);
    await db.query(
      `update sp_jobs
          set status = 'queued', error_text = $2, locked_at = null, locked_by = null,
              run_after = now() + ($3 || ' seconds')::interval
        where id = $1`,
      [job.id, message, String(backoffSeconds)],
    );
  } else {
    await db.query(
      `update sp_jobs set status = 'failed', error_text = $2, locked_at = null, locked_by = null
        where id = $1`,
      [job.id, message],
    );
  }

  return { willRetry };
}

/**
 * Return jobs abandoned by a worker that died mid-run.
 *
 * Without this a crash leaves a file stuck in 'running' forever, and the
 * analyzing screen spins with nothing behind it.
 */
export async function requeueStale(db: Db, olderThanMinutes = 15): Promise<number> {
  const { rowCount } = await db.query(
    `update sp_jobs
        set status = 'queued', locked_at = null, locked_by = null
      where status = 'running'
        and locked_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  return rowCount;
}
