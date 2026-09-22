import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.ts';

/**
 * Server-side sessions.
 *
 * The cookie carries an opaque 256-bit random token. Only its SHA-256 is stored,
 * so a database leak does not hand an attacker live sessions — the same reasoning
 * as not storing passwords in plaintext. SHA-256 rather than Argon2 is correct
 * here: the token is already high-entropy random, so there is nothing to brute
 * force, and session lookup happens on every request.
 */

const TOKEN_BYTES = 32;
export const SESSION_COOKIE = 'sp_session';

export interface SessionUser {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function ttlHours(): number {
  const raw = Number(process.env.SESSION_TTL_HOURS ?? 12);
  return Number.isFinite(raw) && raw > 0 ? raw : 12;
}

export async function createSession(
  db: Db,
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours() * 3600_000);

  await db.query(
    `insert into sp_sessions (user_id, token_hash, expires_at, user_agent, ip)
     values ($1, $2, $3, $4, $5)`,
    [userId, hashToken(token), expiresAt, meta.userAgent ?? null, meta.ip ?? null],
  );

  return { token, expiresAt };
}

/**
 * Resolve a cookie token to a user, or null.
 *
 * Expiry is checked in SQL rather than in JS so an expired row can never be
 * treated as live because of a clock or timezone mistake in application code.
 * An inactive user's sessions stop resolving immediately, without needing to be
 * deleted when the account is disabled.
 */
export async function resolveSession(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;

  const { rows } = await db.query<SessionUser & { session_id: string }>(
    `select s.id as session_id, u.id, u.email, u.display_name, u.is_admin
       from sp_sessions s
       join sp_users u on u.id = s.user_id
      where s.token_hash = $1
        and s.expires_at > now()
        and u.is_active = true`,
    [hashToken(token)],
  );

  if (rows.length === 0) return null;
  const { session_id, ...user } = rows[0];

  // Touch last_seen_at without awaiting — it is telemetry, and a write failure
  // here must not fail an otherwise valid request.
  void db.query('update sp_sessions set last_seen_at = now() where id = $1', [session_id])
    .catch(() => {});

  return user;
}

export async function destroySession(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.query('delete from sp_sessions where token_hash = $1', [hashToken(token)]);
}

/** Drop every session for a user — used when disabling an account. */
export async function destroyAllSessions(db: Db, userId: string): Promise<void> {
  await db.query('delete from sp_sessions where user_id = $1', [userId]);
}

/** Housekeeping: remove expired rows. Safe to run on a timer. */
export async function pruneExpiredSessions(db: Db): Promise<number> {
  const { rowCount } = await db.query('delete from sp_sessions where expires_at <= now()');
  return rowCount;
}

/**
 * Constant-time string comparison, for any place a secret is compared outside the
 * database. `===` short-circuits on the first differing byte and leaks length and
 * prefix information through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function cookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  };
}
