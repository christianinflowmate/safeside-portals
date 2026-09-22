import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mergeExtractions, blockingReasons, type ExtractionSource } from './merge.ts';
import type { CoverageLine, CustomerBlock, ExtractionResult, LineType } from './extraction.ts';

/** All client details invented. Carrier names are real public companies. */

function cell(value: string | null, confidence = 0.95) {
  return { value, meta: { found: value != null, confidence, page: null, note: null } };
}

function customer(over: Partial<Record<keyof CustomerBlock, ReturnType<typeof cell>>> = {}) {
  const blank = cell(null, 0);
  return {
    named_insured: cell('Northgate Bakery LLC'),
    dba: blank, mailing_address: blank, location_address: blank,
    contact_name: blank, contact_phone: blank, contact_email: blank,
    fein: blank, entity_type: blank, business_description: blank,
    // A policy period, because the default fixture stands for a COMPLETE
    // proposal and both dates block generation — they print as the effective
    // term and half a term prints as an em dash. Tests about missing dates
    // override these explicitly.
    effective_date: cell('2026-06-21'), expiration_date: cell('2027-06-21'),
    ...over,
  } as CustomerBlock;
}

function line(over: Partial<CoverageLine> & { line_type: LineType }): CoverageLine {
  return {
    line_type_label: null, carrier_name: null, premium: 1000,
    premium_components: [], details: [], options: [],
    admitted: null,
    schedules: { classifications: [], subjects_of_insurance: [], states: [],
      employers_liability: [], rating_basis: [], individuals: [], note: null },
    confidence: 0.9, page_start: null,
    ...over,
  };
}

function src(fileId: string, filename: string, over: Partial<ExtractionResult> = {}): ExtractionSource {
  return {
    fileId, filename,
    result: { customer: customer(), lines: [], carrier_names_seen: [], premises: [], notes: [], ...over },
  };
}

describe('merging several files into one proposal', () => {
  test('different coverage types from different files become separate lines', () => {
    const merged = mergeExtractions([
      src('f1', 'bop.pdf', { lines: [line({ line_type: 'business_owners_policy', premium: 604.5 })] }),
      src('f2', 'wc.pdf', { lines: [line({ line_type: 'workers_comp', premium: 1258 })] }),
    ]);

    assert.equal(merged.lines.length, 2);
    assert.deepEqual(
      merged.lines.map((l) => l.line_type).sort(),
      ['business_owners_policy', 'workers_comp'],
    );
  });

  // The definition-of-done case: several files must not produce duplicate lines.
  test('the same coverage in two files does not duplicate the line', () => {
    const merged = mergeExtractions([
      src('f1', 'utica.pdf', { lines: [line({ line_type: 'general_liability', carrier_name: 'Utica National', premium: 2400 })] }),
      src('f2', 'amtrust.pdf', { lines: [line({ line_type: 'general_liability', carrier_name: 'AmTrust', premium: 2650 })] }),
    ]);

    assert.equal(merged.lines.length, 1);
  });

  // Two carriers quoting the same risk is a choice, not a duplicate to collapse.
  // Collapsing would silently discard one carrier's price.
  test('competing quotes for one coverage become options awaiting a choice', () => {
    const merged = mergeExtractions([
      src('f1', 'utica.pdf', { lines: [line({ line_type: 'general_liability', carrier_name: 'Utica National', premium: 2400 })] }),
      src('f2', 'amtrust.pdf', { lines: [line({ line_type: 'general_liability', carrier_name: 'AmTrust', premium: 2650 })] }),
    ]);

    const gl = merged.lines[0];
    assert.equal(gl.options.length, 2);
    assert.equal(gl.premium, null, 'price must live on the options, not the line');
    assert.equal(gl.carrier_name, null, 'carrier is ambiguous until one is chosen');
    assert.deepEqual(gl.options.map((o) => o.premium).sort(), [2400, 2650]);
    assert.ok(gl.options.every((o) => o.fromSeparateFile));
  });

  test('options within a single quote are kept and marked as same-file', () => {
    const merged = mergeExtractions([
      src('f1', 'gl.pdf', {
        lines: [line({
          line_type: 'general_liability', premium: null,
          options: [
            { label: '$1M / $2M', premium: 2400, premium_components: [], details: [] },
            { label: '$2M / $4M', premium: 3100, premium_components: [], details: [] },
          ],
        })],
      }),
    ]);

    const gl = merged.lines[0];
    assert.equal(gl.options.length, 2);
    assert.ok(gl.options.every((o) => o.fromSeparateFile === false));
  });

  test('a carrier offering choices keeps them when compared against another carrier', () => {
    const merged = mergeExtractions([
      src('f1', 'utica.pdf', {
        lines: [line({
          line_type: 'general_liability', carrier_name: 'Utica National', premium: null,
          options: [
            { label: '$1M / $2M', premium: 2400, premium_components: [], details: [] },
            { label: '$2M / $4M', premium: 3100, premium_components: [], details: [] },
          ],
        })],
      }),
      src('f2', 'amtrust.pdf', { lines: [line({ line_type: 'general_liability', carrier_name: 'AmTrust', premium: 2650 })] }),
    ]);

    const gl = merged.lines[0];
    assert.equal(gl.options.length, 3, 'both of one carrier\'s options plus the other carrier');
    assert.ok(gl.options.some((o) => o.label.includes('Utica National') && o.label.includes('$2M')));
  });
});

describe('customer field merging', () => {
  test('a field present in one file and absent in another is taken', () => {
    const merged = mergeExtractions([
      src('f1', 'a.pdf', { customer: customer({ fein: cell(null, 0) }) }),
      src('f2', 'b.pdf', { customer: customer({ fein: cell('00-0000000') }) }),
    ]);
    assert.equal(merged.customer.fein.value, '00-0000000');
    assert.deepEqual(merged.customer.fein.conflicts, []);
  });

  test('higher confidence wins', () => {
    const merged = mergeExtractions([
      src('f1', 'a.pdf', { customer: customer({ contact_name: cell('A. Baker', 0.4) }) }),
      src('f2', 'b.pdf', { customer: customer({ contact_name: cell('Alex Baker', 0.9) }) }),
    ]);
    assert.equal(merged.customer.contact_name.value, 'Alex Baker');
  });

  // The brief is explicit: disagreements are surfaced, never resolved quietly.
  test('genuinely different values are surfaced as conflicts', () => {
    const merged = mergeExtractions([
      src('f1', 'a.pdf', { customer: customer({ mailing_address: cell('1 Example Way, Springfield NY', 0.9) }) }),
      src('f2', 'b.pdf', { customer: customer({ mailing_address: cell('88 Other Road, Rivertown NY', 0.8) }) }),
    ]);

    const f = merged.customer.mailing_address;
    assert.equal(f.value, '1 Example Way, Springfield NY');
    assert.equal(f.conflicts.length, 1);
    assert.equal(f.conflicts[0].filename, 'b.pdf');
  });

  // Punctuation and spacing differences are not a question worth asking a broker.
  test('trivially different spellings are not treated as a conflict', () => {
    const merged = mergeExtractions([
      src('f1', 'a.pdf', { customer: customer({ mailing_address: cell('1 Example Way, Springfield, NY', 0.9) }) }),
      src('f2', 'b.pdf', { customer: customer({ mailing_address: cell('1 Example Way  Springfield NY', 0.8) }) }),
    ]);
    assert.deepEqual(merged.customer.mailing_address.conflicts, []);
  });

  test('carrier names and notes are pooled across files', () => {
    const merged = mergeExtractions([
      src('f1', 'a.pdf', { carrier_names_seen: ['Utica National', 'Utica Mutual'], notes: ['note one'] }),
      src('f2', 'b.pdf', { carrier_names_seen: ['Utica National', 'AmTrust'], notes: ['note two'] }),
    ]);
    assert.deepEqual(merged.carrierNames.sort(), ['AmTrust', 'Utica Mutual', 'Utica National']);
    assert.equal(merged.notes.length, 2);
    assert.equal(merged.notes[1].filename, 'b.pdf');
  });
});

describe('what blocks generation', () => {
  const included = (...t: LineType[]) => new Set<LineType>(t);

  test('an unresolved option choice blocks, and says so readably', () => {
    const merged = mergeExtractions([
      src('f1', 'utica.pdf', { lines: [line({ line_type: 'general_liability', premium: 2400 })] }),
      src('f2', 'amtrust.pdf', { lines: [line({ line_type: 'general_liability', premium: 2650 })] }),
    ]);

    const reasons = blockingReasons(merged, included('general_liability'));
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /General Liability: choose one of 2 quoted options/);
  });

  test('a conflicting customer field blocks', () => {
    const merged = mergeExtractions([
      src('f1', 'a.pdf', { customer: customer({ mailing_address: cell('1 Example Way', 0.9) }), lines: [line({ line_type: 'workers_comp' })] }),
      src('f2', 'b.pdf', { customer: customer({ mailing_address: cell('88 Other Road', 0.8) }), lines: [] }),
    ]);

    const reasons = blockingReasons(merged, included('workers_comp'));
    assert.ok(reasons.some((r) => /Mailing Address: files disagree/.test(r)));
  });

  test('a missing premium blocks', () => {
    const merged = mergeExtractions([
      src('f1', 'a.pdf', { lines: [line({ line_type: 'workers_comp', premium: null })] }),
    ]);
    const reasons = blockingReasons(merged, included('workers_comp'));
    assert.ok(reasons.some((r) => /no premium was found/.test(r)));
  });

  test('excluded lines do not block', () => {
    const merged = mergeExtractions([
      src('f1', 'a.pdf', { lines: [line({ line_type: 'workers_comp', premium: null })] }),
      src('f2', 'b.pdf', { lines: [line({ line_type: 'general_liability', premium: 2400 })] }),
    ]);
    assert.deepEqual(blockingReasons(merged, included('general_liability')), []);
  });

  test('a complete single-carrier proposal blocks on nothing', () => {
    const merged = mergeExtractions([
      src('f1', 'bop.pdf', { lines: [line({ line_type: 'business_owners_policy', premium: 604.5 })] }),
    ]);
    assert.deepEqual(blockingReasons(merged, included('business_owners_policy')), []);
  });

  /*
   * The premium page prints "Effective Term <from> – <to>". A real proposal
   * came out reading "June 21, 2026 – —" because that quote never stated an
   * expiry. Extraction was right not to invent one; the document was wrong to go
   * out half-finished.
   */
  test('a missing expiration date blocks', () => {
    const merged = mergeExtractions([
      src('f1', 'a.pdf', {
        customer: customer({ expiration_date: cell(null, 0) }),
        lines: [line({ line_type: 'business_owners_policy', premium: 604.5 })],
      }),
    ]);
    const reasons = blockingReasons(merged, included('business_owners_policy'));
    assert.deepEqual(reasons, ['Expiration date is missing.']);
  });

  test('a missing effective date blocks too — a term has two ends', () => {
    const merged = mergeExtractions([
      src('f1', 'a.pdf', {
        customer: customer({ effective_date: cell(null, 0) }),
        lines: [line({ line_type: 'business_owners_policy', premium: 604.5 })],
      }),
    ]);
    const reasons = blockingReasons(merged, included('business_owners_policy'));
    assert.deepEqual(reasons, ['Effective date is missing.']);
  });

  test('including nothing blocks', () => {
    const merged = mergeExtractions([src('f1', 'a.pdf', { lines: [line({ line_type: 'workers_comp' })] })]);
    assert.ok(blockingReasons(merged, included()).some((r) => /No coverage lines are included/.test(r)));
  });
});
