import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { whyRetryRefused, RETRY_AFTER_DRAFT_REASON } from './retry.ts';

describe('reading a failed file again', () => {
  test('a failed file on a proposal with no draft yet may be retried', () => {
    assert.equal(whyRetryRefused({ extraction_status: 'failed' }, 0), null);
  });

  test('a file that did not fail is refused, and the reason names its actual state', () => {
    for (const status of ['pending', 'running', 'succeeded']) {
      const reason = whyRetryRefused({ extraction_status: status }, 0);
      assert.ok(reason, `${status} should be refused`);
      assert.match(reason, new RegExp(status));
    }
  });

  /*
   * The one that matters.
   *
   * materializeProposal will not touch a proposal that already has lines, which
   * is what protects a broker's edits from a re-extraction. Allowing a retry here
   * would extract the file, store it, and never show it — work that appears to
   * succeed and changes nothing. Refusing is the correct behaviour, so it is
   * pinned here rather than left to be rediscovered.
   */
  test('a failed file is refused once the proposal has a draft', () => {
    assert.equal(whyRetryRefused({ extraction_status: 'failed' }, 1), RETRY_AFTER_DRAFT_REASON);
    assert.equal(whyRetryRefused({ extraction_status: 'failed' }, 12), RETRY_AFTER_DRAFT_REASON);
  });

  test('the wrong-status rule is checked before the draft rule', () => {
    // A succeeded file on a materialised proposal should be told it did not fail,
    // which is the more useful of the two answers.
    const reason = whyRetryRefused({ extraction_status: 'succeeded' }, 5);
    assert.match(reason ?? '', /succeeded/);
  });
});
