import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scanForCarrierLeaks, assertNoCarrierLeaks, CarrierLeakError, findSuspectInsurerNames, redactCarrierTerms, liveCarrierTerms } from './leak-guard.ts';
import type { ProposalDocumentModel } from './document-model.ts';

/**
 * Carrier names here are real ones observed in the sample corpus — they are public
 * company names, not client data. Every client detail is invented.
 */
const CARRIERS = [
  'Utica National Insurance Group',
  'Utica Mutual Insurance Company',
  'AmTrust',
  'Wesco Insurance Company',
  'Accelerant National Insurance Company',
  'Rainbow',
  'COMPASS',
  'SAFESIDE INS BROKERAGE INC',
];

function doc(overrides: Partial<ProposalDocumentModel> = {}): ProposalDocumentModel {
  return {
    client_name: 'Northgate Bakery LLC',
    prepared_on: '2026-09-19',
    customer: {
      named_insured: 'Northgate Bakery LLC',
      dba: null,
      mailing_address: '1 Example Way, Springfield, NY 10001',
      location_address: '1 Example Way, Springfield, NY 10001',
      contact_name: 'A. Baker',
      contact_phone: '555-0100',
      contact_email: 'a@example.test',
      entity_type: 'LLC',
      business_description: 'Retail bakery',
      effective_date: '2026-10-01',
      expiration_date: '2027-10-01',
      fein: '00-0000000',
    },
    effective_date: '2026-10-01',
    expiration_date: '2027-10-01',
    premium_page_title: 'GL Premium and Subjectivities Prior to Binding',
    priced_lines: [{ label: 'General Liability', admitted: 'Admitted', price: 2400 }],
    premium_disclaimers: ['Minimum Deposit applies if the policy is rated by payroll or sales'],
    sections: [
      {
        section_title: 'General Liability Coverage',
        limits_caption: 'Limits of Liability Table',
        tables: [{
          caption: 'Liability Classification',
          headings: ['Location #', 'Classification', 'Class Code', 'Exposure', 'Rating Basis'],
          rows: [['1', 'Accounting Services', '65121', '$350,000', 'Sales']],
          note: null,
        }],
        limits: [{ label: 'Each Occurrence', value: '$1,000,000' }],
        deductibles: [{ label: 'Property Deductible', value: '$1,000' }],
        endorsements: [],
        exclusions: [],
        conditions: [],
      },
    ],
    total: 2400,
    coverage_descriptions: [],
    forms_and_exclusions: [],
    recommendations: [],
    terms_note: null,
    recommendations_note: null,
    ...overrides,
  };
}

describe('leak guard', () => {
  test('a clean document produces no findings', () => {
    assert.deepEqual(scanForCarrierLeaks(doc(), { carrierNames: CARRIERS }), []);
  });

  test('catches a carrier name inside an endorsement label', () => {
    const d = doc();
    d.sections[0].endorsements = [
      { label: 'Utica Mutual Insurance Company Amendatory Endorsement', value: 'Included' },
    ];

    const found = scanForCarrierLeaks(d, { carrierNames: CARRIERS });
    assert.equal(found.length, 1);
    assert.equal(found[0].term, 'Utica Mutual Insurance Company');
    assert.equal(found[0].path, 'sections[0].endorsements[0].label');
    assert.match(found[0].excerpt, /Amendatory Endorsement/);
  });

  test('catches a carrier name in the forms section', () => {
    const d = doc({
      forms_and_exclusions: [{ group: 'Businessowners Policy', items: ['AmTrust Water Exclusion'] }],
    });
    const found = scanForCarrierLeaks(d, { carrierNames: CARRIERS });
    assert.equal(found.length, 1);
    assert.equal(found[0].path, 'forms_and_exclusions[0].items[0]');
  });

  // Safeside's own name appears in the agency footer of carrier quotes, so
  // extraction reports it among the carriers. Without this, every proposal would
  // fail its own check.
  test('does not flag the brokerage\'s own name', () => {
    const d = doc({ terms_note: 'Issued by Safeside Insurance Brokerage Inc.' });
    assert.deepEqual(scanForCarrierLeaks(d, { carrierNames: CARRIERS }), []);
  });

  // "Rainbow" is a real carrier (Rainbow MGA) and also an ordinary word that can
  // appear in a client's trading name.
  test('does not flag a carrier name that is part of the client\'s own name', () => {
    const d = doc({
      client_name: 'Rainbow Diner Inc',
      customer: { ...doc().customer, named_insured: 'Rainbow Diner Inc' },
    });
    const found = scanForCarrierLeaks(d, { carrierNames: CARRIERS });
    assert.deepEqual(found, []);
  });

  test('matches on word boundaries, not substrings', () => {
    const d = doc({ recommendations_note: 'We recommend compassionate claims handling.' });
    assert.deepEqual(scanForCarrierLeaks(d, { carrierNames: ['COMPASS'] }), []);
  });

  test('matching is case-insensitive', () => {
    const d = doc({ terms_note: 'Placed with amtrust this term.' });
    const found = scanForCarrierLeaks(d, { carrierNames: ['AmTrust'] });
    assert.equal(found.length, 1);
  });

  test('ignores terms shorter than four characters', () => {
    const d = doc({ terms_note: 'The GL policy is bound.' });
    assert.deepEqual(scanForCarrierLeaks(d, { carrierNames: ['GL'] }), []);
  });

  test('reports every distinct field a term appears in', () => {
    const d = doc({ terms_note: 'AmTrust terms apply.' });
    d.sections[0].conditions = [{ label: 'AmTrust cancellation clause', value: '30 days' }];

    const found = scanForCarrierLeaks(d, { carrierNames: ['AmTrust'] });
    assert.equal(found.length, 2);
    assert.deepEqual(
      found.map((f) => f.path).sort(),
      ['sections[0].conditions[0].label', 'terms_note'],
    );
  });

  test('assertNoCarrierLeaks fails closed and names the fields', () => {
    const d = doc({ terms_note: 'Wesco Insurance Company is the issuing carrier.' });
    assert.throws(
      () => assertNoCarrierLeaks(d, { carrierNames: CARRIERS }),
      (err: unknown) => {
        assert.ok(err instanceof CarrierLeakError);
        assert.equal(err.findings.length, 1);
        assert.match(err.message, /Wesco Insurance Company/);
        assert.match(err.message, /terms_note/);
        return true;
      },
    );
  });

  test('assertNoCarrierLeaks passes a clean document', () => {
    assert.doesNotThrow(() => assertNoCarrierLeaks(doc(), { carrierNames: CARRIERS }));
  });
});

describe('suspect insurer names (advisory third layer)', () => {
  // The case the name-list scan cannot cover: extraction never recorded this one.
  test('catches an insurer-shaped phrase that is not on the known list', () => {
    const d = doc();
    d.sections[0].endorsements = [
      { label: 'Cornerstone Indemnity Company Amendatory Endorsement', value: 'Included' },
    ];

    const found = findSuspectInsurerNames(d);
    assert.equal(found.length, 1);
    assert.equal(found[0].phrase, 'Cornerstone Indemnity Company');
    assert.equal(found[0].path, 'sections[0].endorsements[0].label');
  });

  /*
   * Safeside's own Regulation 194 copy says this four times. Flagging it would
   * make every proposal noisy, and blocking on it would make the tool unusable —
   * which is why the shape scan advises and the name scan blocks.
   */
  test('ignores the generic phrase in ordinary prose', () => {
    const d = doc({
      terms_note:
        'The primary source of our compensation is a commission paid by the insurance company, ' +
        'which is based on the premium you pay.',
    });
    assert.deepEqual(findSuspectInsurerNames(d), []);
  });

  test("does not flag the brokerage's own name", () => {
    const d = doc({ terms_note: 'Issued by Safeside Insurance Brokerage Inc.' });
    assert.deepEqual(findSuspectInsurerNames(d), []);
  });

  test("does not flag a client whose own name ends in an insurer suffix", () => {
    const d = doc({
      client_name: 'Northgate Underwriters LLC',
      customer: { ...doc().customer, named_insured: 'Northgate Underwriters LLC' },
    });
    assert.deepEqual(findSuspectInsurerNames(d), []);
  });

  test('a clean document produces no advisories', () => {
    assert.deepEqual(findSuspectInsurerNames(doc()), []);
  });

  // Advisory only: it must never be the thing that stops a proposal.
  test('advisories do not block generation', () => {
    const d = doc();
    d.sections[0].endorsements = [{ label: 'Cornerstone Indemnity Company Form', value: null }];

    assert.ok(findSuspectInsurerNames(d).length > 0, 'it is flagged');
    assert.doesNotThrow(() => assertNoCarrierLeaks(d, { carrierNames: CARRIERS }),
      'but generation still proceeds');
  });

  test('reports each distinct phrase once per field', () => {
    const d = doc({
      terms_note: 'Placed with Cornerstone Indemnity Company. Cornerstone Indemnity Company is admitted.',
    });
    assert.equal(findSuspectInsurerNames(d).length, 1);
  });
});

/*
 * Taking a carrier's name out of a label it branded.
 *
 * These are all real strings: "NYCM BOP Enhancement - NYC BP 113" is an
 * endorsement on a real carrier quote, and the proposal
 * Safeside wrote by hand carries it — carrier name and all — on its forms page.
 */
describe('redactCarrierTerms', () => {
  const carriers = ['New York Central Mutual Fire Insurance Company', 'NYCM'];

  test('removes the carrier brand and keeps the form number', () => {
    const r = redactCarrierTerms('NYCM BOP Enhancement - NYC BP 113', carriers);
    assert.equal(r.text, 'BOP Enhancement - NYC BP 113');
    assert.deepEqual(r.removed, ['NYCM']);
  });

  test('leaves a standard ISO form untouched', () => {
    const r = redactCarrierTerms('BP 00 03 BUSINESSOWNERS COVERAGE FORM', carriers);
    assert.equal(r.text, 'BP 00 03 BUSINESSOWNERS COVERAGE FORM');
    assert.deepEqual(r.removed, []);
  });

  test('NYC is not NYCM — a shorter lookalike is not touched', () => {
    const r = redactCarrierTerms('NYC BP 01 15 NEW YORK CHANGES', carriers);
    assert.equal(r.text, 'NYC BP 01 15 NEW YORK CHANGES');
  });

  test('does not match inside a longer word', () => {
    const text = 'NYCMIS POLICYHOLDER NOTICE';
    assert.equal(redactCarrierTerms(text, carriers).text, text);
  });

  test('prefers the longest term, so no fragment is stranded', () => {
    const r = redactCarrierTerms(
      'New York Central Mutual Fire Insurance Company Amendment', carriers,
    );
    assert.equal(r.text, 'Amendment');
    assert.deepEqual(r.removed, ['New York Central Mutual Fire Insurance Company']);
  });

  test('the brokerage’s own name is never stripped', () => {
    const r = redactCarrierTerms('Safeside Service Agreement', ['Safeside']);
    assert.equal(r.text, 'Safeside Service Agreement');
    assert.deepEqual(r.removed, []);
  });

  test('what it removes is exactly what the guard objects to', () => {
    // The whole point of sharing liveCarrierTerms: a label the scanner flags
    // must come back clean after redaction, or the broker fixes it and
    // generation fails anyway.
    const label = 'NYCM BOP Enhancement - NYC BP 113';
    const cleaned = redactCarrierTerms(label, carriers).text;
    for (const term of liveCarrierTerms(carriers)) {
      assert.ok(
        !new RegExp(`(^|[^A-Za-z0-9])${term}([^A-Za-z0-9]|$)`, 'i').test(cleaned),
        `"${term}" survived redaction in "${cleaned}"`,
      );
    }
  });
});
