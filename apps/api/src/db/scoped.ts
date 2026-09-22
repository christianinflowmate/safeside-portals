import type { Db } from './index.ts';

/**
 * Ownership enforcement.
 *
 * This is the primary access control in the application, not a convenience. The
 * API connects with the Supabase service role key, which bypasses Row Level
 * Security entirely — the deny-all policies in migration 001 only stop the anon
 * and authenticated keys. Nothing in the database stops one broker reading
 * another's proposal. This file does.
 *
 * The rule: every read or write touching proposal data goes through a function
 * here, and every one of them takes a userId and puts it in the WHERE clause.
 * Adding a route that queries sp_proposals directly is how this gets broken.
 *
 * Child tables are scoped through a join on the proposal rather than trusting an
 * id the client supplied. A request for line X is only served if line X belongs to
 * a proposal owned by the caller — otherwise knowing a UUID would be enough to
 * read someone else's pricing.
 */

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(what = 'Not found') {
    super(what);
    this.name = 'NotFoundError';
  }
}

export interface ProposalRow {
  id: string;
  owner_user_id: string;
  client_name: string;
  status: 'draft' | 'generated';
  recommendations_note: string | null;
  terms_note: string | null;
  /** True once a premium-disclaimer selection has been saved, empty or not. */
  disclaimers_chosen: boolean;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Fetch a proposal the user owns.
 *
 * Throws NotFoundError — never a distinct "forbidden" — when the proposal exists
 * but belongs to someone else. Distinguishing the two would let any logged-in user
 * confirm whether a given proposal id exists, which is an enumeration oracle over
 * the whole table.
 */
export async function getOwnedProposal(
  db: Db,
  userId: string,
  proposalId: string,
): Promise<ProposalRow> {
  const { rows } = await db.query<ProposalRow>(
    `select * from sp_proposals where id = $1 and owner_user_id = $2`,
    [proposalId, userId],
  );
  if (rows.length === 0) throw new NotFoundError('Proposal not found');
  return rows[0];
}

/** Assert ownership without fetching the row. */
export async function assertOwnsProposal(db: Db, userId: string, proposalId: string): Promise<void> {
  const { rows } = await db.query(
    `select 1 from sp_proposals where id = $1 and owner_user_id = $2`,
    [proposalId, userId],
  );
  if (rows.length === 0) throw new NotFoundError('Proposal not found');
}

export async function listOwnedProposals(db: Db, userId: string) {
  const { rows } = await db.query(
    `select p.id,
            p.client_name,
            p.status,
            p.created_at,
            p.updated_at,
            (select count(*) from sp_files f where f.proposal_id = p.id)::int as file_count,
            -- Transient states are derived rather than stored, so the list can show
            -- "Analyzing" and "Extraction failed" without a second source of truth
            -- for status that could drift from sp_files.
            (select count(*) from sp_files f
              where f.proposal_id = p.id and f.extraction_status in ('pending','running'))::int as files_extracting,
            (select count(*) from sp_files f
              where f.proposal_id = p.id and f.extraction_status = 'failed')::int as files_failed,
            (select d.storage_path from sp_documents d
              where d.proposal_id = p.id order by d.generated_at desc limit 1) as latest_document_path
       from sp_proposals p
      where p.owner_user_id = $1
      order by p.created_at desc`,
    [userId],
  );
  return rows;
}

/**
 * Fetch a file, scoped through its proposal. A caller who knows a file id but does
 * not own its proposal gets a 404.
 */
export async function getOwnedFile(db: Db, userId: string, fileId: string) {
  const { rows } = await db.query(
    `select f.*
       from sp_files f
       join sp_proposals p on p.id = f.proposal_id
      where f.id = $1 and p.owner_user_id = $2`,
    [fileId, userId],
  );
  if (rows.length === 0) throw new NotFoundError('File not found');
  return rows[0];
}

export async function getOwnedLine(db: Db, userId: string, lineId: string) {
  const { rows } = await db.query(
    `select l.*
       from sp_lines l
       join sp_proposals p on p.id = l.proposal_id
      where l.id = $1 and p.owner_user_id = $2`,
    [lineId, userId],
  );
  if (rows.length === 0) throw new NotFoundError('Coverage line not found');
  return rows[0];
}

export async function getOwnedDocument(db: Db, userId: string, documentId: string) {
  const { rows } = await db.query(
    `select d.*
       from sp_documents d
       join sp_proposals p on p.id = d.proposal_id
      where d.id = $1 and p.owner_user_id = $2`,
    [documentId, userId],
  );
  if (rows.length === 0) throw new NotFoundError('Document not found');
  return rows[0];
}

/**
 * Update a proposal's own columns, scoped to the owner.
 *
 * Column names are whitelisted rather than interpolated from caller input: this
 * builds SQL by concatenation, and an unchecked key here would be injection.
 */
const PROPOSAL_UPDATABLE = new Set(['client_name', 'recommendations_note', 'terms_note', 'status']);

export async function updateOwnedProposal(
  db: Db,
  userId: string,
  proposalId: string,
  patch: Record<string, unknown>,
): Promise<ProposalRow> {
  const entries = Object.entries(patch).filter(([k]) => PROPOSAL_UPDATABLE.has(k));
  if (entries.length === 0) return getOwnedProposal(db, userId, proposalId);

  const sets = entries.map(([k], i) => `${k} = $${i + 3}`).join(', ');
  const { rows } = await db.query<ProposalRow>(
    `update sp_proposals set ${sets}
      where id = $1 and owner_user_id = $2
      returning *`,
    [proposalId, userId, ...entries.map(([, v]) => v)],
  );
  if (rows.length === 0) throw new NotFoundError('Proposal not found');
  return rows[0];
}
