import { randomBytes } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { hashToken } from './sessions.ts';
import { hashPassword } from './passwords.ts';

/**
 * Invitations.
 *
 * An admin creates one, sends the person the link, and the person chooses their
 * own password. Nothing secret ever has to travel through WhatsApp or email —
 * which is where passwords created by scripts/create-user.mjs ended up living.
 *
 * The rules, all enforced here rather than in the route:
 *
 *   - A link works ONCE. Accepting is a single transaction that locks the row,
 *     so two clicks racing each other cannot create two accounts.
 *   - A link EXPIRES. Long enough that someone who is away for a few days can
 *     still use it; short enough that a link forwarded months later is dead.
 *   - Only ONE live link per address. Inviting someone again withdraws the
 *     earlier link, so "I sent it twice" never leaves two doors open.
 *   - An address that already has an account cannot be invited. That would be a
 *     way to replace someone's password with a link.
 *   - Only the SHA-256 of the token is stored, as with sessions. The plain token
 *     exists once, in the response to the admin who created it.
 */

export const INVITE_TTL_DAYS = 7;
const TOKEN_BYTES = 32;

export type InviteStatus = 'pending' | 'used' | 'expired' | 'revoked';

export type InviteErrorCode = 'invalid' | 'expired' | 'used' | 'revoked' | 'exists' | 'bad_input';

export class InviteError extends Error {
  readonly code: InviteErrorCode;
  constructor(code: InviteErrorCode, message: string) {
    super(message);
    this.name = 'InviteError';
    this.code = code;
  }
}

export interface InviteSummary {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  status: InviteStatus;
}

interface InviteRow {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
  created_at: string | Date;
  expires_at: string | Date;
  used_at: string | Date | null;
  revoked_at: string | Date | null;
}

/** Revoked and used win over expired: they say what actually happened. */
export function inviteStatus(row: Pick<InviteRow, 'expires_at' | 'used_at' | 'revoked_at'>, now = new Date()): InviteStatus {
  if (row.used_at) return 'used';
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

const iso = (d: string | Date | null) => (d === null ? null : new Date(d).toISOString());

function summarise(row: InviteRow, now = new Date()): InviteSummary {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    is_admin: row.is_admin,
    created_at: iso(row.created_at)!,
    expires_at: iso(row.expires_at)!,
    used_at: iso(row.used_at),
    status: inviteStatus(row, now),
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createInvite(
  db: Db,
  createdBy: string,
  input: { email: string; displayName: string; isAdmin?: boolean },
): Promise<{ token: string; invite: InviteSummary }> {
  const email = (input.email ?? '').trim();
  const displayName = (input.displayName ?? '').trim();
  if (!EMAIL.test(email)) throw new InviteError('bad_input', 'Enter a valid email address.');
  if (!displayName) throw new InviteError('bad_input', 'Enter the person’s name.');

  const existing = await db.query(`select 1 from sp_users where email = $1`, [email]);
  if (existing.rows.length > 0) {
    throw new InviteError('exists', 'That email already has an account.');
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url');

  const row = await db.transaction(async (tx) => {
    // One live link per address: a fresh invite withdraws any earlier one.
    await tx.query(
      `update sp_invites set revoked_at = now()
        where email = $1 and used_at is null and revoked_at is null and expires_at > now()`,
      [email],
    );
    const { rows } = await tx.query<InviteRow>(
      `insert into sp_invites (token_hash, email, display_name, is_admin, created_by, expires_at)
       values ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)
       returning id, email, display_name, is_admin, created_at, expires_at, used_at, revoked_at`,
      [hashToken(token), email, displayName, Boolean(input.isAdmin), createdBy, String(INVITE_TTL_DAYS)],
    );
    return rows[0];
  });

  return { token, invite: summarise(row) };
}

// A function, not a table of error objects: a shared instance thrown from
// several places carries one stale stack trace and can be mutated by a catcher.
function statusError(status: Exclude<InviteStatus, 'pending'>): InviteError {
  if (status === 'used') return new InviteError('used', 'This invite has already been used. Sign in instead.');
  if (status === 'revoked') return new InviteError('revoked', 'This invite was withdrawn. Ask for a new one.');
  return new InviteError('expired', 'This invite has expired. Ask for a new one.');
}

/** What the set-password page needs to show, or why the link no longer works. */
export async function lookupInvite(db: Db, token: string): Promise<{ email: string; display_name: string }> {
  const { rows } = await db.query<InviteRow>(
    `select id, email, display_name, is_admin, created_at, expires_at, used_at, revoked_at
       from sp_invites where token_hash = $1`,
    [hashToken(token ?? '')],
  );
  const row = rows[0];
  if (!row) throw new InviteError('invalid', 'This invite link is not valid.');
  const status = inviteStatus(row);
  if (status !== 'pending') throw statusError(status);
  return { email: row.email, display_name: row.display_name };
}

/** Create the account, mark the invite used, and return the new user's id. */
export async function acceptInvite(db: Db, token: string, password: string): Promise<{ userId: string }> {
  if (typeof password !== 'string' || password.length < 12) {
    throw new InviteError('bad_input', 'Choose a password of at least 12 characters.');
  }
  const passwordHash = await hashPassword(password);

  return db.transaction(async (tx) => {
    // Locked, so a double-click or two tabs cannot both get past the checks.
    const { rows } = await tx.query<InviteRow>(
      `select id, email, display_name, is_admin, created_at, expires_at, used_at, revoked_at
         from sp_invites where token_hash = $1 for update`,
      [hashToken(token ?? '')],
    );
    const row = rows[0];
    if (!row) throw new InviteError('invalid', 'This invite link is not valid.');
    const status = inviteStatus(row);
    if (status !== 'pending') throw statusError(status);

    // Checked again inside the transaction: an account may have been created by
    // script for the same address after the invite went out.
    const taken = await tx.query(`select 1 from sp_users where email = $1`, [row.email]);
    if (taken.rows.length > 0) throw new InviteError('exists', 'That email already has an account. Sign in instead.');

    const { rows: users } = await tx.query<{ id: string }>(
      `insert into sp_users (email, password_hash, display_name, is_admin)
       values ($1, $2, $3, $4) returning id`,
      [row.email, passwordHash, row.display_name, row.is_admin],
    );
    const userId = users[0].id;
    await tx.query(`update sp_invites set used_at = now(), used_by = $2 where id = $1`, [row.id, userId]);
    return { userId };
  });
}

export async function listInvites(db: Db, limit = 100): Promise<InviteSummary[]> {
  const { rows } = await db.query<InviteRow>(
    `select id, email, display_name, is_admin, created_at, expires_at, used_at, revoked_at
       from sp_invites order by created_at desc limit $1`,
    [limit],
  );
  const now = new Date();
  return rows.map((r) => summarise(r, now));
}

/** Withdraw a link that has not been used. Returns false if there was nothing to withdraw. */
export async function revokeInvite(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update sp_invites set revoked_at = now()
      where id = $1 and used_at is null and revoked_at is null`,
    [id],
  );
  return rowCount > 0;
}
