/**
 * Seed a demo proposal into the local PGlite database.
 *
 * Offline fixtures only — the fake extraction provider's fictional bakery, never
 * a real client. Lets the review screen be opened with realistic content without
 * an upload, a storage bucket or an API call.
 *
 * The API holds an exclusive lock on the PGlite directory, so stop it first:
 *   pkill -f src/server.ts && node --env-file=.env scripts/seed-demo.ts <email>
 */
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbFromEnv } from '../apps/api/src/db/index.ts';
import { FakeExtractionProvider } from '../apps/api/src/extraction/fake.ts';
import { materializeProposal } from '../apps/api/src/proposals/materialize.ts';

const email = process.argv[2];
if (!email) throw new Error('usage: seed-demo.ts <user email>');

/*
 * createDbFromEnv defaults to './.pglite', which resolves against the CWD — the
 * API runs from apps/api and so uses apps/api/.pglite. A script run from the repo
 * root would otherwise silently create a second, empty database.
 */
process.env.PGLITE_DATA_DIR ??= join(
  dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'api', '.pglite');

const { db } = await createDbFromEnv();
const { rows: users } = await db.query<{ id: string }>(
  `select id from sp_users where email = $1`, [email]);
if (users.length === 0) throw new Error(`no user ${email}`);
const userId = users[0].id;

const { rows: proposals } = await db.query<{ id: string }>(
  `insert into sp_proposals (owner_user_id, client_name) values ($1,$2) returning id`,
  [userId, 'Northgate Bakery LLC (demo)']);
const proposalId = proposals[0].id;

/* The fake provider picks its shape from a hash of the bytes. */
function bytesFor(shape: 'bop' | 'wc' | 'options'): Uint8Array {
  const shapes = ['bop', 'wc', 'options'] as const;
  for (let i = 0; i < 10_000; i += 1) {
    const bytes = new TextEncoder().encode(`seed-${i}`);
    if (shapes[createHash('sha256').update(bytes).digest()[0]! % shapes.length] === shape) return bytes;
  }
  throw new Error(`no seed produced a ${shape} fixture`);
}

const provider = new FakeExtractionProvider();
for (const [name, shape] of [['bop-quote.pdf', 'bop'], ['wc-quote.pdf', 'wc']] as const) {
  const { rows } = await db.query<{ id: string }>(
    `insert into sp_files (proposal_id, original_filename, storage_path, size_bytes,
                           mime_type, uploaded_by, extraction_status)
     values ($1,$2,$3,1024,'application/pdf',$4,'succeeded') returning id`,
    [proposalId, name, `${proposalId}/${name}`, userId]);
  const { result } = await provider.extract({ pdf: bytesFor(shape), filename: name });
  await db.query(
    `insert into sp_extractions (file_id, proposal_id, provider, status, parsed)
     values ($1,$2,'fake','succeeded',$3)`,
    [rows[0].id, proposalId, JSON.stringify(result)]);
}

await materializeProposal(db, proposalId);
await db.query(`update sp_lines set broker_fee = 250 where proposal_id = $1`, [proposalId]);
await db.close();
console.log(`http://localhost:3000/proposals/${proposalId}/review`);
