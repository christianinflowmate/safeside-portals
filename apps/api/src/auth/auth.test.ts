import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, needsRehash } from './passwords.ts';
import {
  createSession, resolveSession, destroySession, destroyAllSessions,
  pruneExpiredSessions, hashToken, safeEqual,
} from './sessions.ts';
import { freshDb, makeUser, makeProposal } from '../test-support.ts';
import {
  getOwnedProposal, assertOwnsProposal, listOwnedProposals,
  getOwnedFile, updateOwnedProposal, NotFoundError,
} from '../db/scoped.ts';
import type { Db } from '../db/index.ts';

describe('password hashing', () => {
  test('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('fixture-password-not-in-use');
    assert.match(h, /^\$argon2id\$/);
    assert.equal(await verifyPassword(h, 'fixture-password-not-in-use'), true);
    assert.equal(await verifyPassword(h, 'Correct horse battery staple'), false);
  });

  test('the same password hashes differently each time (salted)', async () => {
    const [a, b] = await Promise.all([hashPassword('same password here'), hashPassword('same password here')]);
    assert.notEqual(a, b);
  });

  test('rejects passwords under twelve characters', async () => {
    await assert.rejects(() => hashPassword('short'), /at least 12/);
  });

  // A corrupt stored hash must read as "did not verify", never throw into a
  // catch block that a caller might treat as success.
  test('a malformed stored hash fails closed', async () => {
    assert.equal(await verifyPassword('not-a-hash', 'anything at all'), false);
    assert.equal(await verifyPassword('', 'anything at all'), false);
  });

  test('detects hashes made with weaker parameters', async () => {
    assert.equal(needsRehash(await hashPassword('fixture-password-not-in-use')), false);
    assert.equal(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$abc$def'), true);
    assert.equal(needsRehash('$2b$10$oldbcrypthash'), true);
  });
});

describe('sessions', () => {
  let db: Db;
  before(async () => { db = await freshDb(); });
  after(async () => { await db.close(); });

  test('a created session resolves to its user', async () => {
    const user = await makeUser(db);
    const { token } = await createSession(db, user.id);

    const resolved = await resolveSession(db, token);
    assert.equal(resolved?.id, user.id);
    assert.equal(resolved?.email, user.email);
  });

  // The cookie value must not be what is stored, so a database leak does not
  // hand over live sessions.
  test('only the token hash is stored, never the token', async () => {
    const user = await makeUser(db);
    const { token } = await createSession(db, user.id);

    const { rows } = await db.query<{ token_hash: string }>(
      'select token_hash from sp_sessions where user_id = $1', [user.id],
    );
    assert.equal(rows[0].token_hash, hashToken(token));
    assert.notEqual(rows[0].token_hash, token);
  });

  test('an unknown or absent token resolves to null', async () => {
    assert.equal(await resolveSession(db, 'not-a-real-token'), null);
    assert.equal(await resolveSession(db, undefined), null);
    assert.equal(await resolveSession(db, ''), null);
  });

  test('an expired session does not resolve', async () => {
    const user = await makeUser(db);
    const { token } = await createSession(db, user.id);
    await db.query(
      `update sp_sessions set expires_at = now() - interval '1 second' where user_id = $1`,
      [user.id],
    );
    assert.equal(await resolveSession(db, token), null);
  });

  // Disabling an account must take effect immediately, without having to hunt
  // down and delete that user's session rows.
  test('deactivating a user invalidates their live sessions', async () => {
    const user = await makeUser(db);
    const { token } = await createSession(db, user.id);
    assert.ok(await resolveSession(db, token));

    await db.query('update sp_users set is_active = false where id = $1', [user.id]);
    assert.equal(await resolveSession(db, token), null);
  });

  test('logging out destroys only that session', async () => {
    const user = await makeUser(db);
    const a = await createSession(db, user.id);
    const b = await createSession(db, user.id);

    await destroySession(db, a.token);
    assert.equal(await resolveSession(db, a.token), null);
    assert.ok(await resolveSession(db, b.token), 'other device stays logged in');
  });

  test('destroyAllSessions logs out every device', async () => {
    const user = await makeUser(db);
    const a = await createSession(db, user.id);
    const b = await createSession(db, user.id);

    await destroyAllSessions(db, user.id);
    assert.equal(await resolveSession(db, a.token), null);
    assert.equal(await resolveSession(db, b.token), null);
  });

  test('pruning removes expired rows and leaves live ones', async () => {
    const user = await makeUser(db);
    const live = await createSession(db, user.id);
    await createSession(db, user.id);
    await db.query(
      `update sp_sessions set expires_at = now() - interval '1 hour'
        where user_id = $1 and token_hash <> $2`,
      [user.id, hashToken(live.token)],
    );

    const removed = await pruneExpiredSessions(db);
    assert.ok(removed >= 1);
    assert.ok(await resolveSession(db, live.token));
  });

  test('safeEqual compares correctly', () => {
    assert.equal(safeEqual('abc123', 'abc123'), true);
    assert.equal(safeEqual('abc123', 'abc124'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
  });
});

describe('ownership scoping', () => {
  let db: Db;
  before(async () => { db = await freshDb(); });
  after(async () => { await db.close(); });

  test('an owner can read their proposal', async () => {
    const owner = await makeUser(db);
    const id = await makeProposal(db, owner.id);
    const p = await getOwnedProposal(db, owner.id, id);
    assert.equal(p.id, id);
  });

  // The whole point. RLS does not stop this — the service role key bypasses it.
  test("a user cannot read another user's proposal", async () => {
    const owner = await makeUser(db);
    const other = await makeUser(db);
    const id = await makeProposal(db, owner.id);

    await assert.rejects(() => getOwnedProposal(db, other.id, id), NotFoundError);
    await assert.rejects(() => assertOwnsProposal(db, other.id, id), NotFoundError);
  });

  // 404 rather than 403, so a logged-in user cannot probe which proposal ids exist.
  test('another user\'s proposal is indistinguishable from a missing one', async () => {
    const owner = await makeUser(db);
    const other = await makeUser(db);
    const real = await makeProposal(db, owner.id);
    const fake = '99999999-9999-4999-8999-999999999999';

    const a = await getOwnedProposal(db, other.id, real).catch((e) => e);
    const b = await getOwnedProposal(db, other.id, fake).catch((e) => e);
    assert.equal(a.constructor, b.constructor);
    assert.equal(a.message, b.message);
  });

  test('listing returns only the caller\'s proposals', async () => {
    const a = await makeUser(db);
    const b = await makeUser(db);
    await makeProposal(db, a.id, 'Alpha Co');
    await makeProposal(db, a.id, 'Beta Co');
    await makeProposal(db, b.id, 'Gamma Co');

    const listed = await listOwnedProposals(db, a.id);
    assert.equal(listed.length, 2);
    assert.ok(!listed.some((p) => p.client_name === 'Gamma Co'));
  });

  // Knowing a child row's UUID must not be enough to read it.
  test('a file is scoped through its proposal', async () => {
    const owner = await makeUser(db);
    const other = await makeUser(db);
    const proposalId = await makeProposal(db, owner.id);

    const { rows } = await db.query<{ id: string }>(
      `insert into sp_files (proposal_id, original_filename, storage_path, size_bytes, mime_type, uploaded_by)
       values ($1, 'quote.pdf', $2, 1024, 'application/pdf', $3) returning id`,
      [proposalId, `p/${proposalId}/quote.pdf`, owner.id],
    );

    assert.ok(await getOwnedFile(db, owner.id, rows[0].id));
    await assert.rejects(() => getOwnedFile(db, other.id, rows[0].id), NotFoundError);
  });

  test('updates are scoped to the owner', async () => {
    const owner = await makeUser(db);
    const other = await makeUser(db);
    const id = await makeProposal(db, owner.id);

    const updated = await updateOwnedProposal(db, owner.id, id, { client_name: 'Renamed Co' });
    assert.equal(updated.client_name, 'Renamed Co');

    await assert.rejects(
      () => updateOwnedProposal(db, other.id, id, { client_name: 'Hijacked' }),
      NotFoundError,
    );
    const after = await getOwnedProposal(db, owner.id, id);
    assert.equal(after.client_name, 'Renamed Co');
  });

  // Column names are concatenated into SQL, so anything not whitelisted must be
  // dropped rather than reaching the query.
  test('non-whitelisted columns are ignored, not injected', async () => {
    const owner = await makeUser(db);
    const other = await makeUser(db);
    const id = await makeProposal(db, owner.id);

    const updated = await updateOwnedProposal(db, owner.id, id, {
      client_name: 'Legit Name',
      owner_user_id: other.id,
      'id = id, owner_user_id': other.id,
    });

    assert.equal(updated.client_name, 'Legit Name');
    assert.equal(updated.owner_user_id, owner.id, 'ownership must not be transferable via patch');
  });

  test('the list surfaces extraction state without a second status column', async () => {
    const owner = await makeUser(db);
    const id = await makeProposal(db, owner.id);
    await db.query(
      `insert into sp_files (proposal_id, original_filename, storage_path, size_bytes, mime_type, uploaded_by, extraction_status)
       values ($1,'a.pdf',$2,10,'application/pdf',$3,'running'),
              ($1,'b.pdf',$4,10,'application/pdf',$3,'failed')`,
      [id, `p/${id}/a.pdf`, owner.id, `p/${id}/b.pdf`],
    );

    const [p] = await listOwnedProposals(db, owner.id);
    assert.equal(p.file_count, 2);
    assert.equal(p.files_extracting, 1);
    assert.equal(p.files_failed, 1);
    assert.equal(p.status, 'draft');
  });
});
