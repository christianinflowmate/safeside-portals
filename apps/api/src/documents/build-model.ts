import {
  buildSections, sectionsForLine,
  type ProposalDetail, type ProposalDocumentModel, type DocumentSection,
  type DocumentDetail, type DocumentPricedLine, type LineDetail, type LineType,
  type DocumentFormGroup,
  addMoney, sumBy,
} from '@safeside/shared';
import type { Db } from '../db/index.ts';
import { premiumPageTitle } from './content.ts';

/**
 * Turn confirmed proposal data into the client-facing document model.
 *
 * This is the boundary where internal data stops. Everything carrier-shaped —
 * carrier name, the premium/fee split, confidence, model notes — is dropped here
 * by simply not being copied across, because ProposalDocumentModel has nowhere to
 * put it.
 *
 * A packaged line becomes more than one section (a BOP prints as General
 * Liability plus Property) while remaining ONE row in the pricing table. That
 * asymmetry is the reason `priced_lines` and `sections` are separate lists.
 */

/**
 * How a descriptions page names its coverage: "Property Key Coverage
 * Descriptions". Taken from Safeside's own page titles, which abbreviate workers
 * compensation and drop the "Business " prefix the section headings carry.
 */
const DESCRIPTION_GROUP: Record<string, string> = {
  general_liability: 'General Liability',
  property: 'Property',
  workers_comp: 'Workers Comp',
  disability_pfl: 'Disability / Paid Family Leave',
};

/**
 * How the forms page names a policy: Safeside's reads "Businessowners Policy:".
 * Policy-form wording, which differs from both the section headings and the
 * premium table — and deliberately not the carrier's own line_type_label, which
 * frequently contains the carrier's name.
 */
const FORMS_GROUP_LABEL: Partial<Record<LineType, string>> = {
  business_owners_policy: 'Businessowners Policy',
  general_liability: 'General Liability',
  property: 'Property',
  workers_comp: 'Workers Compensation',
  disability_pfl: 'Disability / Paid Family Leave',
  commercial_auto: 'Commercial Auto',
  umbrella: 'Umbrella',
  excess_liability: 'Excess Liability',
  professional_liability: 'Professional Liability',
  errors_omissions: 'Errors & Omissions',
  cyber: 'Cyber Liability',
  crime: 'Commercial Crime',
  inland_marine: 'Inland Marine',
  flood: 'Flood',
  employment_practices: 'Employment Practices Liability',
  liquor_liability: 'Liquor Liability',
};

/** How the premium table prints the regulatory status. */
const ADMITTED_LABEL: Record<string, string> = {
  admitted: 'Admitted',
  non_admitted: 'Non Admitted',
};

/** Summary-table wording, which differs from the section headings. */
const PRICED_LINE_LABEL: Partial<Record<LineType, string>> = {
  business_owners_policy: 'Business Owner Property',
  general_liability: 'General Liability',
  property: 'Property',
  workers_comp: 'Workers Compensation',
  disability_pfl: 'Disability / Paid Family Leave',
  commercial_auto: 'Commercial Auto',
  umbrella: 'Umbrella',
  excess_liability: 'Excess Liability',
  professional_liability: 'Professional Liability',
  errors_omissions: 'Errors & Omissions',
  cyber: 'Cyber Liability',
  crime: 'Commercial Crime',
  inland_marine: 'Inland Marine',
  flood: 'Flood',
  employment_practices: 'Employment Practices Liability',
  liquor_liability: 'Liquor Liability',
};

export async function buildDocumentModel(
  db: Db,
  detail: ProposalDetail,
): Promise<ProposalDocumentModel> {
  const included = detail.lines.filter((l) => l.included);

  /* --- section titles from the database, falling back to the code --------- */

  const { rows: typeRows } = await db.query<{ code: string; section_title: string }>(
    `select code, section_title from sp_line_types`,
  );
  const titles = new Map(typeRows.map((r) => [r.code, r.section_title]));
  const titleFor = (code: string) => titles.get(code) ?? humanise(code);

  /* --- coverage pages ----------------------------------------------------- */

  const sections: DocumentSection[] = [];
  for (const line of included) {
    sections.push(...buildSections(
      {
        lineType: line.line_type,
        details: line.details,
        schedules: line.schedules,
        // Proposal-level, but Safeside prints it on the property page.
        premises: detail.premises,
      },
      titleFor,
      // The client document carries the headline limits; the review screen keeps
      // all of them. See isHeadlineDetail in packages/shared/src/sections.ts.
      { headlineOnly: true },
    ));
  }

  /* --- pricing table ------------------------------------------------------ */

  const priced_lines: DocumentPricedLine[] = included.map((line) => ({
    label: PRICED_LINE_LABEL[line.line_type] ?? humanise(line.line_type),
    // Regulatory status of the policy, not the carrier's identity. Null whenever
    // the quote did not state it, and the column is then dropped rather than
    // printed blank — a guessed "Admitted" is a claim about guaranty-fund
    // protection that nobody made.
    admitted: ADMITTED_LABEL[line.admitted ?? ''] ?? null,
    // Carrier premium and broker fee are combined HERE, once. No code path hands
    // the template two numbers and asks it to add them, because that is a path
    // that can render them separately by mistake.
    price: addMoney(line.carrier_premium, line.broker_fee),
  }));

  const total = sumBy(priced_lines, (l) => l.price);

  /* --- forms, endorsements and exclusions, grouped by policy --------------- */

  /*
   * A carrier's schedule lists what the client bought AND what they were offered
   * and declined, the latter marked "Coverage not Selected". Printing both under
   * a heading reading "Forms, Endorsements, Exclusions" tells a client they have
   * Hired Auto and Garagekeepers when they bought neither. Safeside's own
   * proposals carry none of them, and on a real quote this was 22 rows of 61.
   */
  const DECLINED = /\b(not|non)[\s-]*(selected|covered|included|purchased)\b|\bdeclined\b/i;

  const forms_and_exclusions: DocumentFormGroup[] = [];
  const seen = new Set<string>();
  for (const line of included) {
    const items: string[] = [];
    for (const d of line.details as LineDetail[]) {
      if (d.kind !== 'endorsement' && d.kind !== 'exclusion' && d.kind !== 'form') continue;
      if (DECLINED.test(d.value ?? '')) continue;
      // The same form on two lines prints once, under the first.
      const key = d.label.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(d.label);
    }
    if (items.length > 0) {
      forms_and_exclusions.push({ group: FORMS_GROUP_LABEL[line.line_type] ?? humanise(line.line_type), items });
    }
  }

  /* --- standing copy for the Key Coverage Descriptions pages -------------- */

  const codes = [...new Set(included.flatMap((l) => sectionsForLine(l.line_type)))];
  const { rows: descRows } = await db.query<
    { line_type: string; heading: string; body: string; is_draft: boolean }
  >(
    `select line_type, heading, body, coalesce(is_draft, false) as is_draft
       from sp_coverage_descriptions
      where is_active = true and line_type = any($1::text[])
      order by line_type, display_order`,
    [codes],
  );

  /* --- premium-page disclaimers the broker selected ------------------------ */

  const premium_disclaimers = detail.disclaimers.filter((d) => d.selected).map((d) => d.body);

  /* --- recommendations the broker selected -------------------------------- */

  const recommendations = detail.recommendations
    .filter((r) => r.selected)
    .map((r) => ({ label: r.label, body: r.body_override ?? r.body }));

  const c = detail.customer;
  const value = (k: keyof typeof c) => c[k].value;

  return {
    client_name: detail.client_name,
    prepared_on: new Date().toISOString().slice(0, 10),
    effective_date: value('effective_date'),
    expiration_date: value('expiration_date'),
    customer: {
      named_insured: value('named_insured'),
      dba: value('dba'),
      mailing_address: value('mailing_address'),
      location_address: value('location_address'),
      contact_name: value('contact_name'),
      contact_phone: value('contact_phone'),
      contact_email: value('contact_email'),
      entity_type: value('entity_type'),
      business_description: value('business_description'),
      effective_date: value('effective_date'),
      expiration_date: value('expiration_date'),
      fein: value('fein'),
    },
    premium_page_title: premiumPageTitle(included.map((l) => l.line_type)),
    priced_lines,
    sections,
    total,
    premium_disclaimers,
    coverage_descriptions: orderDescriptions(descRows.map((r) => ({
      // The "Business " prefix belongs to the section headings, not to a
      // descriptions page: theirs reads "General Liability Key Coverage
      // Descriptions", never "Business General Liability Key Coverage".
      group: DESCRIPTION_GROUP[r.line_type]
        ?? titleFor(r.line_type).replace(/^Business /, '').replace(/ Coverage$/, ''),
      heading: r.heading, body: r.body, is_draft: r.is_draft,
    }))),
    forms_and_exclusions,
    recommendations,
    terms_note: detail.terms_note,
    recommendations_note: detail.recommendations_note,
  };
}

/**
 * Safeside runs the descriptions Property, General Liability, Workers Comp —
 * consistently across their proposals, and not the order the coverage pages come
 * in. Anything unlisted keeps its position after those.
 */
const DESCRIPTION_ORDER = ['Property', 'General Liability', 'Workers Comp'];

function orderDescriptions<T extends { group: string }>(rows: T[]): T[] {
  const rank = (g: string) => {
    const i = DESCRIPTION_ORDER.indexOf(g);
    return i === -1 ? DESCRIPTION_ORDER.length : i;
  };
  // Stable: rows within a group keep their display_order from the query.
  return [...rows].sort((a, b) => rank(a.group) - rank(b.group));
}

function humanise(code: string): string {
  return code.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}
