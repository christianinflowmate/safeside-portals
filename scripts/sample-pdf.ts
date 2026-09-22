/**
 * Generate a sample proposal PDF from the offline fixtures.
 *
 * No network, no real client data: the fake extraction provider's fictional
 * bakery. Used to eyeball the template after a change, which is the only way to
 * catch a layout regression that every assertion still passes.
 *
 *   node scripts/sample-pdf.ts [out.pdf]
 */
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { freshDb, makeUser, makeProposal } from '../apps/api/src/test-support.ts';
import { FakeExtractionProvider } from '../apps/api/src/extraction/fake.ts';
import { materializeProposal } from '../apps/api/src/proposals/materialize.ts';
import { loadProposalDetail } from '../apps/api/src/proposals/detail.ts';
import { buildDocumentModel } from '../apps/api/src/documents/build-model.ts';
import { renderProposalPdf } from '../apps/api/src/documents/render.ts';

const out = process.argv[2] ?? 'sample-proposal.pdf';

const db = await freshDb({ seed: true });
const user = await makeUser(db, { email: 'sample@example.test' });
const userId = user.id;
const proposalId = await makeProposal(db, userId);

/*
 * The fake provider picks its shape from a hash of the bytes, so the bytes are
 * searched for rather than chosen — this is the only way to ask it for a BOP and
 * a WC specifically without teaching the fixture about this script.
 */
function bytesFor(shape: 'bop' | 'wc' | 'options'): Uint8Array {
  const shapes = ['bop', 'wc', 'options'] as const;
  for (let i = 0; i < 10_000; i += 1) {
    const bytes = new TextEncoder().encode(`seed-${i}`);
    const digest = createHash('sha256').update(bytes).digest();
    if (shapes[digest[0]! % shapes.length] === shape) return bytes;
  }
  throw new Error(`no seed produced a ${shape} fixture`);
}

const provider = new FakeExtractionProvider();
for (const [name, shape] of [['bop-quote.pdf', 'bop'], ['wc-quote.pdf', 'wc']] as const) {
  const { rows } = await db.query<{ id: string }>(
    `insert into sp_files (proposal_id, original_filename, storage_path, size_bytes,
                           mime_type, uploaded_by, extraction_status)
     values ($1,$2,$3,1024,'application/pdf',$4,'succeeded') returning id`,
    [proposalId, name, `${proposalId}/${name}`, userId],
  );
  const { result } = await provider.extract({ pdf: bytesFor(shape), filename: name });
  await db.query(
    `insert into sp_extractions (file_id, proposal_id, provider, status, parsed)
     values ($1,$2,'fake','succeeded',$3)`,
    [rows[0].id, proposalId, JSON.stringify(result)],
  );
}

await materializeProposal(db, proposalId);
await db.query(`update sp_lines set broker_fee = 250 where proposal_id = $1`, [proposalId]);

// Tick a couple of disclaimers, as a broker would on the review screen.
const { rows: discs } = await db.query<{ id: string }>(
  `select id from sp_premium_disclaimers where label in ('Minimum Deposit','Payroll audit')`,
);
let order = 0;
for (const d of discs) {
  order += 10;
  await db.query(
    `insert into sp_proposal_disclaimers (proposal_id, disclaimer_id, display_order) values ($1,$2,$3)`,
    [proposalId, d.id, order],
  );
}
// What PUT /proposals/:id/disclaimers does. Without it these rows are ignored and
// the library default applies instead — see migration 008.
await db.query(`update sp_proposals set disclaimers_chosen = true where id = $1`, [proposalId]);

const detail = await loadProposalDetail(db, userId, proposalId);
const model = await buildDocumentModel(db, detail);
const { bytes, pageCount } = await renderProposalPdf(model, { carrierNames: detail.carrier_names });

await writeFile(out, bytes);
await db.close();
console.log(`${out} — ${pageCount} pages`);
console.log(`  title:        ${model.premium_page_title}`);
console.log(`  admitted:     ${model.priced_lines.map((l) => `${l.label}=${l.admitted}`).join(', ')}`);
console.log(`  disclaimers:  ${model.premium_disclaimers.length}`);
for (const s of model.sections) {
  console.log(`  ${s.section_title.padEnd(38)} ${s.limits.length} limits, ` +
    `tables: ${s.tables.map((t) => t.caption).join(', ') || 'none'}`);
}
