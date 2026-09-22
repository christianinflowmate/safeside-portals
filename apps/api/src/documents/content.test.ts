import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { premiumPageTitle, SUBJECTIVITIES } from './content.ts';

describe('the premium page heading', () => {
  test('names the lines quoted, in the order given', () => {
    assert.equal(
      premiumPageTitle(['business_owners_policy', 'workers_comp', 'disability_pfl']),
      'BOP/WC/DBL Premium and Subjectivities Prior to Binding',
    );
  });

  test('a line quoted twice appears once in the prefix', () => {
    assert.equal(premiumPageTitle(['workers_comp', 'workers_comp']),
      'WC Premium and Subjectivities Prior to Binding');
  });

  test('an unrecognised line type is left out rather than printed raw', () => {
    // The table below the heading still names it in full.
    assert.equal(premiumPageTitle(['workers_comp', 'something_new']),
      'WC Premium and Subjectivities Prior to Binding');
  });

  test('no recognised line means the plain title, never an empty prefix', () => {
    assert.equal(premiumPageTitle([]), 'Premium and Subjectivities Prior to Binding');
    assert.equal(premiumPageTitle(['something_new']), 'Premium and Subjectivities Prior to Binding');
  });
});

describe('subjectivities', () => {
  test('are plain strings, so they can be rendered as table rows', () => {
    // A regression guard: they were a bullets CopyBlock, and Safeside prints them
    // as a bordered table matching the premium table above.
    assert.ok(SUBJECTIVITIES.every((s) => typeof s === 'string'));
    assert.ok(SUBJECTIVITIES.length > 0);
  });
});
