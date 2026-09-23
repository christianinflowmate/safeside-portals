/**
 * When a failed file may be read again.
 *
 * The two rules are here rather than inline in the route so they can be tested
 * without standing up an HTTP server, and so the second one — which is not
 * obvious and is easy to "fix" by deleting — is written down next to its reason.
 *
 * Returns the reason it is refused, or null when it may go ahead. It is pure on
 * purpose: the caller does the database work and decides how to report a refusal.
 */

export const RETRY_AFTER_DRAFT_REASON =
  'This proposal already has a reviewable draft, and a file read now could not be added to it ' +
  'without risking edits already made. Start a new proposal with all of the quotes instead.';

export function whyRetryRefused(
  file: { extraction_status: string },
  existingLineCount: number,
): string | null {
  if (file.extraction_status !== 'failed') {
    return `That file is ${file.extraction_status}, not failed — only a failed file can be read again.`;
  }

  /*
   * The proposal must not already have been turned into a draft.
   *
   * materializeProposal refuses to touch a proposal that already has lines, and
   * that refusal is load-bearing: it is what stops a re-extraction overwriting a
   * broker's edits. So a file read at this point would extract fine, be stored
   * fine, and never appear anywhere — the retry would look like it worked and
   * quietly do nothing, which is the worst of the three possible behaviours.
   */
  if (existingLineCount > 0) return RETRY_AFTER_DRAFT_REASON;

  return null;
}
