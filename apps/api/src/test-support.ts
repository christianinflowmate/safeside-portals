import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgliteDb, type Db } from './db/index.ts';
import { hashPassword } from './auth/passwords.ts';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'supabase', 'migrations');

/**
 * A fresh in-memory Postgres with every migration applied. Each call is isolated,
 * so tests never share state and can run in any order.
 *
 * ALL migrations run, not just the schema ones. An earlier version applied only
 * 001 unless a test opted in, on the theory that seeded copy would make tests
 * brittle — but later migrations mix schema and content (004 both retitles
 * sections and adds a column), so the split silently left tables missing and
 * every test touching them failed at once. Tests simply do not assert on the
 * wording of seeded copy.
 *
 * The `seed` option is kept so existing callers still compile; it has no effect.
 */
export async function freshDb(_options: { seed?: boolean } = {}): Promise<Db> {
  const db = await createPgliteDb();
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

  for (const f of files) {
    await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return db;
}

export async function makeUser(
  db: Db,
  overrides: { email?: string; password?: string; displayName?: string; isActive?: boolean } = {},
): Promise<{ id: string; email: string; password: string }> {
  const email = overrides.email ?? `broker-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = overrides.password ?? 'fixture-password-not-in-use';

  const { rows } = await db.query<{ id: string }>(
    `insert into sp_users (email, password_hash, display_name, is_active)
     values ($1, $2, $3, $4) returning id`,
    [email, await hashPassword(password), overrides.displayName ?? 'Test Broker', overrides.isActive ?? true],
  );
  return { id: rows[0].id, email, password };
}

export async function makeProposal(db: Db, ownerId: string, clientName = 'Northgate Bakery LLC'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into sp_proposals (owner_user_id, client_name) values ($1, $2) returning id`,
    [ownerId, clientName],
  );
  return rows[0].id;
}
