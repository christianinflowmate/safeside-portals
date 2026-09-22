import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtractionResult, CustomerBlock, CoverageLine, LineType, ProposalDocumentModel, DocumentSection } from '@safeside/shared';
import { assertNoCarrierLeaks, CarrierLeakError, scanForCarrierLeaks } from '@safeside/shared';
import { materializeProposal } from './proposals/materialize.ts';
import { loadProposalDetail } from './proposals/detail.ts';
import { buildDocumentModel } from './documents/build-model.ts';
import { freshDb, makeUser, makeProposal } from './test-support.ts';
import type { Db } from './db/index.ts';

/**
 * The brief's definition of done, as executable checks.
 *
 * These run against the real database, the real merge, the real document
 * projection and the real leak guard. Only the browser is left out — rendering is
 * covered separately; what is asserted here is that the data reaching the
 * template is correct, which is where the rules that matter actually live.
 *
 * Every client detail is invented. Carrier names are real public companies, used
 * because the leak guard's behaviour depends on realistic ones.
 */

function cell(value: string | null, confidence = 0.95) {
  return { value, meta: { found: value !== null, confidence, page: null, note: null } };
}

function customer(over: Record<string, ReturnType<typeof cell>> = {}) {
  const blank = cell(null, 0);
  return {
    named_insured: cell('Northgate Bakery LLC'),
    dba: blank, mailing_address: cell('1 Example Way, Springfield, NY 10001'),
    location_address: blank, contact_name: blank, contact_phone: blank,
    contact_email: blank, fein: blank, entity_type: cell('LLC', 0.55),
    business_description: blank,
    effective_date: cell('2026-10-01'), expiration_date: cell('2027-10-01'),
    ...over,
  } as unknown as CustomerBlock;
}

function line(over: Partial<CoverageLine> & { line_type: LineType }): CoverageLine {
  return {
    line_type_label: null, carrier_name: null, premium: 1000,
    premium_components: [], details: [], options: [],
    admitted: null,
    schedules: { classifications: [], subjects_of_insurance: [], states: [],
      employers_liability: [], rating_basis: [], individuals: [], note: null },
    confidence: 0.9, page_start: null, ...over,
  };
}

function extraction(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return { customer: customer(), lines: [], carrier_names_seen: [], premises: [], notes: [], ...over };
}

async function addFile(db: Db, proposalId: string, userId: string, name: string, result: ExtractionResult) {
  const { rows } = await db.query<{ id: string }>(
    `insert into sp_files (proposal_id, original_filename, storage_path, size_bytes,
                           mime_type, uploaded_by, extraction_status)
     values ($1,$2,$3,1024,'application/pdf',$4,'succeeded') returning id`,
    [proposalId, name, `${proposalId}/${name}`, userId],
  );
  await db.query(
    `insert into sp_extractions (file_id, proposal_id, provider, status, parsed)
     values ($1,$2,'fake','succeeded',$3)`,
    [rows[0].id, proposalId, JSON.stringify(result)],
  );
  return rows[0].id;
}

describe('definition of done', () => {
  let db: Db;
  let userId: string;
  let proposalId: string;

  before(async () => { db = await freshDb({ seed: true }); });
  after(async () => { await db.close(); });

  beforeEach(async () => {
    userId = (await makeUser(db)).id;
    proposalId = await makeProposal(db, userId);
  });

  test('a combined PDF holding several quotes extracts into separate lines', async () => {
    await addFile(db, proposalId, userId, 'combined.pdf', extraction({
      lines: [
        line({ line_type: 'general_liability', premium: 2400 }),
        line({ line_type: 'workers_comp', premium: 254 }),
        line({ line_type: 'commercial_auto', premium: 1800 }),
      ],
    }));
    await materializeProposal(db, proposalId);

    const detail = await loadProposalDetail(db, userId, proposalId);
    assert.equal(detail.lines.length, 3);
  });

  test('several files for one client merge without duplicating lines', async () => {
    await addFile(db, proposalId, userId, 'a.pdf', extraction({
      lines: [line({ line_type: 'general_liability', premium: 2400, carrier_name: 'Utica National' })],
    }));
    await addFile(db, proposalId, userId, 'b.pdf', extraction({
      lines: [line({ line_type: 'general_liability', premium: 2650, carrier_name: 'AmTrust' })],
    }));
    await materializeProposal(db, proposalId);

    const detail = await loadProposalDetail(db, userId, proposalId);
    assert.equal(detail.lines.length, 1, 'one line, not two');
  });

  test('a line quoted two ways surfaces both and blocks until one is chosen', async () => {
    await addFile(db, proposalId, userId, 'options.pdf', extraction({
      lines: [line({
        line_type: 'general_liability', premium: null,
        options: [
          { label: '$1M / $2M', premium: 2400, premium_components: [], details: [] },
          { label: '$2M / $4M', premium: 3100, premium_components: [], details: [] },
        ],
      })],
    }));
    await materializeProposal(db, proposalId);

    let detail = await loadProposalDetail(db, userId, proposalId);
    assert.equal(detail.lines[0].options.length, 2, 'both versions are surfaced');
    assert.ok(
      detail.blocking_reasons.some((r) => /choose one of 2/i.test(r)),
      'generation is blocked with a readable reason',
    );

    // Choosing one unblocks it and sets the price.
    await db.query('update sp_lines set selected_option_id = $2 where id = $1',
      [detail.lines[0].id, detail.lines[0].options[1].id]);

    detail = await loadProposalDetail(db, userId, proposalId);
    assert.equal(detail.lines[0].carrier_premium, 3100);
    assert.deepEqual(detail.blocking_reasons, []);
  });

  test('extracted fields are editable and the edit persists', async () => {
    await addFile(db, proposalId, userId, 'a.pdf', extraction({
      lines: [line({ line_type: 'workers_comp', premium: 254 })],
    }));
    await materializeProposal(db, proposalId);

    await db.query(
      `update sp_customers set contact_name = 'A. Baker',
         field_meta = jsonb_set(coalesce(field_meta,'{}'::jsonb), '{contact_name}',
           '{"edited":true,"found":true,"confidence":1,"conflicts":[]}'::jsonb, true)
       where proposal_id = $1`, [proposalId]);

    const detail = await loadProposalDetail(db, userId, proposalId);
    assert.equal(detail.customer.contact_name.value, 'A. Baker');
    assert.equal(detail.customer.contact_name.edited, true);
  });

  test('fields the AI could not find are flagged, not silently blank', async () => {
    await addFile(db, proposalId, userId, 'a.pdf', extraction({
      lines: [line({ line_type: 'workers_comp', premium: 254 })],
    }));
    await materializeProposal(db, proposalId);

    const detail = await loadProposalDetail(db, userId, proposalId);
    assert.equal(detail.customer.fein.found, false);
    assert.equal(detail.customer.entity_type.found, true);
    assert.ok(detail.customer.entity_type.confidence < 0.7, 'low confidence is visible');
  });

  test('broker fee is per line and the displayed price is combined', async () => {
    await addFile(db, proposalId, userId, 'a.pdf', extraction({
      lines: [
        line({ line_type: 'general_liability', premium: 2400 }),
        line({ line_type: 'workers_comp', premium: 254 }),
      ],
    }));
    await materializeProposal(db, proposalId);

    let detail = await loadProposalDetail(db, userId, proposalId);
    for (const l of detail.lines) {
      await db.query('update sp_lines set broker_fee = 150 where id = $1', [l.id]);
    }

    detail = await loadProposalDetail(db, userId, proposalId);
    const gl = detail.lines.find((l) => l.line_type === 'general_liability')!;
    assert.equal(gl.combined_price, 2550);
    assert.equal(detail.totals.combined, 2400 + 254 + 300);
  });

  test('excluding a line takes it out of the total', async () => {
    await addFile(db, proposalId, userId, 'a.pdf', extraction({
      lines: [
        line({ line_type: 'general_liability', premium: 2400 }),
        line({ line_type: 'workers_comp', premium: 254 }),
      ],
    }));
    await materializeProposal(db, proposalId);

    let detail = await loadProposalDetail(db, userId, proposalId);
    const wc = detail.lines.find((l) => l.line_type === 'workers_comp')!;
    await db.query('update sp_lines set included = false where id = $1', [wc.id]);

    detail = await loadProposalDetail(db, userId, proposalId);
    assert.equal(detail.totals.combined, 2400);
  });

  test('generation is blocked, with a reason, while a premium is missing', async () => {
    await addFile(db, proposalId, userId, 'a.pdf', extraction({
      lines: [line({ line_type: 'workers_comp', premium: null })],
    }));
    await materializeProposal(db, proposalId);

    const detail = await loadProposalDetail(db, userId, proposalId);
    assert.ok(detail.blocking_reasons.some((r) => /no premium was found/i.test(r)));
  });

  describe('the document a client receives', () => {
    async function buildDoc() {
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [
          line({
            line_type: 'business_owners_policy', premium: 604.5,
            carrier_name: 'Utica National Insurance Group',
            premium_components: [{ label: 'Property', amount: 604.5, is_fee: false }],
            details: [
              { kind: 'limit', label: 'Each Occurrence', value: '$1,000,000', confidence: 0.95, section_hint: 'liability' },
              { kind: 'limit', label: 'Building', value: '$30,000', confidence: 0.9, section_hint: 'property' },
              { kind: 'endorsement', label: 'Equipment Breakdown', value: 'Included', confidence: 0.9, section_hint: 'property' },
            ],
          }),
          line({ line_type: 'workers_comp', premium: 254, carrier_name: 'Example Mutual' }),
        ],
        carrier_names_seen: ['Utica National Insurance Group', 'Example Mutual', 'Safeside Insurance Brokerage'],
      }));
      await materializeProposal(db, proposalId);

      let detail = await loadProposalDetail(db, userId, proposalId);
      for (const l of detail.lines) {
        await db.query('update sp_lines set broker_fee = 150 where id = $1', [l.id]);
      }
      detail = await loadProposalDetail(db, userId, proposalId);
      return { detail, model: await buildDocumentModel(db, detail) };
    }

    test('a packaged line prints as two sections but one priced row', async () => {
      const { model } = await buildDoc();
      assert.equal(model.priced_lines.length, 2, 'BOP and WC');
      assert.equal(model.sections.length, 3, 'GL + Property + WC');
      // Titles come from sp_line_types and carry Safeside's "Business" prefix.
      assert.deepEqual(
        model.sections.map((s) => s.section_title).sort(),
        [
          'Business General Liability Coverage',
          'Business Property Coverage',
          'Business Workers Compensation Coverage',
        ],
      );
    });

    test('prices are combined, and appear only in the pricing table', async () => {
      const { model } = await buildDoc();
      const bop = model.priced_lines.find((l) => /Business Owner/i.test(l.label))!;
      assert.equal(bop.price, 754.5, 'carrier premium plus broker fee');
      assert.equal(model.total, 604.5 + 254 + 300);

      // There is no field on a section that could hold a price.
      for (const section of model.sections) {
        assert.ok(!('price' in section));
      }
    });

    // The hard rule, asserted against the actual projection.
    test('no carrier information survives into the document', async () => {
      const { model } = await buildDoc();
      const serialised = JSON.stringify(model);

      for (const term of ['Utica', 'Example Mutual', 'carrier_name', 'broker_fee', 'carrier_premium']) {
        assert.ok(!serialised.includes(term), `"${term}" must not reach the document`);
      }
      // The split is gone; only the combined figure remains.
      assert.ok(!serialised.includes('604.5'), 'the carrier premium alone is absent');
      assert.ok(serialised.includes('754.5'), 'the combined figure is present');
    });

    test('the leak guard passes a clean document', async () => {
      const { detail, model } = await buildDoc();
      assert.doesNotThrow(() =>
        assertNoCarrierLeaks(model, { carrierNames: detail.carrier_names }));
    });

    // A carrier name inside an endorsement title is the leak a whitelist misses.
    test('the leak guard fails closed on a carrier named inside a limit label', async () => {
      const { detail, model } = await buildDoc();
      model.sections[0].endorsements.push({
        label: 'Utica National Insurance Group Amendatory Endorsement', value: 'Included',
      });

      assert.throws(
        () => assertNoCarrierLeaks(model, { carrierNames: detail.carrier_names }),
        (err: unknown) => {
          assert.ok(err instanceof CarrierLeakError);
          assert.match(err.findings[0].path, /sections\[0\]\.endorsements/);
          return true;
        },
      );
    });

    test("the brokerage's own name is not treated as a leak", async () => {
      const { detail, model } = await buildDoc();
      model.terms_note = 'Placed by Safeside Insurance Brokerage.';
      assert.deepEqual(scanForCarrierLeaks(model, { carrierNames: detail.carrier_names }), []);
    });

    test('changing a fee and rebuilding produces a different total', async () => {
      const { detail } = await buildDoc();
      await db.query('update sp_lines set broker_fee = 275 where id = $1', [detail.lines[0].id]);

      const updated = await loadProposalDetail(db, userId, proposalId);
      const model = await buildDocumentModel(db, updated);
      assert.notEqual(model.total, 604.5 + 254 + 300);
      assert.equal(model.total, updated.totals.combined);
    });

    test('an excluded line is absent from the document entirely', async () => {
      const { detail } = await buildDoc();
      const wc = detail.lines.find((l) => l.line_type === 'workers_comp')!;
      await db.query('update sp_lines set included = false where id = $1', [wc.id]);

      const updated = await loadProposalDetail(db, userId, proposalId);
      const model = await buildDocumentModel(db, updated);
      assert.equal(model.priced_lines.length, 1);
      assert.ok(!model.sections.some((s) => /Workers/.test(s.section_title)));
    });

    test('the premium heading names the lines quoted', async () => {
      const { model } = await buildDoc();
      assert.equal(model.premium_page_title, 'BOP/WC Premium and Subjectivities Prior to Binding');
    });

    test('excluding a line takes it out of the premium heading too', async () => {
      const { detail } = await buildDoc();
      const wc = detail.lines.find((l) => l.line_type === 'workers_comp')!;
      await db.query('update sp_lines set included = false where id = $1', [wc.id]);

      const model = await buildDocumentModel(db, await loadProposalDetail(db, userId, proposalId));
      assert.equal(model.premium_page_title, 'BOP Premium and Subjectivities Prior to Binding');
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('the premium page', () => {
    async function withAdmitted(values: Array<string | null>) {
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [
          line({ line_type: 'business_owners_policy', premium: 1000, admitted: values[0] as never }),
          line({ line_type: 'workers_comp', premium: 500, admitted: values[1] as never }),
        ],
      }));
      await materializeProposal(db, proposalId);
      return buildDocumentModel(db, await loadProposalDetail(db, userId, proposalId));
    }

    test('admitted status carries through as the words the table prints', async () => {
      const model = await withAdmitted(['admitted', 'non_admitted']);
      assert.deepEqual(
        model.priced_lines.map((l) => l.admitted),
        ['Admitted', 'Non Admitted'],
      );
    });

    test('a quote that never said so leaves the status null, not guessed', async () => {
      // The template drops the whole column when every row is null. Inventing
      // "Admitted" would be a claim about guaranty-fund protection nobody made.
      const model = await withAdmitted([null, null]);
      assert.deepEqual(model.priced_lines.map((l) => l.admitted), [null, null]);
    });

    test('disclaimers default to the library default until a selection is saved', async () => {
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [line({ line_type: 'workers_comp', premium: 500 })],
      }));
      await materializeProposal(db, proposalId);

      const model = await buildDocumentModel(db, await loadProposalDetail(db, userId, proposalId));
      assert.deepEqual(model.premium_disclaimers,
        ['Minimum Deposit applies if the policy is rated by payroll or sales']);
    });

    test('a saved selection replaces the default', async () => {
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [line({ line_type: 'workers_comp', premium: 500 })],
      }));
      await materializeProposal(db, proposalId);

      const { rows } = await db.query<{ id: string }>(
        `select id from sp_premium_disclaimers where label = 'Payroll audit'`);
      await db.query(
        `insert into sp_proposal_disclaimers (proposal_id, disclaimer_id) values ($1,$2)`,
        [proposalId, rows[0].id]);
      await db.query(`update sp_proposals set disclaimers_chosen = true where id = $1`, [proposalId]);

      const model = await buildDocumentModel(db, await loadProposalDetail(db, userId, proposalId));
      assert.equal(model.premium_disclaimers.length, 1);
      assert.match(model.premium_disclaimers[0], /audited at policy expiration/);
    });

    test('unticking every disclaimer means none, not the default back', async () => {
      // Row count cannot tell "not yet chosen" from "chose none". Without the flag
      // the default silently returns on the next load, and into the document.
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [line({ line_type: 'workers_comp', premium: 500 })],
      }));
      await materializeProposal(db, proposalId);
      await db.query(`update sp_proposals set disclaimers_chosen = true where id = $1`, [proposalId]);

      const model = await buildDocumentModel(db, await loadProposalDetail(db, userId, proposalId));
      assert.deepEqual(model.premium_disclaimers, []);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('the schedules', () => {
    const sched = (over = {}) => ({
      classifications: [], subjects_of_insurance: [], states: [],
      employers_liability: [], rating_basis: [], individuals: [], note: null, ...over,
    });
    const find = (m: ProposalDocumentModel, re: RegExp) =>
      m.sections.find((x) => re.test(x.section_title))!;
    const captions = (s: DocumentSection) => s.tables.map((t) => t.caption);

    test('premise information prints on the property page, not a page of its own', async () => {
      // It has a page to itself in none of Safeside's eleven proposals.
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [line({ line_type: 'business_owners_policy', premium: 1000, details: [
          { kind: 'limit', label: 'Building', value: '$30,000', confidence: 0.9, section_hint: 'property' },
        ] })],
        premises: [{ location: '1', address: '1 Example Way', city: 'Springfield', state: 'NY', zip: '10001' }],
      }));
      await materializeProposal(db, proposalId);

      const model = await buildDocumentModel(db, await loadProposalDetail(db, userId, proposalId));
      assert.ok(!model.sections.some((x) => /^Premise Information$/.test(x.section_title)));
      assert.ok(captions(find(model, /Property/)).includes('Premise Information'));
    });

    test('liability classification prints on the general liability page', async () => {
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [line({
          line_type: 'business_owners_policy', premium: 1000,
          details: [{ kind: 'limit', label: 'Each Occurrence', value: '$1,000,000', confidence: 0.9, section_hint: 'liability' }],
          schedules: sched({ classifications: [{
            location: '1', classification: 'Accounting Services', class_code: '65121',
            exposure: '$350,000', rating_basis: 'Sales' }] }),
        })],
      }));
      await materializeProposal(db, proposalId);

      const model = await buildDocumentModel(db, await loadProposalDetail(db, userId, proposalId));
      assert.deepEqual(captions(find(model, /General Liability/)), ['Liability Classification']);
    });

    test('a workers comp page carries all four of its tables, States first', async () => {
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [line({
          line_type: 'workers_comp', premium: 500,
          schedules: sched({
            states: ['NY'],
            employers_liability: [{ coverage: 'Increased Employers Liability', limit: '$1,000,000',
              disease_policy_limit: '$1,000,000', disease_each_employee: '$1,000,000' }],
            rating_basis: [{ location: '1', state: 'NY', class_code: '8810',
              description: 'Clerical Office Employees', exposure: '$45,500', basis: 'Payroll' }],
            individuals: [{ name: 'A. Baker', title: 'Owner', status: 'Excluded' }],
          }),
        })],
      }));
      await materializeProposal(db, proposalId);

      const model = await buildDocumentModel(db, await loadProposalDetail(db, userId, proposalId));
      assert.deepEqual(captions(find(model, /Workers/)), [
        'States', 'Employers Liability', 'Workers Comp Rating Basis', 'Individuals Included/Excluded',
      ]);
    });

    test('a structured schedule replaces the plain limits list it duplicates', async () => {
      // Subjects of Insurance states the property limits. Printing the list too
      // would show a client the same figures twice in two shapes.
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [line({
          line_type: 'business_owners_policy', premium: 1000,
          details: [{ kind: 'limit', label: 'Business Personal Property', value: '$30,000', confidence: 0.9, section_hint: 'property' }],
          schedules: sched({ subjects_of_insurance: [{
            location: '1', building: '1', subject: 'Business Personal Property', limit: '$30,000',
            coinsurance: '80%', valuation: 'Replacement Cost', cause_of_loss: 'Special Form',
            deductible: '$1,000' }] }),
        })],
      }));
      await materializeProposal(db, proposalId);

      const model = await buildDocumentModel(db, await loadProposalDetail(db, userId, proposalId));
      const property = find(model, /Property/);
      assert.equal(property.limits.length, 0);
      assert.equal(property.deductibles.length, 0, 'the deductible is a column of that table');
      assert.ok(captions(property).includes('Subjects of Insurance'));
    });

    test('each coverage page captions its limits the way Safeside does', async () => {
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [
          line({ line_type: 'business_owners_policy', premium: 1000, details: [
            { kind: 'limit', label: 'Each Occurrence', value: '$1,000,000', confidence: 0.9, section_hint: 'liability' },
            { kind: 'limit', label: 'Building', value: '$30,000', confidence: 0.9, section_hint: 'property' },
          ] }),
          line({ line_type: 'workers_comp', premium: 500, details: [
            { kind: 'limit', label: 'Each Accident', value: '$1,000,000', confidence: 0.9, section_hint: null },
          ] }),
        ],
      }));
      await materializeProposal(db, proposalId);

      const model = await buildDocumentModel(db, await loadProposalDetail(db, userId, proposalId));
      assert.equal(find(model, /General Liability/).limits_caption, 'Limits of Liability Table');
      assert.equal(find(model, /Workers/).limits_caption, 'Employers Liability');
      // Not "Limits of Liability Table", which is what a property page used to say.
      assert.equal(find(model, /Property/).limits_caption, 'Limits of Insurance');
    });

    test('a carrier name hidden in a schedule is still caught', async () => {
      // The leak guard walks the whole model, so a field added upstream is scanned
      // without anyone remembering to add it to a list.
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [line({
          line_type: 'business_owners_policy', premium: 1000,
          carrier_name: 'Utica National Insurance Group',
          details: [{ kind: 'limit', label: 'Each Occurrence', value: '$1,000,000', confidence: 0.9, section_hint: 'liability' }],
          schedules: sched({ classifications: [{
            location: '1', classification: 'Utica National Insurance Group Bakery Program',
            class_code: '10100', exposure: '$250,000', rating_basis: 'Sales' }] }),
        })],
        carrier_names_seen: ['Utica National Insurance Group'],
      }));
      await materializeProposal(db, proposalId);

      const detail = await loadProposalDetail(db, userId, proposalId);
      const findings = scanForCarrierLeaks(await buildDocumentModel(db, detail),
        { carrierNames: detail.carrier_names });
      assert.equal(findings.length, 1);
      assert.match(findings[0].path, /tables/);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('the forms page', () => {
    test('a coverage the client declined is not listed as though they have it', async () => {
      /*
       * Carrier schedules list what was bought AND what was offered and declined,
       * the latter marked "Coverage not Selected". On a real quote that was 22 of
       * 61 rows. Under a heading reading "Forms, Endorsements, Exclusions" it
       * tells a client they have Hired Auto and Garagekeepers when they bought
       * neither, and Safeside's own proposals list none of them.
       */
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [line({
          line_type: 'business_owners_policy', premium: 1000,
          details: [
            { kind: 'endorsement', label: 'Equipment Breakdown', value: 'Included', confidence: 0.9, section_hint: 'property' },
            { kind: 'endorsement', label: 'Hired Auto', value: 'Coverage not Selected', confidence: 0.9, section_hint: null },
            { kind: 'endorsement', label: 'Garagekeepers Coverage', value: 'Coverage Not Selected', confidence: 0.9, section_hint: null },
            { kind: 'exclusion', label: 'Water Exclusion', value: null, confidence: 0.9, section_hint: 'property' },
          ],
        })],
      }));
      await materializeProposal(db, proposalId);

      const model = await buildDocumentModel(db, await loadProposalDetail(db, userId, proposalId));
      const listed = model.forms_and_exclusions.flatMap((g) => g.items);
      assert.deepEqual(listed, ['Equipment Breakdown', 'Water Exclusion']);
    });

    test('forms are grouped under the policy they belong to', async () => {
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [
          line({ line_type: 'business_owners_policy', premium: 1000, details: [
            { kind: 'exclusion', label: 'Water Exclusion', value: null, confidence: 0.9, section_hint: 'property' },
          ] }),
          line({ line_type: 'workers_comp', premium: 500, details: [
            { kind: 'endorsement', label: 'Waiver of Subrogation', value: 'Included', confidence: 0.9, section_hint: null },
          ] }),
        ],
      }));
      await materializeProposal(db, proposalId);

      const model = await buildDocumentModel(db, await loadProposalDetail(db, userId, proposalId));
      assert.deepEqual(model.forms_and_exclusions, [
        { group: 'Businessowners Policy', items: ['Water Exclusion'] },
        { group: 'Workers Compensation', items: ['Waiver of Subrogation'] },
      ]);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('details reaching the client document', () => {
    test('a property deductible is not lost between review and the document', async () => {
      /*
       * The regression this pins: section_hint was extracted, never stored, and
       * read back as null. The keyword classifier cannot place "Property
       * Deductible", so it went to the first section — general liability — failed
       * that page's headline filter and vanished. The broker saw it on review and
       * the client's proposal did not have it.
       */
      await addFile(db, proposalId, userId, 'a.pdf', extraction({
        lines: [line({
          line_type: 'business_owners_policy', premium: 1000,
          details: [
            { kind: 'limit', label: 'Each Occurrence', value: '$1,000,000', confidence: 0.95, section_hint: 'liability' },
            { kind: 'deductible', label: 'Property Deductible', value: '$1,000', confidence: 0.95, section_hint: 'property' },
          ],
        })],
      }));
      await materializeProposal(db, proposalId);

      const detail = await loadProposalDetail(db, userId, proposalId);
      const d = detail.lines[0].details.find((x) => x.label === 'Property Deductible')!;
      assert.equal(d.section_hint, 'property', 'the hint survives the database');

      const model = await buildDocumentModel(db, detail);
      const property = model.sections.find((s) => /Property/.test(s.section_title))!;
      assert.deepEqual(property.deductibles.map((x) => x.label), ['Property Deductible']);
    });
  });
});
