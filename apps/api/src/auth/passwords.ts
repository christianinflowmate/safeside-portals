import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id parameters, per OWASP's current password storage guidance:
 * 19 MiB of memory, two iterations, one lane.
 *
 * The memory cost is what makes GPU cracking expensive, and it is the parameter
 * people quietly lower when hashing feels slow. Don't. At this user count —
 * a handful of brokers logging in a few times a day — the cost is irrelevant.
 *
 * These live in the hash string itself, so raising them later does not invalidate
 * existing passwords: old hashes keep verifying with their original parameters and
 * `needsRehash` reports which ones to upgrade on next successful login.
 */
const PARAMS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 12) {
    // Enforced here rather than only at the edge, so no code path can create a
    // weak password by skipping validation.
    throw new Error('Password must be at least 12 characters');
  }
  return hash(plain, PARAMS);
}

/**
 * Always returns a boolean. A malformed or corrupt stored hash is a failed
 * verification, not an exception that a caller might mistake for success.
 */
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

/** True when a hash was made with weaker parameters than we now use. */
export function needsRehash(storedHash: string): boolean {
  const m = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!m) return true;
  const [, mem, time, par] = m.map(Number);
  return mem < PARAMS.memoryCost || time < PARAMS.timeCost || par < PARAMS.parallelism;
}
