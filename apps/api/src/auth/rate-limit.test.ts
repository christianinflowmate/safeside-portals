import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLoginRateLimit, recordLoginAttempt, pruneLoginAttempts,
  EMAIL_LIMIT, IP_LIMIT,
} from './rate-limit.ts';
import { freshDb } from '../test-support.ts';
import type { Db } from '../db/index.ts';

describe('login rate limiting', () => {
  let db: Db;
  before(async () => { db = await freshDb(); });
  after(async () => { await db.close(); });
  beforeEach(async () => { await db.query('delete from sp_login_attempts'); });

  const EMAIL = 'broker@example.test';
  const IP = '203.0.113.10';

  test('a first attempt is allowed', async () => {
    const r = await checkLoginRateLimit(db, EMAIL, IP);
    assert.equal(r.allowed, true);
  });

  test('failures below the limit stay allowed', async () => {
    for (let i = 0; i < EMAIL_LIMIT - 1; i++) {
      await recordLoginAttempt(db, EMAIL, IP, false);
    }
    assert.equal((await checkLoginRateLimit(db, EMAIL, IP)).allowed, true);
  });

  test('the email limit blocks further attempts', async () => {
    for (let i = 0; i < EMAIL_LIMIT; i++) {
      await recordLoginAttempt(db, EMAIL, IP, false);
    }
    const r = await checkLoginRateLimit(db, EMAIL, IP);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'email');
    assert.ok(r.retryAfterSeconds > 0, 'tells the caller when to come back');
  });

  // One host working through many addresses would never trip the email limit.
  test('the IP limit catches many addresses from one host', async () => {
    for (let i = 0; i < IP_LIMIT; i++) {
      await recordLoginAttempt(db, `guess-${i}@example.test`, IP, false);
    }
    const r = await checkLoginRateLimit(db, 'someone-else@example.test', IP);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ip');
  });

  test('a different address from a clean host is unaffected', async () => {
    for (let i = 0; i < EMAIL_LIMIT; i++) {
      await recordLoginAttempt(db, EMAIL, IP, false);
    }
    const r = await checkLoginRateLimit(db, 'other@example.test', '198.51.100.7');
    assert.equal(r.allowed, true);
  });

  // The ordinary "got it on the fourth try" case must leave nothing behind.
  test('a success clears that address\'s failures', async () => {
    for (let i = 0; i < EMAIL_LIMIT - 1; i++) {
      await recordLoginAttempt(db, EMAIL, IP, false);
    }
    await recordLoginAttempt(db, EMAIL, IP, true);

    const { rows } = await db.query<{ n: number }>(
      'select count(*)::int as n from sp_login_attempts where email = $1 and not succeeded', [EMAIL]);
    assert.equal(rows[0].n, 0);
    assert.equal((await checkLoginRateLimit(db, EMAIL, IP)).allowed, true);
  });

  test('failures outside the window no longer count', async () => {
    for (let i = 0; i < EMAIL_LIMIT; i++) {
      await recordLoginAttempt(db, EMAIL, IP, false);
    }
    assert.equal((await checkLoginRateLimit(db, EMAIL, IP)).allowed, false);

    await db.query(
      `update sp_login_attempts set created_at = now() - interval '20 minutes' where email = $1`,
      [EMAIL]);
    assert.equal((await checkLoginRateLimit(db, EMAIL, IP)).allowed, true);
  });

  // Attempts against addresses that do not exist must still be counted, or the
  // limit only protects accounts an attacker has already confirmed.
  test('attempts on unknown addresses are counted', async () => {
    for (let i = 0; i < EMAIL_LIMIT; i++) {
      await recordLoginAttempt(db, 'no-such-user@example.test', IP, false);
    }
    const r = await checkLoginRateLimit(db, 'no-such-user@example.test', IP);
    assert.equal(r.allowed, false);
  });

  test('a missing IP does not break the check', async () => {
    await recordLoginAttempt(db, EMAIL, null, false);
    assert.equal((await checkLoginRateLimit(db, EMAIL, null)).allowed, true);
  });

  test('pruning removes old rows and keeps recent ones', async () => {
    await recordLoginAttempt(db, EMAIL, IP, false);
    await recordLoginAttempt(db, 'old@example.test', IP, false);
    await db.query(
      `update sp_login_attempts set created_at = now() - interval '48 hours' where email = 'old@example.test'`);

    assert.ok((await pruneLoginAttempts(db, 24)) >= 1);
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from sp_login_attempts');
    assert.equal(rows[0].n, 1);
  });
});
