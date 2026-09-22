import {
  sectionsForLine, blockingReasons as sharedBlockingReasons,
  type LineType, type LineDetail, type PremiumComponent,
  type ProposalDetail, type ReviewCustomer, type ReviewLine, type ReviewLineOption,
  type ReviewRecommendation, type CustomerFieldName, type ProposalTotals,
  type ProposalFile, type ReviewDisclaimer, type LineSchedules, type Premise,
  addMoney, sumBy, centsApart, roundMoney,
} from '@safeside/shared';
import type { Db } from '../db/index.ts';
import { getOwnedProposal } from '../db/scoped.ts';

const CUSTOMER_FIELDS: CustomerFieldName[] = [
  'named_insured', 'dba', 'mailing_address', 'location_address',
  'contact_name', 'contact_phone', 'contact_email', 'fein',
  'entity_type', 'business_description', 'effective_date', 'expiration_date',
];

const SECTION_TITLES: Record<string, string> = {
  general_liability: 'General Liability Coverage',
  property: 'Property Coverage',
  workers_comp: 'Workers Compensation Coverage',
  disability_pfl: 'Disability / Paid Family Leave Coverage',
};

/** Postgres numerics come back as strings; money must be a number on the wire. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * A `date` column as a yyyy-mm-dd string.
 *
 * The Date branch reads LOCAL components, never .toISOString(). A driver that
 * hands back a `date` as a JS Date builds it at local midnight, so asking for
 * the UTC calendar day returns yesterday on every machine ahead of UTC. See the
 * date type parser in db/index.ts for the bug this pairs with.
 */
export function isoDate(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

/**
 * Assemble everything the review screen needs in one response.
 *
 * One round trip rather than a request per line: the screen shows all of it at
 * once, and a broker opening a proposal with six coverage lines should not wait
 * on seven sequential fetches.
 */
export async function loadProposalDetail(
  db: Db,
  userId: string,
  proposalId: string,
): Promise<ProposalDetail> {
  const proposal = await getOwnedProposal(db, userId, proposalId);

  const [customerRows, lineRows, optionRows, detailRows, fileRows, recRows, extractionRows, titleRows,
         disclaimerRows] =
    await Promise.all([
      db.query(`select * from sp_customers where proposal_id = $1`, [proposalId]),
      db.query(`select * from sp_lines where proposal_id = $1 order by display_order, created_at`, [proposalId]),
      db.query(
        `select o.* from sp_line_options o
           join sp_lines l on l.id = o.line_id
          where l.proposal_id = $1 order by o.display_order`, [proposalId]),
      db.query(
        `select d.* from sp_line_details d
           join sp_lines l on l.id = d.line_id
          where l.proposal_id = $1 order by d.kind, d.display_order`, [proposalId]),
      db.query(
        `select id, original_filename, size_bytes, page_count, extraction_status, error_text, created_at
           from sp_files where proposal_id = $1 order by created_at`, [proposalId]),
      db.query(
        `select r.id, r.label, r.body, r.suggest_when_line_absent, r.display_order,
                pr.proposal_id is not null as selected, pr.body_override
           from sp_recommendations r
           left join sp_proposal_recommendations pr
             on pr.recommendation_id = r.id and pr.proposal_id = $1
          where r.is_active = true
          order by r.display_order`, [proposalId]),
      db.query(
        `select f.original_filename, e.parsed
           from sp_extractions e join sp_files f on f.id = e.file_id
          where e.proposal_id = $1 and e.status = 'succeeded' and e.parsed is not null`, [proposalId]),
      db.query(`select code, section_title from sp_line_types`),
      db.query(
        `select d.id, d.label, d.body, d.default_on, d.display_order,
                pd.proposal_id is not null as selected
           from sp_premium_disclaimers d
           left join sp_proposal_disclaimers pd
             on pd.disclaimer_id = d.id and pd.proposal_id = $1
          where d.is_active = true
          order by d.display_order`, [proposalId]),
    ]);

  const titles: Record<string, string> = { ...SECTION_TITLES };
  for (const r of titleRows.rows as Array<{ code: string; section_title: string }>) {
    titles[r.code] = r.section_title;
  }

  /* --- customer ---------------------------------------------------------- */

  const customerRow = customerRows.rows[0] as Record<string, unknown> | undefined;
  const meta = (customerRow?.field_meta ?? {}) as Record<string, {
    found?: boolean; confidence?: number; edited?: boolean;
    conflicts?: Array<{ value: string; file_id: string; filename: string }>;
  }>;

  const customer = Object.fromEntries(
    CUSTOMER_FIELDS.map((field) => {
      const raw = customerRow?.[field];
      const value = field.endsWith('_date') ? isoDate(raw) : (raw as string | null) ?? null;
      const m = meta[field] ?? {};
      return [field, {
        value,
        found: m.found ?? value !== null,
        confidence: m.confidence ?? (value !== null ? 1 : 0),
        conflicts: m.conflicts ?? [],
        edited: m.edited ?? false,
      }];
    }),
  ) as ReviewCustomer;

  /* --- lines ------------------------------------------------------------- */

  const optionsByLine = new Map<string, ReviewLineOption[]>();
  for (const o of optionRows.rows as Array<Record<string, unknown>>) {
    const summary = (o.summary ?? {}) as {
      premium_components?: PremiumComponent[]; details?: LineDetail[];
      source_filename?: string | null; from_separate_file?: boolean;
    };
    const list = optionsByLine.get(o.line_id as string) ?? [];
    list.push({
      id: o.id as string,
      label: o.label as string,
      carrier_premium: num(o.carrier_premium),
      premium_components: summary.premium_components ?? [],
      details: summary.details ?? [],
      source_filename: summary.source_filename ?? null,
      from_separate_file: summary.from_separate_file ?? false,
    });
    optionsByLine.set(o.line_id as string, list);
  }

  const detailsByLine = new Map<string, LineDetail[]>();
  for (const d of detailRows.rows as Array<Record<string, unknown>>) {
    const list = detailsByLine.get(d.line_id as string) ?? [];
    list.push({
      kind: d.kind as LineDetail['kind'],
      label: d.label as string,
      value: (d.value as string | null) ?? null,
      confidence: d.confident ? 0.95 : 0.5,
      // Read from the row, not hardcoded null. While this was null the keyword
      // classifier in sections.ts ran on every detail and quietly dropped the
      // ones it could not place — the property deductible among them.
      section_hint: (d.section_hint as 'liability' | 'property' | null) ?? null,
    });
    detailsByLine.set(d.line_id as string, list);
  }

  const lines: ReviewLine[] = (lineRows.rows as Array<Record<string, unknown>>).map((l) => {
    const id = l.id as string;
    const options = optionsByLine.get(id) ?? [];
    const selectedOptionId = (l.selected_option_id as string | null) ?? null;
    const selected = options.find((o) => o.id === selectedOptionId) ?? null;

    // When an option is chosen its price is the line's price. Until then the line
    // has no price, which is what blocks generation.
    const carrierPremium = options.length > 0 ? selected?.carrier_premium ?? null : num(l.carrier_premium);
    const brokerFee = roundMoney(num(l.broker_fee));
    /*
     * An option's breakdown when one is chosen, otherwise the line's own.
     *
     * This used to read the option only, so for a line with no options — the
     * ordinary case — components were always empty and the reconciliation check
     * below could never fire. It stayed silent on a real property line
     * whose own breakdown summed to $78,644 against a stored premium of $70,949.
     */
    const components = selected
      ? selected.premium_components
      : ((l.premium_components as PremiumComponent[] | null) ?? []);

    // Compared in cents. A float comparison here is precisely the drift this
    // check is meant to detect, and it would report a reconciled quote as broken.
    const sum = sumBy(components, (c) => c.amount);
    const unreconciled =
      components.length > 0 && carrierPremium !== null && centsApart(sum, carrierPremium) > 0;

    return {
      id,
      line_type: l.line_type as LineType,
      line_type_label: (l.line_type_label as string | null) ?? null,
      section_titles: sectionsForLine(l.line_type as LineType).map((c) => titles[c] ?? c),
      included: Boolean(l.included),
      carrier_name: (l.carrier_name as string | null) ?? null,
      carrier_premium: carrierPremium,
      premium_components: components,
      broker_fee: brokerFee,
      combined_price: carrierPremium === null ? null : addMoney(carrierPremium, brokerFee),
      options,
      selected_option_id: selectedOptionId,
      details: selected && selected.details.length > 0 ? selected.details : detailsByLine.get(id) ?? [],
      admitted: (l.admitted as string | null) ?? null,
      schedules: (l.schedules as LineSchedules | null) ?? null,
      confidence: 0.9,
      display_order: Number(l.display_order ?? 100),
      components_unreconciled: unreconciled,
    };
  });

  /* --- everything else --------------------------------------------------- */

  const recommendations: ReviewRecommendation[] = (recRows.rows as Array<Record<string, unknown>>).map((r) => {
    const trigger = r.suggest_when_line_absent as string | null;
    return {
      id: r.id as string,
      label: r.label as string,
      body: r.body as string,
      suggested: Boolean(trigger) && !lines.some((l) => l.line_type === trigger && l.included),
      selected: Boolean(r.selected),
      body_override: (r.body_override as string | null) ?? null,
    };
  });

  /*
   * A proposal nobody has touched falls back to the library's own defaults, so a
   * broker who never opens this control still gets the clause that appears on
   * three of Safeside's four sample proposals. Once a selection is saved the saved
   * state wins — including an empty one, which is why this reads a flag on the
   * proposal rather than counting rows. Counting rows cannot tell "not yet chosen"
   * from "chose none", and the default would silently come back.
   */
  const anySaved = Boolean(proposal.disclaimers_chosen);
  const disclaimers: ReviewDisclaimer[] = (disclaimerRows.rows as Array<Record<string, unknown>>).map((d) => ({
    id: d.id as string,
    label: d.label as string,
    body: d.body as string,
    selected: anySaved ? Boolean(d.selected) : Boolean(d.default_on),
  }));

  const notes: Array<{ filename: string; note: string }> = [];
  const carrierNames = new Set<string>();
  /*
   * Premises come from whichever quotes schedule them, so two files covering the
   * same business contribute the same address twice. Keyed on the address itself
   * rather than the location number, which differs between carriers.
   */
  const premises: Premise[] = [];
  const premiseSeen = new Set<string>();
  for (const row of extractionRows.rows as Array<{ original_filename: string; parsed: unknown }>) {
    const parsed = row.parsed as
      { notes?: string[]; carrier_names_seen?: string[]; premises?: Premise[] } | null;
    for (const n of parsed?.notes ?? []) notes.push({ filename: row.original_filename, note: n });
    for (const c of parsed?.carrier_names_seen ?? []) carrierNames.add(c);
    for (const pr of parsed?.premises ?? []) {
      const key = `${pr.address}::${pr.city ?? ''}::${pr.zip ?? ''}`.toLowerCase().replace(/\s+/g, ' ');
      if (premiseSeen.has(key)) continue;
      premiseSeen.add(key);
      premises.push(pr);
    }
  }

  /*
   * A saved premise schedule wins outright.
   *
   * The merge above is the starting point — what the quotes happened to
   * schedule. Once a broker has edited the table, that is the answer, including
   * when they have deleted every row: falling back to extraction there would
   * quietly restore the rows they just removed. `null` means never touched,
   * which is the same distinction sp_proposals.disclaimers_chosen draws.
   */
  const savedPremises = customerRow?.premises as Premise[] | null | undefined;
  const effectivePremises = Array.isArray(savedPremises) ? savedPremises : premises;

  const files: ProposalFile[] = (fileRows.rows as Array<Record<string, unknown>>).map((f) => ({
    id: f.id as string,
    original_filename: f.original_filename as string,
    size_bytes: Number(f.size_bytes),
    page_count: f.page_count === null ? null : Number(f.page_count),
    extraction_status: f.extraction_status as ProposalFile['extraction_status'],
    error_text: (f.error_text as string | null) ?? null,
    created_at: new Date(f.created_at as string).toISOString(),
  }));

  const included = lines.filter((l) => l.included);
  const totals: ProposalTotals = {
    carrier_premium: sumBy(included, (l) => l.carrier_premium),
    broker_fee: sumBy(included, (l) => l.broker_fee),
    combined: sumBy(included, (l) => l.combined_price),
  };

  return {
    id: proposal.id,
    client_name: proposal.client_name,
    status: proposal.status,
    created_at: new Date(proposal.created_at).toISOString(),
    updated_at: new Date(proposal.updated_at).toISOString(),
    confirmed_at: proposal.confirmed_at ? new Date(proposal.confirmed_at).toISOString() : null,
    customer,
    lines,
    recommendations,
    recommendations_note: proposal.recommendations_note,
    disclaimers,
    premises: effectivePremises,
    terms_note: proposal.terms_note,
    files,
    notes,
    carrier_names: [...carrierNames],
    totals,
    blocking_reasons: blockingReasons(lines, customer, files),
  };
}

/**
 * Everything preventing generation, phrased for a broker.
 *
 * Reuses the shared rules for options and missing premiums, then adds the ones
 * that only exist once data is in the database.
 */
function blockingReasons(
  lines: ReviewLine[],
  customer: ReviewCustomer,
  files: ProposalFile[],
): string[] {
  const reasons: string[] = [];
  const included = lines.filter((l) => l.included);

  if (files.length === 0) reasons.push('No quote files have been uploaded.');
  if (files.some((f) => f.extraction_status === 'pending' || f.extraction_status === 'running')) {
    reasons.push('Extraction is still running.');
  }
  if (included.length === 0) reasons.push('No coverage lines are included.');

  for (const line of included) {
    const name = line.section_titles[0] ?? line.line_type;
    if (line.options.length > 1 && !line.selected_option_id) {
      reasons.push(`${name}: choose one of ${line.options.length} quoted options.`);
    } else if (line.carrier_premium === null) {
      reasons.push(`${name}: no premium was found — enter one.`);
    }
  }

  if (!customer.named_insured.value) reasons.push('Named insured is missing.');

  /*
   * The policy period, both halves of it.
   *
   * The premium page prints "Effective Term <from> – <to>", and a missing half
   * prints as an em dash: a real proposal came out reading "June 21, 2026 –
   * —". The quote genuinely never stated an expiry, so extraction was right to
   * flag rather than invent one — but the dates a policy runs between are
   * material to the client, and a document that shows only half of them is
   * incomplete rather than merely untidy. The broker knows the term; this makes
   * them say it.
   */
  if (!customer.effective_date.value) reasons.push('Effective date is missing.');
  if (!customer.expiration_date.value) reasons.push('Expiration date is missing.');

  for (const [field, cell] of Object.entries(customer)) {
    if (cell.conflicts.length > 0) {
      const label = field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      reasons.push(`${label}: files disagree — confirm which value is correct.`);
    }
  }

  return reasons;
}

export { sharedBlockingReasons };
