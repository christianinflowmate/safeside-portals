import type { LineType, LineDetail, LineSchedules, Premise } from './extraction.ts';
import type { DocumentSection, DocumentDetail, DocumentTable } from './document-model.ts';
import { SCHEDULE_SPECS, type ScheduleKind } from './schedule-spec.ts';

/**
 * Mapping priced lines onto coverage pages.
 *
 * The brief assumes one section per line. Safeside's proposals do not: a client
 * with a BOP quote and a WC quote gets four coverage pages, because the packaged
 * BOP is presented as its liability and property halves.
 *
 * Only packaged lines decompose. Everything else maps one-to-one, so this stays
 * a small table rather than a general rules engine.
 */

export type SectionCode =
  | 'general_liability' | 'property' | 'workers_comp' | 'disability_pfl'
  | 'commercial_auto' | 'umbrella' | 'excess_liability' | 'professional_liability'
  | 'errors_omissions' | 'cyber' | 'crime' | 'inland_marine' | 'flood'
  | 'employment_practices' | 'liquor_liability' | 'other';

/** Lines that render as more than one coverage page. */
const DECOMPOSES: Partial<Record<LineType, SectionCode[]>> = {
  business_owners_policy: ['general_liability', 'property'],
};

/** Which half of a decomposed line each section takes. */
const SECTION_HALF: Partial<Record<SectionCode, 'liability' | 'property'>> = {
  general_liability: 'liability',
  property: 'property',
};

export function sectionsForLine(lineType: LineType): SectionCode[] {
  return DECOMPOSES[lineType] ?? [lineType as SectionCode];
}

export function decomposes(lineType: LineType): boolean {
  return lineType in DECOMPOSES;
}

/**
 * Fallback classifier for details the model did not tag.
 *
 * `section_hint` from extraction is authoritative — the model saw the document.
 * This exists only for older extractions predating the hint, and for the case
 * where the model genuinely could not tell. Keyword matching on carrier wording
 * is exactly the brittle approach the hint replaces, so it is a safety net and
 * not the mechanism.
 */
const LIABILITY_WORDS = [
  'occurrence', 'aggregate', 'liability', 'products', 'completed operations',
  'personal &', 'personal and advertising', 'advertising injury', 'medical expense',
  'damage to premises', 'damage to rented', 'fire legal', 'bodily injury',
];

const PROPERTY_WORDS = [
  'building', 'business personal property', 'personal property', 'business income',
  'equipment breakdown', 'water back', 'sump', 'signs', 'contents', 'stock',
  'spoilage', 'glass', 'theft', 'money and securities', 'extra expense',
  'ordinance or law', 'debris removal', 'outdoor',
];

export function classifyDetail(detail: Pick<LineDetail, 'label' | 'section_hint'>): 'liability' | 'property' | null {
  if (detail.section_hint) return detail.section_hint;

  const label = detail.label.toLowerCase();
  // Property first: "Business Personal Property" contains neither a liability
  // keyword nor an ambiguous one, but several property phrases embed words that
  // also appear in liability labels.
  if (PROPERTY_WORDS.some((w) => label.includes(w))) return 'property';
  if (LIABILITY_WORDS.some((w) => label.includes(w))) return 'liability';
  return null;
}

export interface SectionInput {
  lineType: LineType;
  details: LineDetail[];
  /** The structured tables this line's quote scheduled. */
  schedules?: LineSchedules | null;
  /**
   * The insured's sites. Proposal-level rather than per line, but printed on the
   * property page, which is where Safeside puts it.
   */
  premises?: Premise[];
}

/**
 * The caption above a coverage page's limits table.
 *
 * Not one wording for all of them: Safeside's general liability page says "Limits
 * of Liability Table" and their workers compensation page says "Employers
 * Liability", and printing the liability caption over a property schedule — which
 * is what this used to do — reads as a copy-paste mistake to anyone who knows the
 * document.
 */
const LIMITS_CAPTION: Partial<Record<SectionCode, string>> = {
  general_liability: 'Limits of Liability Table',
  workers_comp: 'Employers Liability',
  property: 'Limits of Insurance',
};

const DEFAULT_LIMITS_CAPTION = 'Limits of Insurance';

export interface SectionTitleLookup {
  (code: SectionCode): string;
}

/**
 * Build the coverage pages for one priced line.
 *
 * For a decomposing line, each detail goes to the half it was tagged with.
 * Details that could not be classified go to the FIRST section rather than being
 * dropped — a limit missing from the proposal is a worse failure than a limit on
 * the wrong page, because a broker proofreading will catch the second and not the
 * first.
 */
export function buildSections(
  { lineType, details, schedules, premises }: SectionInput,
  titleFor: SectionTitleLookup,
  { headlineOnly = false }: { headlineOnly?: boolean } = {},
): DocumentSection[] {
  const codes = sectionsForLine(lineType);

  const toDoc = (d: LineDetail): DocumentDetail => ({ label: d.label, value: d.value });
  const empty = (code: SectionCode): DocumentSection => ({
    section_title: titleFor(code),
    limits_caption: LIMITS_CAPTION[code] ?? DEFAULT_LIMITS_CAPTION,
    limits: [], deductibles: [], endorsements: [], exclusions: [], conditions: [],
    tables: [],
  });

  const place = (section: DocumentSection, d: LineDetail, code: SectionCode) => {
    if (headlineOnly) {
      /*
       * A coverage page in Safeside's proposal carries limits and deductibles and
       * nothing else. Every endorsement, exclusion and form is gathered onto the
       * "Forms, Endorsements & Exclusions" page instead, which is why their
       * General Liability page fits on one sheet and ours was running to three.
       */
      if (d.kind === 'endorsement' || d.kind === 'exclusion' ||
          d.kind === 'form' || d.kind === 'condition') return;
      if (!isHeadlineDetail(code, d.label)) return;
    }
    const doc = toDoc(d);
    switch (d.kind) {
      case 'limit': section.limits.push(doc); break;
      case 'deductible': section.deductibles.push(doc); break;
      case 'endorsement': section.endorsements.push(doc); break;
      case 'exclusion': section.exclusions.push(doc); break;
      case 'form': section.endorsements.push(doc); break;
      case 'condition': section.conditions.push(doc); break;
    }
  };

  if (codes.length === 1) {
    const section = empty(codes[0]);
    for (const d of details) place(section, d, codes[0]);
    dedupe(section);
    attachTables(section, codes[0], schedules, premises);
    return [section];
  }

  const sections = codes.map(empty);
  for (const d of details) {
    const half = classifyDetail(d);
    const index = codes.findIndex((c) => SECTION_HALF[c] === half);
    const at = index === -1 ? 0 : index;
    place(sections[at], d, codes[at]);
  }

  for (const s of sections) dedupe(s);
  sections.forEach((s, i) => attachTables(s, codes[i], schedules, premises));

  /*
   * A section that ended up with nothing is not printed. A BOP quoting no
   * property limits should not produce an empty Property page.
   *
   * Premises do not count as content. They are the insured's addresses, which
   * belong to the business rather than to any coverage, and a Hartford BOP that
   * priced liability and scheduled no property produced a whole Business
   * Property sheet carrying one address and nothing else — a page of white space
   * where Safeside's own proposal for the same quote has no page at all.
   */
  const PREMISES_CAPTION = SCHEDULE_SPECS.premises.caption;
  return sections.filter((s) => {
    const ownTables = s.tables.filter((t) => t.caption !== PREMISES_CAPTION);
    const hasContent = s.limits.length || s.deductibles.length || s.endorsements.length ||
                       s.exclusions.length || s.conditions.length || ownTables.length;
    return hasContent;
  });
}

/* -------------------------------------------------------------------------- */
/* Which limits reach the client document                                      */
/* -------------------------------------------------------------------------- */

/**
 * Extraction is thorough; the proposal is not.
 *
 * A BOP quote yields around a hundred detail rows, and a broker reviewing it
 * wants all of them. Safeside's own coverage pages carry six limits for General
 * Liability and three subjects for Property — the headline terms, with the rest
 * left to the policy. Printing everything makes each section spill across two or
 * three pages and reads nothing like their document.
 *
 * These patterns are read off Safeside's own proposal, not chosen here. Anything
 * not matching stays visible on the review screen and is simply not printed.
 */
const HEADLINE_PATTERNS: Partial<Record<SectionCode, RegExp[]>> = {
  general_liability: [
    /general aggregate/i,
    /each occurrence/i,
    /products.*completed op/i,
    /personal\s*(&|and)\s*advertising/i,
    /fire damage|damage to (rented )?premises|fire legal/i,
    /medical (expense|payments)/i,
  ],
  property: [
    /business personal property(?!\s*supplemental)/i,
    /^building/i,
    /equipment breakdown$/i,
    /water back|sump/i,
    /business income(?!.*billable|.*web)/i,
    /property deductible|^deductible/i,
  ],
  workers_comp: [
    /employers liability/i,
    /each accident/i,
    /disease.*(policy|employee)/i,
  ],
  disability_pfl: [
    /disability|paid family leave|statutory/i,
  ],
};

/**
 * Should this row print in the client document?
 *
 * Defaults to TRUE for any coverage type without a curated list. Dropping a limit
 * from a client's proposal is a worse failure than printing one too many, so the
 * absence of a rule means print it.
 */
export function isHeadlineDetail(section: SectionCode, label: string): boolean {
  const patterns = HEADLINE_PATTERNS[section];
  if (!patterns) return true;
  return patterns.some((re) => re.test(label));
}

/** Coverage types with a curated headline list. */
export function hasHeadlineList(section: SectionCode): boolean {
  return section in HEADLINE_PATTERNS;
}

/**
 * Drop rows that say the same thing twice.
 *
 * Carriers list both "Damage to Premises Rented to You" and "Broadened Coverage
 * For Damage to Premises Rented to You" at the same limit; printing both reads as
 * a mistake. Where one label contains another and the values match, the shorter
 * one wins — it is the headline term, and the longer is the endorsement that
 * grants it.
 */
function dedupe(section: DocumentSection): void {
  const prune = (rows: DocumentDetail[]): DocumentDetail[] => {
    const keep: DocumentDetail[] = [];
    for (const row of rows) {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const a = norm(row.label);

      const redundant = rows.some((other) => {
        if (other === row) return false;
        const b = norm(other.label);
        if (a === b) return rows.indexOf(other) < rows.indexOf(row);  // exact dup: keep the first
        // This row restates a shorter one at the same value.
        return b.length < a.length && a.includes(b) && other.value === row.value;
      });

      if (!redundant) keep.push(row);
    }
    return keep;
  };

  section.limits = prune(section.limits);
  section.deductibles = prune(section.deductibles);
  section.endorsements = prune(section.endorsements);
  section.exclusions = prune(section.exclusions);
  section.conditions = prune(section.conditions);
}

/* -------------------------------------------------------------------------- */
/* Canonical order of coverage lines                                           */
/* -------------------------------------------------------------------------- */

/**
 * The order Safeside presents lines in, on the premium table, the contents page
 * and the premium heading ("BOP/WC/DBL Premium and Subjectivities…").
 *
 * Without this, order follows whichever file happened to be uploaded first, so
 * the same two quotes produce "BOP/WC" or "WC/BOP" depending on the order the
 * broker dragged them in. It is a starting order only — display_order is stored
 * per line and the broker's own arrangement survives.
 *
 * Packages first, then the statutory lines a New York business must carry, then
 * excess sitting above them, then specialty.
 */
const LINE_ORDER: LineType[] = [
  'business_owners_policy', 'general_liability', 'property',
  'workers_comp', 'disability_pfl',
  'commercial_auto', 'umbrella', 'excess_liability',
  'professional_liability', 'errors_omissions', 'employment_practices',
  'cyber', 'crime', 'inland_marine', 'liquor_liability', 'flood',
  'other',
];

/** Rank for sorting. An unlisted type sorts last rather than first. */
export function lineRank(lineType: LineType): number {
  const i = LINE_ORDER.indexOf(lineType);
  return i === -1 ? LINE_ORDER.length : i;
}

/* -------------------------------------------------------------------------- */
/* Schedules on a coverage page                                                */
/* -------------------------------------------------------------------------- */

/**
 * Put each schedule on the page Safeside prints it on.
 *
 * Read off eleven of their proposals:
 *
 *   General Liability   Liability Classification
 *   Property            Premise Information, then Subjects of Insurance
 *   Workers Comp        States, Employers Liability, Rating Basis, Individuals
 *
 * None of these is ever a page of its own in their documents, which is the
 * mistake this replaces — Premise Information and Liability Classification were
 * being given their own sheets.
 *
 * Where a structured table carries the same figures as the plain limits list, the
 * list is dropped: Subjects of Insurance IS the property limits, and printing
 * both shows a client the same numbers twice in different shapes.
 */
function attachTables(
  section: DocumentSection,
  code: SectionCode,
  schedules?: LineSchedules | null,
  premises?: Premise[],
): void {
  const rowsOf = <T,>(xs: T[] | undefined, f: (x: T) => Array<string | null>) =>
    (xs ?? []).map(f);

  const add = (
    caption: string,
    headings: string[],
    rows: Array<Array<string | null>>,
    opts: { before?: boolean; note?: string | null } = {},
  ) => {
    if (rows.length === 0) return;
    const table: DocumentTable = { caption, headings, rows, note: opts.note ?? null };
    if (opts.before) section.tables.unshift(table);
    else section.tables.push(table);
  };

  const note = schedules?.note ?? null;

  /*
   * Caption, headings and column order all come from SCHEDULE_SPECS, which the
   * review screen's editor reads too. They used to be written out here and
   * nowhere else, so an edited schedule and a printed one agreed only for as
   * long as someone remembered to change both.
   */
  const spec = (kind: ScheduleKind) => SCHEDULE_SPECS[kind];
  const cells = (kind: ScheduleKind, rows: Array<Record<string, unknown>>) =>
    rows.map((r) => spec(kind).columns.map((c) => (r[c.key] ?? null) as string | null));

  const addSchedule = (
    kind: ScheduleKind,
    rows: Array<Record<string, unknown>> | undefined,
    opts: { before?: boolean; note?: string | null } = {},
  ) => add(spec(kind).caption, spec(kind).columns.map((c) => c.label),
           cells(kind, rows ?? []), opts);

  if (code === 'general_liability') {
    addSchedule('classifications', schedules?.classifications, { note });
  }

  if (code === 'property') {
    const subjects = schedules?.subjects_of_insurance ?? [];
    if (subjects.length > 0) {
      // The schedule states the limits AND the deductibles — both are columns of
      // it — so the plain lists would print the same figures a second time.
      section.limits = [];
      section.deductibles = [];
      addSchedule('subjects_of_insurance', subjects);
    }
    // Premise Information heads the page, above the subjects.
    addSchedule('premises', premises, { before: true });
  }

  if (code === 'workers_comp') {
    const el = schedules?.employers_liability ?? [];
    if (el.length > 0) {
      section.limits = [];
      addSchedule('employers_liability', el);
    }
    addSchedule('rating_basis', schedules?.rating_basis, { note });
    addSchedule('individuals', schedules?.individuals);
    // States heads the page in every workers compensation proposal of theirs.
    // Scalar: the rows are plain codes, so they are lifted into the one column.
    add(spec('states').caption, ['State'],
      rowsOf(schedules?.states, (st) => [st]),
      { before: true });
  }
}
