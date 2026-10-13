import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser } from '../test-support.ts';
import { verifyPassword } from './passwords.ts';
import { createInvite, lookupInvite, acceptInvite, listInvites, revokeInvite, InviteError } from './invites.ts';

const NEW_PASSWORD = 'fixture-new-password-1';

async function setup() {
  const db = await freshDb();
  const admin = await makeUser(db, { email: 'admin@example.test' });
  return { db, admin };
}

const code = (c: string) => (err: unknown) => err instanceof InviteError && err.code === c;

describe('invitations', () => {
  test('an invite can be looked up and accepted, creating an account with the chosen password', async () => {
    const { db, admin } = await setup();
    const { token, invite } = await createInvite(db, admin.id, { email: 'new.broker@example.test', displayName: 'New Broker' });
    assert.equal(invite.status, 'pending');

    assert.deepEqual(await lookupInvite(db, token), { email: 'new.broker@example.test', display_name: 'New Broker' });

    const { userId } = await acceptInvite(db, token, NEW_PASSWORD);
    const { rows } = await db.query<{ password_hash: string; is_admin: boolean; display_name: string }>(
      `select password_hash, is_admin, display_name from sp_users where id = $1`, [userId]);
    assert.equal(await verifyPassword(rows[0].password_hash, NEW_PASSWORD), true);
    assert.equal(rows[0].is_admin, false);
    assert.equal(rows[0].display_name, 'New Broker');
  });

  test('the plain token is never stored', async () => {
    const { db, admin } = await setup();
    const { token } = await createInvite(db, admin.id, { email: 'a@example.test', displayName: 'A' });
    const { rows } = await db.query<{ token_hash: string }>(`select token_hash from sp_invites`);
    assert.notEqual(rows[0].token_hash, token);
    assert.ok(!JSON.stringify(rows).includes(token));
  });

  test('a link works once', async () => {
    const { db, admin } = await setup();
    const { token } = await createInvite(db, admin.id, { email: 'once@example.test', displayName: 'Once' });
    await acceptInvite(db, token, NEW_PASSWORD);
    await assert.rejects(() => acceptInvite(db, token, NEW_PASSWORD), code('used'));
    await assert.rejects(() => lookupInvite(db, token), code('used'));
  });

  test('two accepts racing each other create one account, not two', async () => {
    const { db, admin } = await setup();
    const { token } = await createInvite(db, admin.id, { email: 'race@example.test', displayName: 'Race' });
    const results = await Promise.allSettled([acceptInvite(db, token, NEW_PASSWORD), acceptInvite(db, token, NEW_PASSWORD)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const { rows } = await db.query<{ n: number }>(`select count(*)::int n from sp_users where email = 'race@example.test'`);
    assert.equal(rows[0].n, 1);
  });

  test('an expired link is refused', async () => {
    const { db, admin } = await setup();
    const { token } = await createInvite(db, admin.id, { email: 'late@example.test', displayName: 'Late' });
    await db.query(`update sp_invites set expires_at = now() - interval '1 minute'`);
    await assert.rejects(() => lookupInvite(db, token), code('expired'));
    await assert.rejects(() => acceptInvite(db, token, NEW_PASSWORD), code('expired'));
  });

  test('inviting the same address again withdraws the earlier link', async () => {
    const { db, admin } = await setup();
    const first = await createInvite(db, admin.id, { email: 'twice@example.test', displayName: 'Twice' });
    const second = await createInvite(db, admin.id, { email: 'twice@example.test', displayName: 'Twice' });
    await assert.rejects(() => lookupInvite(db, first.token), code('revoked'));
    assert.equal((await lookupInvite(db, second.token)).email, 'twice@example.test');
  });

  test('a withdrawn link is refused, and a used one cannot be withdrawn', async () => {
    const { db, admin } = await setup();
    const a = await createInvite(db, admin.id, { email: 'w@example.test', displayName: 'W' });
    assert.equal(await revokeInvite(db, a.invite.id), true);
    await assert.rejects(() => acceptInvite(db, a.token, NEW_PASSWORD), code('revoked'));

    const b = await createInvite(db, admin.id, { email: 'u@example.test', displayName: 'U' });
    await acceptInvite(db, b.token, NEW_PASSWORD);
    assert.equal(await revokeInvite(db, b.invite.id), false);
  });

  test('an address that already has an account cannot be invited', async () => {
    const { db, admin } = await setup();
    await assert.rejects(
      () => createInvite(db, admin.id, { email: 'ADMIN@example.test', displayName: 'Dup' }),
      code('exists'),
    );
  });

  test('an account created by script after the invite went out blocks the invite', async () => {
    const { db, admin } = await setup();
    const { token } = await createInvite(db, admin.id, { email: 'late.script@example.test', displayName: 'X' });
    await makeUser(db, { email: 'late.script@example.test' });
    await assert.rejects(() => acceptInvite(db, token, NEW_PASSWORD), code('exists'));
  });

  test('a short password is refused and leaves the link usable', async () => {
    const { db, admin } = await setup();
    const { token } = await createInvite(db, admin.id, { email: 'short@example.test', displayName: 'Short' });
    await assert.rejects(() => acceptInvite(db, token, 'short'), code('bad_input'));
    assert.equal((await lookupInvite(db, token)).email, 'short@example.test');
  });

  test('an unknown link and bad input are refused plainly', async () => {
    const { db, admin } = await setup();
    await assert.rejects(() => lookupInvite(db, 'not-a-real-token'), code('invalid'));
    await assert.rejects(() => createInvite(db, admin.id, { email: 'not-an-email', displayName: 'X' }), code('bad_input'));
    await assert.rejects(() => createInvite(db, admin.id, { email: 'ok@example.test', displayName: '  ' }), code('bad_input'));
  });

  test('an admin invite makes an admin, and the list reports status', async () => {
    const { db, admin } = await setup();
    const { token } = await createInvite(db, admin.id, { email: 'boss@example.test', displayName: 'Boss', isAdmin: true });
    const { userId } = await acceptInvite(db, token, NEW_PASSWORD);
    const { rows } = await db.query<{ is_admin: boolean }>(`select is_admin from sp_users where id = $1`, [userId]);
    assert.equal(rows[0].is_admin, true);
    const list = await listInvites(db);
    assert.equal(list[0].status, 'used');
  });
});
