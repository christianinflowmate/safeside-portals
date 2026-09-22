import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSections, sectionsForLine, decomposes, classifyDetail, lineRank } from './sections.ts';
import type { LineDetail, LineType } from './extraction.ts';

const TITLES: Record<string, string> = {
  general_liability: 'General Liability Coverage',
  property: 'Property Coverage',
  workers_comp: 'Workers Compensation Coverage',
  disability_pfl: 'Disability / Paid Family Leave Coverage',
};
const titleFor = (c: string) => TITLES[c] ?? c;

function detail(over: Partial<LineDetail> & { label: string }): LineDetail {
  return { kind: 'limit', value: null, confidence: 0.9, section_hint: null, ...over };
}

describe('line to section mapping', () => {
  test('a BOP renders as two coverage pages', () => {
    assert.deepEqual(sectionsForLine('business_owners_policy'), ['general_liability', 'property']);
    assert.equal(decomposes('business_owners_policy'), true);
  });

  test('ordinary lines map one to one', () => {
    assert.deepEqual(sectionsForLine('workers_comp'), ['workers_comp']);
    assert.equal(decomposes('workers_comp'), false);
  });
});

describe('classifying a packaged line\'s details', () => {
  test('the model\'s hint is authoritative', () => {
    assert.equal(classifyDetail(detail({ label: 'Anything At All', section_hint: 'property' })), 'property');
    // Even when the wording points the other way — the model saw the document.
    assert.equal(classifyDetail(detail({ label: 'Each Occurrence', section_hint: 'property' })), 'property');
  });

  test('falls back to wording when untagged', () => {
    assert.equal(classifyDetail(detail({ label: 'Each Occurrence' })), 'liability');
    assert.equal(classifyDetail(detail({ label: 'General Aggregate' })), 'liability');
    assert.equal(classifyDetail(detail({ label: 'Business Personal Property' })), 'property');
    assert.equal(classifyDetail(detail({ label: 'Equipment Breakdown' })), 'property');
  });

  // "Business Personal Property" would match a naive liability check on the word
  // "personal" from "Personal & Advertising Injury".
  test('property wording wins over overlapping liability words', () => {
    assert.equal(classifyDetail(detail({ label: 'Business Personal Property' })), 'property');
    assert.equal(classifyDetail(detail({ label: 'Personal & Advertising Injury' })), 'liability');
  });

  test('returns null when it genuinely cannot tell', () => {
    assert.equal(classifyDetail(detail({ label: 'Terrorism' })), null);
  });
});

describe('building sections', () => {
  test('a BOP splits its limits across two pages', () => {
    const sections = buildSections({
      lineType: 'business_owners_policy',
      details: [
        detail({ label: 'Each Occurrence', value: '$1,000,000', section_hint: 'liability' }),
        detail({ label: 'General Aggregate', value: '$2,000,000', section_hint: 'liability' }),
        detail({ label: 'Building', value: '$30,000', section_hint: 'property' }),
        detail({ kind: 'deductible', label: 'Property Deductible', value: '$2,500', section_hint: 'property' }),
      ],
    }, titleFor);

    assert.equal(sections.length, 2);
    assert.equal(sections[0].section_title, 'General Liability Coverage');
    assert.equal(sections[0].limits.length, 2);
    assert.equal(sections[1].section_title, 'Property Coverage');
    assert.equal(sections[1].limits.length, 1);
    assert.equal(sections[1].deductibles.length, 1);
  });

  // Losing a limit is worse than putting one on the wrong page: a broker
  // proofreading will notice the second and not the first.
  test('an unclassifiable detail is placed, never dropped', () => {
    const sections = buildSections({
      lineType: 'business_owners_policy',
      details: [
        detail({ label: 'Each Occurrence', section_hint: 'liability' }),
        detail({ label: 'Terrorism Coverage', value: 'Included' }),
      ],
    }, titleFor);

    const total = sections.reduce((n, s) => n + s.limits.length, 0);
    assert.equal(total, 2, 'every detail must appear somewhere');
  });

  test('an empty half is not printed', () => {
    const sections = buildSections({
      lineType: 'business_owners_policy',
      details: [detail({ label: 'Each Occurrence', section_hint: 'liability' })],
    }, titleFor);

    assert.equal(sections.length, 1);
    assert.equal(sections[0].section_title, 'General Liability Coverage');
  });

  test('a non-packaged line yields one section with everything on it', () => {
    const sections = buildSections({
      lineType: 'workers_comp',
      details: [
        detail({ label: 'Each Accident', value: '$1,000,000' }),
        detail({ kind: 'endorsement', label: 'Waiver of Subrogation', value: 'Included' }),
        detail({ kind: 'exclusion', label: 'Owner Excluded', value: null }),
      ],
    }, titleFor);

    assert.equal(sections.length, 1);
    assert.equal(sections[0].section_title, 'Workers Compensation Coverage');
    assert.equal(sections[0].limits.length, 1);
    assert.equal(sections[0].endorsements.length, 1);
    assert.equal(sections[0].exclusions.length, 1);
  });

  test('forms are presented alongside endorsements', () => {
    const sections = buildSections({
      lineType: 'workers_comp',
      details: [detail({ kind: 'form', label: 'Amendatory Endorsement', value: 'WC 00 00' })],
    }, titleFor);
    assert.equal(sections[0].endorsements.length, 1);
  });

  // Sections carry no price by construction — there is no field to populate.
  test('no section can carry a price', () => {
    const [section] = buildSections({
      lineType: 'workers_comp',
      details: [detail({ label: 'Each Accident' })],
    }, titleFor);
    assert.ok(!('price' in section));
  });
});

describe('canonical line ordering', () => {
  test('packages and statutory lines come before specialty ones', () => {
    const shuffled: LineType[] = ['cyber', 'workers_comp', 'business_owners_policy', 'disability_pfl'];
    const sorted = [...shuffled].sort((a, b) => lineRank(a) - lineRank(b));
    assert.deepEqual(sorted, ['business_owners_policy', 'workers_comp', 'disability_pfl', 'cyber']);
  });

  test('the order does not depend on which file was uploaded first', () => {
    // The reason this exists: without it the premium heading reads "BOP/WC" or
    // "WC/BOP" for the same two quotes depending on upload order.
    const byRank = (xs: LineType[]) => [...xs].sort((a, b) => lineRank(a) - lineRank(b));
    assert.deepEqual(
      byRank(['workers_comp', 'business_owners_policy']),
      byRank(['business_owners_policy', 'workers_comp']),
    );
  });

  test('an unranked type sorts last rather than first', () => {
    assert.ok(lineRank('other') >= lineRank('flood'));
  });
});
