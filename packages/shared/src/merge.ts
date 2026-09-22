import type { CoverageLine, CustomerBlock, ExtractionResult, LineOption, LineType } from './extraction.ts';

/**
 * Merge several files' extractions into one proposal.
 *
 * A client arrives either as one combined PDF holding several quotes, or as
 * separate files per line of business. Both must end up as a single proposal with
 * no duplicated lines.
 *
 * Two rules do most of the work, and the second is not in the brief:
 *
 *   1. Customer fields merge with the most complete value winning, and any
 *      disagreement between files is SURFACED rather than resolved quietly. A
 *      broker seeing two mailing addresses can pick; a broker shown one silently
 *      chosen address cannot know there was a question.
 *
 *   2. The same coverage line appearing in two files is usually two carriers
 *      quoting the same risk — competing quotes the broker chooses between. That
 *      is an option set, not a duplicate to collapse and not two lines to print.
 *      Collapsing it would discard a real price; printing both would put two
 *      General Liability sections in one proposal.
 */

export interface ExtractionSource {
  fileId: string;
  filename: string;
  result: ExtractionResult;
}

export interface FieldConflict {
  value: string;
  fileId: string;
  filename: string;
  confidence: number;
}

export interface MergedField {
  value: string | null;
  found: boolean;
  confidence: number;
  sourceFileId: string | null;
  /**
   * Populated only when files disagreed. The chosen value is NOT repeated here —
   * these are the alternatives the broker can switch to.
   */
  conflicts: FieldConflict[];
}

export type MergedCustomer = Record<keyof CustomerBlock, MergedField>;

export interface MergedLine {
  line_type: LineType;
  line_type_label: string | null;
  carrier_name: string | null;
  premium: number | null;
  premium_components: CoverageLine['premium_components'];
  details: CoverageLine['details'];
  admitted: CoverageLine['admitted'];
  schedules: CoverageLine['schedules'];
  /**
   * More than one entry means a choice is outstanding and generation is blocked
   * until the broker picks. Empty means a single unambiguous version.
   */
  options: MergedLineOption[];
  confidence: number;
  sourceFileIds: string[];
}

export interface MergedLineOption extends LineOption {
  /** Which file this option came from. Null for options within a single quote. */
  sourceFileId: string | null;
  sourceFilename: string | null;
  /**
   * True when this option exists because two files quoted the same coverage,
   * rather than because one document offered a choice. The review screen words
   * these differently — "two carriers quoted this" vs "this quote offers a choice".
   */
  fromSeparateFile: boolean;
}

export interface MergedProposal {
  customer: MergedCustomer;
  lines: MergedLine[];
  carrierNames: string[];
  notes: Array<{ fileId: string; filename: string; note: string }>;
}

/** Loose equality for comparing extracted values across files. */
function sameValue(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

function mergeCustomerField(
  field: keyof CustomerBlock,
  sources: ExtractionSource[],
): MergedField {
  const candidates = sources
    .map((s) => ({ source: s, cell: s.result.customer[field] }))
    .filter((c) => c.cell.value != null && String(c.cell.value).trim() !== '')
    .map((c) => ({
      value: String(c.cell.value),
      confidence: c.cell.meta.confidence,
      fileId: c.source.fileId,
      filename: c.source.filename,
    }));

  if (candidates.length === 0) {
    return { value: null, found: false, confidence: 0, sourceFileId: null, conflicts: [] };
  }

  // Most complete wins: highest confidence first, then the longer value, which for
  // addresses and business descriptions is reliably the more complete one.
  const ranked = [...candidates].sort(
    (a, b) => b.confidence - a.confidence || b.value.length - a.value.length,
  );
  const winner = ranked[0];

  // Only genuinely different values are conflicts. Two files spelling the same
  // address slightly differently is not a question worth putting to a broker.
  const conflicts = ranked
    .slice(1)
    .filter((c) => !sameValue(c.value, winner.value))
    .filter((c, i, arr) => arr.findIndex((o) => sameValue(o.value, c.value)) === i);

  return {
    value: winner.value,
    found: true,
    confidence: winner.confidence,
    sourceFileId: winner.fileId,
    conflicts,
  };
}

function lineToOption(
  line: CoverageLine,
  source: ExtractionSource,
): MergedLineOption {
  return {
    label: line.line_type_label ?? source.filename,
    premium: line.premium,
    premium_components: line.premium_components,
    details: line.details,
    sourceFileId: source.fileId,
    sourceFilename: source.filename,
    fromSeparateFile: true,
  };
}

export function mergeExtractions(sources: ExtractionSource[]): MergedProposal {
  const customerFields = [
    'named_insured', 'dba', 'mailing_address', 'location_address',
    'contact_name', 'contact_phone', 'contact_email', 'fein',
    'entity_type', 'business_description', 'effective_date', 'expiration_date',
  ] as const;

  const customer = Object.fromEntries(
    customerFields.map((f) => [f, mergeCustomerField(f, sources)]),
  ) as MergedCustomer;

  // Group every line across every file by coverage type.
  const byType = new Map<LineType, Array<{ line: CoverageLine; source: ExtractionSource }>>();
  for (const source of sources) {
    for (const line of source.result.lines) {
      const bucket = byType.get(line.line_type) ?? [];
      bucket.push({ line, source });
      byType.set(line.line_type, bucket);
    }
  }

  const lines: MergedLine[] = [];
  for (const [line_type, entries] of byType) {
    if (entries.length === 1) {
      const { line, source } = entries[0];
      lines.push({
        line_type,
        line_type_label: line.line_type_label,
        carrier_name: line.carrier_name,
        premium: line.premium,
        premium_components: line.premium_components,
        details: line.details,
        admitted: line.admitted,
        schedules: line.schedules,
        options: line.options.map((o) => ({
          ...o,
          premium_components: o.premium_components,
          sourceFileId: source.fileId,
          sourceFilename: source.filename,
          fromSeparateFile: false,
        })),
        confidence: line.confidence,
        sourceFileIds: [source.fileId],
      });
      continue;
    }

    // Same coverage quoted in more than one file — competing carriers. Becomes one
    // line with an outstanding choice, never two sections of the same coverage.
    const best = [...entries].sort((a, b) => b.line.confidence - a.line.confidence)[0];
    const options: MergedLineOption[] = [];
    for (const entry of entries) {
      // A file that itself offered choices contributes each of them, so a broker
      // comparing two carriers still sees both of carrier A's limit options.
      if (entry.line.options.length > 0) {
        for (const o of entry.line.options) {
          options.push({
            ...o,
            label: `${entry.line.carrier_name ?? entry.source.filename} — ${o.label}`,
            sourceFileId: entry.source.fileId,
            sourceFilename: entry.source.filename,
            fromSeparateFile: true,
          });
        }
      } else {
        options.push(lineToOption(entry.line, entry.source));
      }
    }

    lines.push({
      line_type,
      line_type_label: best.line.line_type_label,
      carrier_name: null,          // ambiguous until the broker picks an option
      premium: null,               // price lives on the options
      premium_components: [],
      details: best.line.details,
      /*
       * Taken from the same quote `details` came from, not merged across the
       * competing files. Two carriers can write the same coverage on different
       * paper, and combining an admitted flag from one with a rating schedule
       * from the other would describe a policy that does not exist.
       */
      admitted: best.line.admitted,
      schedules: best.line.schedules,
      options,
      confidence: best.line.confidence,
      sourceFileIds: entries.map((e) => e.source.fileId),
    });
  }

  const carrierNames = [
    ...new Set(sources.flatMap((s) => s.result.carrier_names_seen).map((n) => n.trim()).filter(Boolean)),
  ];

  const notes = sources.flatMap((s) =>
    s.result.notes.map((note) => ({ fileId: s.fileId, filename: s.filename, note })),
  );

  return { customer, lines, carrierNames, notes };
}

/**
 * Everything standing between the current state and a generated document, phrased
 * for a broker rather than a developer. Drives the disabled Generate button.
 */
export function blockingReasons(merged: MergedProposal, includedTypes: Set<LineType>): string[] {
  const reasons: string[] = [];

  if (merged.lines.filter((l) => includedTypes.has(l.line_type)).length === 0) {
    reasons.push('No coverage lines are included.');
  }

  for (const line of merged.lines) {
    if (!includedTypes.has(line.line_type)) continue;

    if (line.options.length > 1) {
      reasons.push(`${label(line.line_type)}: choose one of ${line.options.length} quoted options.`);
    } else if (line.premium == null && line.options.length === 0) {
      reasons.push(`${label(line.line_type)}: no premium was found — enter one.`);
    }
  }

  if (!merged.customer.named_insured.value) {
    reasons.push('Named insured is missing.');
  }

  // Both halves of the policy period. The premium page prints them as a range,
  // and half a range prints as an em dash — see the note in detail.ts, which
  // must agree with this.
  if (!merged.customer.effective_date.value) {
    reasons.push('Effective date is missing.');
  }
  if (!merged.customer.expiration_date.value) {
    reasons.push('Expiration date is missing.');
  }

  for (const [field, cell] of Object.entries(merged.customer)) {
    if (cell.conflicts.length > 0) {
      reasons.push(`${label(field)}: files disagree — confirm which value is correct.`);
    }
  }

  return reasons;
}

function label(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
