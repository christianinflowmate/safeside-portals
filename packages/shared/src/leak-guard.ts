import type { ProposalDocumentModel, DocumentDetail } from './document-model.ts';

/**
 * Second layer of carrier-leak prevention.
 *
 * The document model (layer 1) makes carrier fields structurally unreachable. It
 * cannot, however, catch a carrier name embedded INSIDE a value that legitimately
 * belongs in the document — a limit labelled "Travelers Form CG 20 10", an
 * endorsement whose title carries a carrier's product name. Extraction records
 * every carrier name it saw; this scans the assembled document for them before a
 * PDF is released.
 *
 * Three refinements, each from a real case in the sample corpus:
 *
 *   1. Safeside's own name appears in the agency footer of carrier quotes, so
 *      extraction correctly reports it as a carrier name. Without an allowlist,
 *      every proposal would fail its own check.
 *
 *   2. Carrier names that are ordinary words — "Rainbow", "Compass" — will match
 *      inside a client's business name. A name that appears in the client's own
 *      named insured or DBA is not a leak.
 *
 *   3. Short tokens produce noise. "AmCares" is worth matching; a three-letter
 *      abbreviation inside longer words is not, so matches are word-bounded.
 */

/** Names belonging to the brokerage itself, which are expected in its own document. */
export const BROKERAGE_NAMES = [
  'Safeside',
  'Safeside Insurance Brokerage',
  'Safeside Ins Brokerage',
  'Safeside Insurance Brokerage Inc',
];

export interface LeakFinding {
  /** The carrier name that matched. */
  term: string;
  /** Dotted path into the document model, e.g. "lines[1].endorsements[3].label". */
  path: string;
  /** The offending text, trimmed around the match for display on review. */
  excerpt: string;
}

const MIN_TERM_LENGTH = 4;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collect every string in the document alongside its path, so a finding can point
 * at the exact field a broker needs to edit rather than just saying "somewhere".
 */
function walkStrings(value: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (typeof value === 'string') {
    if (value.trim()) out.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkStrings(v, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      walkStrings(v, path ? `${path}.${k}` : k, out);
    }
  }
}

export interface ScanOptions {
  /** Carrier names gathered by extraction across every file on the proposal. */
  carrierNames: string[];
  /** Extra names to treat as safe, beyond the brokerage's own. */
  allowlist?: string[];
}

/**
 * The carrier names actually worth matching, after the three refinements above.
 *
 * Shared deliberately. The review screen offers to strip a carrier name out of a
 * label, and "what the guard objects to" and "what the fix removes" have to be
 * the same set — otherwise the fix appears to work and generation still fails,
 * or worse, the fix removes something the guard would have allowed.
 */
export function liveCarrierTerms(
  carrierNames: string[],
  { allowlist = [], clientIdentity = '' }: { allowlist?: string[]; clientIdentity?: string } = {},
): string[] {
  const safe = new Set([...BROKERAGE_NAMES, ...allowlist].map((n) => n.toLowerCase().trim()));
  const identity = clientIdentity.toLowerCase();
  return carrierNames
    .map((n) => n.trim())
    .filter((n) => n.length >= MIN_TERM_LENGTH)
    .filter((n) => !safe.has(n.toLowerCase()))
    // Drop any carrier term that is contained in the brokerage's own names, which
    // catches "Safeside Ins Brokerage Inc" style variants the allowlist missed.
    .filter((n) => ![...safe].some((s) => s.includes(n.toLowerCase())))
    .filter((n) => !identity.includes(n.toLowerCase()));
}

/**
 * Take the carrier's name out of a piece of text, leaving the rest alone.
 *
 * Carriers brand their own endorsements — "NYCM BOP Enhancement - NYC BP 113" is
 * a real one, and a quote can carry two dozen of them. Editing each by hand is
 * the kind of friction that ends with someone asking for the guard to be turned
 * off, so the review screen offers this instead.
 *
 * It only ever DELETES a matched term and tidies the whitespace and punctuation
 * left behind; it never rewrites or paraphrases. The form's number survives,
 * which is what identifies it against the policy the client eventually receives.
 */
export function redactCarrierTerms(
  text: string,
  carrierNames: string[],
  options: { allowlist?: string[]; clientIdentity?: string } = {},
): { text: string; removed: string[] } {
  const removed: string[] = [];
  let out = text;

  // Longest first, so "Houston Specialty Insurance Company" goes before "HSIC"
  // and a short term cannot strand a fragment of a longer one.
  for (const term of liveCarrierTerms(carrierNames, options).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|[^A-Za-z0-9])(${escapeRegExp(term)})(?=[^A-Za-z0-9]|$)`, 'gi');
    if (!re.test(out)) continue;
    removed.push(term);
    out = out.replace(re, '$1');
  }

  const cleaned = out
    .replace(/\s{2,}/g, ' ')
    // A term removed from the front can leave a dangling separator behind.
    .replace(/^[\s\-–—:,/]+/, '')
    .replace(/[\s\-–—:,/]+$/, '')
    .trim();

  return { text: cleaned, removed };
}

export function scanForCarrierLeaks(
  doc: ProposalDocumentModel,
  { carrierNames, allowlist = [] }: ScanOptions,
): LeakFinding[] {
  // The client's own identifiers. A carrier name that is also part of the client's
  // business name is not a leak — see refinement 2 above.
  const clientIdentity = [doc.client_name, doc.customer.named_insured, doc.customer.dba]
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .join(' ')
    .toLowerCase();

  const terms = liveCarrierTerms(carrierNames, { allowlist, clientIdentity });

  if (terms.length === 0) return [];

  const strings: Array<{ path: string; text: string }> = [];
  walkStrings(doc, '', strings);

  const findings: LeakFinding[] = [];
  const seen = new Set<string>();

  for (const term of terms) {
    // Word-bounded so a short name cannot match inside a longer word.
    const re = new RegExp(`(^|[^A-Za-z0-9])(${escapeRegExp(term)})([^A-Za-z0-9]|$)`, 'i');
    for (const { path, text } of strings) {
      const m = re.exec(text);
      if (!m) continue;

      const key = `${term}::${path}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const at = m.index + m[1].length;
      findings.push({
        term,
        path,
        excerpt: buildExcerpt(text, at, term.length),
      });
    }
  }

  return findings;
}

function buildExcerpt(text: string, at: number, length: number): string {
  const PAD = 30;
  const start = Math.max(0, at - PAD);
  const end = Math.min(text.length, at + length + PAD);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/**
 * Throwing wrapper for the render path. Generation must fail closed: a proposal
 * that might name a carrier is not released, and the broker is shown exactly which
 * field to fix.
 */
export class CarrierLeakError extends Error {
  readonly findings: LeakFinding[];

  constructor(findings: LeakFinding[]) {
    super(
      `Refusing to generate: ${findings.length} possible carrier reference(s) in the document — ` +
        findings.map((f) => `"${f.term}" at ${f.path}`).join('; '),
    );
    this.name = 'CarrierLeakError';
    this.findings = findings;
  }
}

export function assertNoCarrierLeaks(doc: ProposalDocumentModel, opts: ScanOptions): void {
  const findings = scanForCarrierLeaks(doc, opts);
  if (findings.length > 0) throw new CarrierLeakError(findings);
}

/** Convenience for the review screen: flatten a line's details for display. */
export function allDetails(details: DocumentDetail[]): string {
  return details.map((d) => [d.label, d.value].filter(Boolean).join(' ')).join(' · ');
}

/* -------------------------------------------------------------------------- */
/* Third layer: insurer-shaped text the name list never knew about             */
/* -------------------------------------------------------------------------- */

/**
 * The scan above can only find carrier names that extraction recorded. If the
 * model missed one — a carrier mentioned once in an endorsement title it did not
 * recognise as a name — there is nothing to match against and the leak goes
 * through.
 *
 * This looks for the SHAPE of an insurer name instead: a capitalised phrase
 * ending in "Insurance Company", "Mutual", "Underwriters" and so on.
 *
 * It ADVISES rather than blocks. Safeside's own Regulation 194 boilerplate says
 * "compensation paid by the insurance company" four times, and failing
 * generation on that would make the tool unusable. Blocking on known names,
 * flagging on shape — the broker sees the advisories on review and decides.
 */
const INSURER_SUFFIXES = [
  'Insurance Company', 'Insurance Group', 'Insurance Co',
  'Mutual Insurance', 'Mutual Group', 'Underwriters', 'Assurance',
  'Casualty Company', 'Casualty Insurance', 'Indemnity Company',
  'Risk Retention Group', 'Reciprocal Exchange',
];

/**
 * A capitalised run of words immediately before an insurer suffix. "Utica
 * National Insurance Group" matches; "the insurance company" does not, because
 * the words before the suffix must read as a proper noun.
 */
const SUSPECT = new RegExp(
  `\\b((?:[A-Z][A-Za-z&.'-]*\\s+){1,4})(${INSURER_SUFFIXES.map(escapeRegExp).join('|')})\\b`,
  'g',
);

export interface SuspectFinding {
  /** The phrase that looked like an insurer name. */
  phrase: string;
  path: string;
  excerpt: string;
}

export function findSuspectInsurerNames(
  doc: ProposalDocumentModel,
  { allowlist = [] }: { allowlist?: string[] } = {},
): SuspectFinding[] {
  const safe = [...BROKERAGE_NAMES, ...allowlist].map((n) => n.toLowerCase());
  const clientIdentity = [doc.client_name, doc.customer.named_insured, doc.customer.dba]
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .join(' ')
    .toLowerCase();

  const strings: Array<{ path: string; text: string }> = [];
  walkStrings(doc, '', strings);

  const findings: SuspectFinding[] = [];
  const seen = new Set<string>();

  for (const { path, text } of strings) {
    for (const match of text.matchAll(SUSPECT)) {
      const phrase = match[0].trim();
      const lower = phrase.toLowerCase();

      if (safe.some((s) => lower.includes(s) || s.includes(lower))) continue;
      if (clientIdentity.includes(lower)) continue;

      const key = `${lower}::${path}`;
      if (seen.has(key)) continue;
      seen.add(key);

      findings.push({ phrase, path, excerpt: buildExcerpt(text, match.index ?? 0, phrase.length) });
    }
  }

  return findings;
}
