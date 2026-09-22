import type { Db } from '../db/index.ts';

/**
 * Sign-in rate limiting.
 *
 * Two independent limits, because they stop different attacks:
 *
 *   - per email, which stops a password list being run against one broker
 *   - per IP, which stops one host working through many addresses
 *
 * Both count only FAILURES, and both are windowed rather than cumulative — a
 * broker who mistypes their password five times in the morning should not be
 * locked out that afternoon.
 *
 * A successful sign-in clears that address's failures, so the ordinary "got it
 * on the fourth try" case leaves nothing behind.
 */

export const EMAIL_LIMIT = 8;
export const IP_LIMIT = 30;
export const WINDOW_MINUTES = 15;

export interface RateLimitResult {
  allowed: boolean;
  /** Which limit tripped, for the log. Never told to the caller. */
  reason?: 'email' | 'ip';
  /** Seconds until the oldest counted failure falls out of the window. */
  retryAfterSeconds: number;
}

export async function checkLoginRateLimit(
  db: Db,
  email: string,
  ip: string | null,
): Promise<RateLimitResult> {
  const { rows } = await db.query<{ email_failures: number; ip_failures: number; oldest: Date | null }>(
    `select
       count(*) filter (where email = $1)::int as email_failures,
       count(*) filter (where $2::inet is not null and ip = $2::inet)::int as ip_failures,
       min(created_at) as oldest
     from sp_login_attempts
     where not succeeded
       and created_at > now() - ($3 || ' minutes')::interval
       and (email = $1 or ($2::inet is not null and ip = $2::inet))`,
    [email.trim(), ip, String(WINDOW_MINUTES)],
  );

  const { email_failures, ip_failures, oldest } = rows[0];

  const retryAfterSeconds = oldest
    ? Math.max(1, Math.ceil((new Date(oldest).getTime() + WINDOW_MINUTES * 60_000 - Date.now()) / 1000))
    : WINDOW_MINUTES * 60;

  if (email_failures >= EMAIL_LIMIT) return { allowed: false, reason: 'email', retryAfterSeconds };
  if (ip_failures >= IP_LIMIT) return { allowed: false, reason: 'ip', retryAfterSeconds };

  return { allowed: true, retryAfterSeconds: 0 };
}

export async function recordLoginAttempt(
  db: Db,
  email: string,
  ip: string | null,
  succeeded: boolean,
): Promise<void> {
  await db.query(
    `insert into sp_login_attempts (email, ip, succeeded) values ($1, $2, $3)`,
    [email.trim(), ip, succeeded],
  );

  // A success clears the slate for that address, so an ordinary fumbled login
  // leaves no residue that could lock the broker out later.
  if (succeeded) {
    await db.query(
      `delete from sp_login_attempts where email = $1 and not succeeded`,
      [email.trim()],
    );
  }
}

/** Housekeeping. Safe to run on a timer alongside session pruning. */
export async function pruneLoginAttempts(db: Db, olderThanHours = 24): Promise<number> {
  const { rowCount } = await db.query(
    `delete from sp_login_attempts where created_at < now() - ($1 || ' hours')::interval`,
    [String(olderThanHours)],
  );
  return rowCount;
}
