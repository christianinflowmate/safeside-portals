/**
 * One description of every schedule table, used by both halves of the system.
 *
 * A schedule is a table on a coverage page — Liability Classification, Subjects
 * of Insurance, the workers compensation rating basis, and so on. The renderer
 * turns rows into a printed table; the review screen turns the same rows into
 * editable inputs. Those two had no reason to agree on column order or headings
 * beyond someone remembering to change both, so they share this instead.
 *
 * Kept deliberately flat: every schedule row is an object of nullable strings,
 * which is what lets one editor serve all seven. Figures are strings on purpose
 * — an exposure is reproduced as the carrier printed it, commas and currency
 * sign included, and is never arithmetic.
 */

export type ScheduleKind =
  | 'classifications'
  | 'subjects_of_insurance'
  | 'states'
  | 'employers_liability'
  | 'rating_basis'
  | 'individuals'
  | 'premises';

export interface ScheduleColumn {
  /** Field name on the row object. */
  key: string;
  /** Column heading, as it prints and as the editor labels the input. */
  label: string;
}

export interface ScheduleSpec {
  kind: ScheduleKind;
  /** Caption above the printed table. */
  caption: string;
  columns: ScheduleColumn[];
  /**
   * The one column that must be filled in for a row to mean anything. A row
   * whose required column is blank is dropped on save rather than printed as an
   * empty line in a client's document.
   */
  required: string;
  /**
   * Which coverage page it belongs to, for grouping the editor. 'customer' means
   * it belongs to the insured rather than to any one policy.
   */
  owner: 'general_liability' | 'property' | 'workers_comp' | 'customer';
  /**
   * True when rows are plain strings rather than objects — only `states`, which
   * is a list of two-letter codes. The editor stores them under the single
   * column's key and flattens on save.
   */
  scalar?: boolean;
}

export const SCHEDULE_SPECS: Record<ScheduleKind, ScheduleSpec> = {
  classifications: {
    kind: 'classifications',
    caption: 'Liability Classification',
    owner: 'general_liability',
    required: 'classification',
    columns: [
      { key: 'location', label: 'Location #' },
      { key: 'classification', label: 'Classification' },
      { key: 'class_code', label: 'Class Code' },
      { key: 'exposure', label: 'Exposure' },
      { key: 'rating_basis', label: 'Rating Basis' },
    ],
  },
  subjects_of_insurance: {
    kind: 'subjects_of_insurance',
    caption: 'Subjects of Insurance',
    owner: 'property',
    required: 'subject',
    columns: [
      { key: 'location', label: 'Location #' },
      { key: 'building', label: 'Building #' },
      { key: 'subject', label: 'Subject of Insurance' },
      { key: 'limit', label: 'Limit' },
      { key: 'coinsurance', label: 'Coins. %' },
      { key: 'valuation', label: 'Valuation' },
      { key: 'cause_of_loss', label: 'Cause of Loss' },
      { key: 'deductible', label: 'Deductible' },
    ],
  },
  premises: {
    kind: 'premises',
    caption: 'Premise Information',
    owner: 'customer',
    required: 'address',
    columns: [
      { key: 'location', label: 'Location #' },
      { key: 'address', label: 'Address' },
      { key: 'city', label: 'City' },
      { key: 'state', label: 'State' },
      { key: 'zip', label: 'Zip' },
    ],
  },
  states: {
    kind: 'states',
    caption: 'States',
    owner: 'workers_comp',
    required: 'state',
    scalar: true,
    columns: [{ key: 'state', label: 'State' }],
  },
  employers_liability: {
    kind: 'employers_liability',
    caption: 'Employers Liability',
    owner: 'workers_comp',
    required: 'coverage',
    columns: [
      { key: 'coverage', label: 'Coverage' },
      { key: 'limit', label: 'Limit' },
      { key: 'disease_policy_limit', label: 'Disease Policy Limit' },
      { key: 'disease_each_employee', label: 'Disease Each Employee' },
    ],
  },
  rating_basis: {
    kind: 'rating_basis',
    caption: 'Workers Comp Rating Basis',
    owner: 'workers_comp',
    required: 'description',
    columns: [
      { key: 'location', label: 'Location' },
      { key: 'state', label: 'State' },
      { key: 'class_code', label: 'Class Code' },
      { key: 'description', label: 'Description' },
      { key: 'exposure', label: 'Exposure' },
      { key: 'basis', label: 'Rating Basis' },
    ],
  },
  individuals: {
    kind: 'individuals',
    caption: 'Individuals Included/Excluded',
    owner: 'workers_comp',
    required: 'name',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'title', label: 'Title/Relationship' },
      { key: 'status', label: 'Include/Exclude' },
    ],
  },
};

/** The schedules that belong on a given line's coverage pages. */
export function schedulesForOwner(owner: ScheduleSpec['owner']): ScheduleSpec[] {
  return Object.values(SCHEDULE_SPECS).filter((s) => s.owner === owner);
}

/** Drop rows whose required column is empty, and trim what is left. */
export function cleanScheduleRows(
  spec: ScheduleSpec,
  rows: Array<Record<string, unknown>>,
): Array<Record<string, string | null>> {
  const out: Array<Record<string, string | null>> = [];
  for (const row of rows) {
    const required = String(row[spec.required] ?? '').trim();
    if (required === '') continue;
    const clean: Record<string, string | null> = {};
    for (const col of spec.columns) {
      const raw = String(row[col.key] ?? '').trim();
      clean[col.key] = raw === '' ? null : raw;
    }
    // The required column is never null by construction above.
    clean[spec.required] = required;
    out.push(clean);
  }
  return out;
}
