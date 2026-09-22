import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtractionResult, CustomerBlock } from '@safeside/shared';
import { materializeProposal } from './materialize.ts';
import { loadProposalDetail } from './detail.ts';
import { freshDb, makeUser, makeProposal } from '../test-support.ts';
import type { Db } from '../db/index.ts';

/** All client details invented. Carrier names are real public companies. */

function cell(value: string | null, confidence = 0.95) {
  return { value, meta: { found: value !== null, confidence, page: null, note: null } };
}

function customer(over: Partial<Record<string, ReturnType<typeof cell>>> = {}) {
  const blank = cell(null, 0);
  return {
    named_insured: cell('Northgate Bakery LLC'),
    dba: blank, mailing_address: blank, location_address: blank,
    contact_name: blank, contact_phone: blank, contact_email: blank,
    fein: blank, entity_type: blank, business_description: blank,
    effective_date: blank, expiration_date: blank,
    ...over,
  } as unknown as CustomerBlock;
}

function extraction(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return { customer: customer(), lines: [], carrier_names_seen: [], premises: [], notes: [], ...over };
}

async function addExtractedFile(
  db: Db, proposalId: string, userId: string, filename: string, result: ExtractionResult,
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into sp_files (proposal_id, original_filename, storage_path, size_bytes,
                           mime_type, uploaded_by, extraction_status)
     values ($1,$2,$3,1024,'application/pdf',$4,'succeeded') returning id`,
    [proposalId, filename, `${proposalId}/${filename}`, userId],
  );
  await db.query(
    `insert into sp_extractions (file_id, proposal_id, provider, status, parsed)
     values ($1,$2,'fake','succeeded',$3)`,
    [rows[0].id, proposalId, JSON.stringify(result)],
  );
  return rows[0].id;
}

const BOP: ExtractionResult = extraction({
  lines: [{
    line_type: 'business_owners_policy',
    line_type_label: 'Businessowners Policy',
    carrier_name: 'Utica National Insurance Group',
    premium: 604.5,
    premium_components: [{ label: 'Property', amount: 600, is_fee: false },
                         { label: 'NY Fire Fee', amount: 4.5, is_fee: true }],
    details: [
      { kind: 'limit', label: 'Each Occurrence', value: '$1,000,000', confidence: 0.95, section_hint: 'liability' },
      { kind: 'limit', label: 'Building', value: '$30,000', confidence: 0.93, section_hint: 'property' },
      { kind: 'exclusion', label: 'Water Exclusion', value: null, confidence: 0.5, section_hint: 'property' },
    ],
    options: [],
    admitted: 'admitted',
    schedules: {
      classifications: [
        { location: '1', classification: 'Bakeries', class_code: '10100',
          exposure: '250,000', rating_basis: 'Gross Sales' },
      ],
      subjects_of_insurance: [], states: [], employers_liability: [],
      rating_basis: [], individuals: [], note: null,
    },
    confidence: 0.93,
    page_start: 1,
  }],
  premises: [
    { location: '1', address: '1 Example Way', city: 'Springfield', state: 'NY', zip: '10001' },
  ],
  carrier_names_seen: ['Utica National Insurance Group', 'Safeside Insurance Brokerage'],
  notes: ['Packaged policy; components itemised.'],
});

const WC: ExtractionResult = extraction({
  customer: customer({ contact_name: cell('A. Baker', 0.8) }),
  lines: [{
    line_type: 'workers_comp', line_type_label: 'Workers Compensation',
    carrier_name: 'Example Mutual', premium: 254, premium_components: [],
    details: [{ kind: 'limit', label: 'Each Accident', value: '$1,000,000', confidence: 0.95, section_hint: null }],
    options: [], admitted: 'non_admitted',
    schedules: { classifications: [], subjects_of_insurance: [], states: [],
      employers_liability: [], rating_basis: [], individuals: [], note: null },
    confidence: 0.94, page_start: 1,
  }],
  carrier_names_seen: ['Example Mutual'],
  notes: [],
});

describe('materialising extractions into an editable draft', () => {
  let db: Db;
  let userId: string;
  let proposalId: string;

  before(async () => { db = await freshDb({ seed: true }); });
  after(async () => { await db.close(); });

  beforeEach(async () => {
    const user = await makeUser(db);
    userId = user.id;
    proposalId = await makeProposal(db, userId);
  });

  test('two files become two lines, not two proposals', async () => {
    await addExtractedFile(db, proposalId, userId, 'bop.pdf', BOP);
    await addExtractedFile(db, proposalId, userId, 'wc.pdf', WC);

    const result = await materializeProposal(db, proposalId);
    assert.equal(result.created, true);
    assert.equal(result.lineCount, 2);

    const detail = await loadProposalDetail(db, userId, proposalId);
    assert.deepEqual(
      detail.lines.map((l) => l.line_type).sort(),
      ['business_owners_policy', 'workers_comp'],
    );
  });

  test('a BOP is one priced line that prints as two sections', async () => {
    await addExtractedFile(db, proposalId, userId, 'bop.pdf', BOP);
    await materializeProposal(db, proposalId);

    const detail = await loadProposalDetail(db, userId, proposalId);
    const bop = detail.lines.find((l) => l.line_type === 'business_owners_policy')!;
    assert.equal(bop.section_titles.length, 2);
    assert.equal(bop.carrier_premium, 604.5);
  });

  /*
   * The guarantee that keeps extracted and confirmed data apart: once a draft
   * exists, the broker owns it, and re-running extraction must not touch it.
   */
  test('materialising twice does not overwrite the draft', async () => {
    await addExtractedFile(db, proposalId, userId, 'bop.pdf', BOP);
    await materializeProposal(db, proposalId);

    const detail = await loadProposalDetail(db, userId, proposalId);
    await db.query('update sp_lines set broker_fee = 250 where id = $1', [detail.lines[0].id]);

    const second = await materializeProposal(db, proposalId);
    assert.equal(second.created, false);
    assert.match(second.reason ?? '', /already materialised/);

    const after = await loadProposalDetail(db, userId, proposalId);
    assert.equal(after.lines.length, 1, 'no duplicate line was added');
    assert.equal(after.lines[0].broker_fee, 250, "the broker's edit survived");
  });

  test('per-field confidence and absence are carried through for the flags', async () => {
    await addExtractedFile(db, proposalId, userId, 'bop.pdf', BOP);
    await materializeProposal(db, proposalId);

    const detail = await loadProposalDetail(db, userId, proposalId);
    assert.equal(detail.customer.named_insured.found, true);
    assert.equal(detail.customer.fein.found, false, 'an absent field is flagged, not hidden');
    assert.equal(detail.customer.fein.value, null);
  });

  test('carrier names are pooled for the leak guard', async () => {
    await addExtractedFile(db, proposalId, userId, 'bop.pdf', BOP);
    await addExtractedFile(db, proposalId, userId, 'wc.pdf', WC);
    await materializeProposal(db, proposalId);

    const detail = await loadProposalDetail(db, userId, proposalId);
    assert.ok(detail.carrier_names.includes('Utica National Insurance Group'));
    assert.ok(detail.carrier_names.includes('Example Mutual'));
  });

  test('model notes reach the review screen and are attributed to a file', async () => {
    await addExtractedFile(db, proposalId, userId, 'bop.pdf', BOP);
    await materializeProposal(db, proposalId);

    const detail = await loadProposalDetail(db, userId, proposalId);
    assert.equal(detail.notes.length, 1);
    assert.equal(detail.notes[0].filename, 'bop.pdf');
  });

  // Suggested because the coverage is ABSENT — that is the whole mechanism.
  test('recommendations are suggested for coverages not on the proposal', async () => {
    await addExtractedFile(db, proposalId, userId, 'bop.pdf', BOP);
    await materializeProposal(db, proposalId);

    const detail = await loadProposalDetail(db, userId, proposalId);
    const suggested = detail.recommendations.filter((r) => r.suggested);
    assert.ok(suggested.length > 0, 'absent coverages produce suggestions');
    assert.ok(!suggested.some((r) => r.label.toLowerCase().includes('property')),
      'a coverage already on the proposal is not recommended');
  });

  test('the proposal takes its name from the named insured', async () => {
    await addExtractedFile(db, proposalId, userId, 'bop.pdf', BOP);
    await materializeProposal(db, proposalId);

    const detail = await loadProposalDetail(db, userId, proposalId);
    assert.equal(detail.client_name, 'Northgate Bakery LLC');
  });

  test('nothing to materialise is reported, not thrown', async () => {
    const result = await materializeProposal(db, proposalId);
    assert.equal(result.created, false);
    assert.match(result.reason ?? '', /no usable extractions/);
  });

  // A failed file must not sink the rest.
  test('a proposal with one failed file still materialises the others', async () => {
    await addExtractedFile(db, proposalId, userId, 'good.pdf', BOP);
    await db.query(
      `insert into sp_files (proposal_id, original_filename, storage_path, size_bytes,
                             mime_type, uploaded_by, extraction_status, error_text)
       values ($1,'broken.pdf',$2,10,'application/pdf',$3,'failed','could not read')`,
      [proposalId, `${proposalId}/broken.pdf`, userId],
    );

    const result = await materializeProposal(db, proposalId);
    assert.equal(result.created, true);
    assert.equal(result.lineCount, 1);

    const detail = await loadProposalDetail(db, userId, proposalId);
    const failed = detail.files.find((f) => f.extraction_status === 'failed');
    assert.equal(failed?.original_filename, 'broken.pdf', 'the failed file is named');
    assert.match(failed?.error_text ?? '', /could not read/);
  });

  test('two callers materialising at once produce one set of lines, not two', async () => {
    /*
     * The race this pins: the worker materialises the moment the last extraction
     * lands and the review screen can POST /materialize at the same instant.
     * Both used to read zero lines and both inserted, so the proposal carried its
     * coverage twice — and every line's premium is summed into the figure quoted
     * to the client, so the price doubled.
     */
    await addExtractedFile(db, proposalId, userId, 'bop.pdf', BOP);
    await addExtractedFile(db, proposalId, userId, 'wc.pdf', WC);

    const [a, b] = await Promise.all([
      materializeProposal(db, proposalId),
      materializeProposal(db, proposalId),
    ]);

    assert.equal([a, b].filter((r) => r.created).length, 1, 'exactly one call creates');

    const { rows } = await db.query(
      `select line_type, count(*)::int as n from sp_lines
        where proposal_id = $1 group by line_type order by line_type`, [proposalId]);
    assert.deepEqual(rows.map((r) => Number(r.n)), [1, 1], 'one BOP line and one WC line');
  });
});
