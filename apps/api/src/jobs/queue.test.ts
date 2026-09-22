import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, claim, complete, fail, requeueStale } from './queue.ts';
import { freshDb } from '../test-support.ts';
import type { Db } from '../db/index.ts';

describe('job queue', () => {
  let db: Db;
  before(async () => { db = await freshDb(); });
  after(async () => { await db.close(); });

  test('an enqueued job is claimable', async () => {
    const id = await enqueue(db, 'extract_file', { file_id: 'abc' });
    const job = await claim(db, 'worker-1');
    assert.equal(job?.id, id);
    assert.equal(job?.kind, 'extract_file');
    assert.deepEqual(job?.payload, { file_id: 'abc' });
    await complete(db, id);
  });

  test('claiming an empty queue returns null rather than blocking', async () => {
    assert.equal(await claim(db, 'worker-1'), null);
  });

  /*
   * The property that matters. Extraction costs money per run, so two workers
   * must never take the same job. `for update skip locked` is what guarantees it.
   */
  test('a job is claimed exactly once', async () => {
    await enqueue(db, 'extract_file', { file_id: 'once' });

    const first = await claim(db, 'worker-1');
    const second = await claim(db, 'worker-2');

    assert.ok(first, 'the first worker gets the job');
    assert.equal(second, null, 'the second worker gets nothing');
    await complete(db, first.id);
  });

  test('completing a job takes it out of the queue', async () => {
    const id = await enqueue(db, 'extract_file', { file_id: 'done' });
    const job = await claim(db, 'w');
    await complete(db, job!.id);

    const { rows } = await db.query<{ status: string }>(
      'select status from sp_jobs where id = $1', [id],
    );
    assert.equal(rows[0].status, 'succeeded');
    assert.equal(await claim(db, 'w'), null);
  });

  test('a retryable failure goes back to the queue with a delay', async () => {
    const id = await enqueue(db, 'extract_file', { file_id: 'retry' });
    const job = await claim(db, 'w');

    const { willRetry } = await fail(db, job!, new Error('rate limited'), true);
    assert.equal(willRetry, true);

    const { rows } = await db.query<{ status: string; attempts: number; error_text: string }>(
      'select status, attempts, error_text from sp_jobs where id = $1', [id],
    );
    assert.equal(rows[0].status, 'queued');
    assert.equal(rows[0].attempts, 1);
    assert.match(rows[0].error_text, /rate limited/);

    // Backoff means it is not immediately due again.
    assert.equal(await claim(db, 'w'), null, 'backoff holds it back');
  });

  // Retrying a malformed PDF forever costs money and never succeeds.
  test('a non-retryable failure is terminal', async () => {
    const id = await enqueue(db, 'extract_file', { file_id: 'bad-pdf' });
    const job = await claim(db, 'w');

    const { willRetry } = await fail(db, job!, new Error('not a PDF'), false);
    assert.equal(willRetry, false);

    const { rows } = await db.query<{ status: string }>(
      'select status from sp_jobs where id = $1', [id],
    );
    assert.equal(rows[0].status, 'failed');
  });

  test('retries stop at max_attempts', async () => {
    const id = await enqueue(db, 'extract_file', { file_id: 'giveup' }, { maxAttempts: 2 });

    for (let attempt = 1; attempt <= 2; attempt++) {
      await db.query(`update sp_jobs set run_after = now() where id = $1`, [id]);
      const job = await claim(db, 'w');
      assert.ok(job, `attempt ${attempt} claimable`);
      await fail(db, job, new Error('still failing'), true);
    }

    const { rows } = await db.query<{ status: string; attempts: number }>(
      'select status, attempts from sp_jobs where id = $1', [id],
    );
    assert.equal(rows[0].attempts, 2);
    assert.equal(rows[0].status, 'failed', 'gives up rather than retrying forever');
  });

  // Without this, a crashed worker leaves a file stuck in 'running' and the
  // analyzing screen spins on a job nobody owns.
  test('jobs abandoned by a dead worker are requeued', async () => {
    const id = await enqueue(db, 'extract_file', { file_id: 'orphan' });
    await claim(db, 'worker-that-died');
    await db.query(
      `update sp_jobs set locked_at = now() - interval '30 minutes' where id = $1`, [id],
    );

    const requeued = await requeueStale(db, 15);
    assert.ok(requeued >= 1);

    const job = await claim(db, 'worker-2');
    assert.equal(job?.id, id, 'another worker can pick it up');
    await complete(db, id);
  });

  test('a recently locked job is left alone', async () => {
    const id = await enqueue(db, 'extract_file', { file_id: 'in-flight' });
    await claim(db, 'busy-worker');

    assert.equal(await requeueStale(db, 15), 0, 'a live job is not stolen');
    await complete(db, id);
  });

  test('jobs are served oldest first', async () => {
    const a = await enqueue(db, 'extract_file', { file_id: 'first' });
    const b = await enqueue(db, 'extract_file', { file_id: 'second' });
    await db.query(`update sp_jobs set run_after = now() - interval '1 hour' where id = $1`, [a]);

    assert.equal((await claim(db, 'w'))?.id, a);
    assert.equal((await claim(db, 'w'))?.id, b);
    await complete(db, a); await complete(db, b);
  });
});
