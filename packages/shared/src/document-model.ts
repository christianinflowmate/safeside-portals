/**
 * The client-facing document model.
 *
 * This is the ONLY shape the proposal template can read. It is not a list of
 * fields to avoid printing — it is a separate type that structurally cannot hold
 * carrier identity or the price split, because those properties do not exist on
 * it.
 *
 * A whitelist the renderer is trusted to consult is one forgotten line away from
 * leaking. A projection that drops fields on the way in cannot leak them however
 * the template is written, and a new column added upstream is invisible here
 * until someone deliberately adds it.
 *
 * Deliberately absent, each for a reason:
 *
 *   carrier_premium     the client sees one number, never the split
 *   broker_fee          same
 *   premium_components  carrier rating detail
 *   confidence          internal quality signal
 *   field_meta          internal provenance
 *   line_type_label     carrier wording, which often contains the carrier's name
 *
 * ── A priced line is not a section ──────────────────────────────────────────
 *
 * The brief assumes one section per coverage line. Safeside's own proposals do
 * not work that way. A client with a BOP quote and a WC quote gets FOUR coverage
 * sections — General Liability, Property, Workers Compensation, Disability/PFL —
 * because a packaged BOP is presented as its liability and property halves.
 *
 * And money appears in exactly one place. The coverage pages carry limits and
 * deductibles with no figures at all; every price sits in the summary table on
 * page 4, one row per PRICED LINE, totalled underneath.
 *
 * So the model has two separate lists. `priced_lines` drives the summary table.
 * `sections` drives the coverage pages. One BOP produces one priced line and two
 * sections, and there is no `price` on a section for a template to print by
 * mistake.
 */

/** A single limit, deductible or endorsement row as the client sees it. */
export interface DocumentDetail {
  label: string;
  value: string | null;
}

/**
 * A structured table on a coverage page.
 *
 * Generic rather than one interface per schedule: Safeside's pages carry seven
 * different tables between them and the template's job is the same for all of
 * them — caption, header band, rows. Shaping each one upstream keeps the column
 * order in one place per table instead of split between a type and a renderer.
 */
export interface DocumentTable {
  /** Printed above the table, e.g. "Premise Information". */
  caption: string;
  headings: string[];
  rows: Array<Array<string | null>>;
  /** Footnote printed under it, where the carrier supplied one. */
  note?: string | null;
}

/**
 * One coverage page. Carries no money — by construction, not by convention.
 *
 * `tables` holds the schedules this coverage prints: Liability Classification on
 * general liability, Premise Information and Subjects of Insurance on property,
 * States / Employers Liability / Rating Basis / Individuals on workers comp.
 * They live on the section rather than on their own pages because that is where
 * Safeside prints them — a standalone "Premise Information" page appears in none
 * of their eleven proposals.
 */
export interface DocumentSection {
  /** e.g. "General Liability Coverage". From sp_line_types.section_title. */
  section_title: string;
  /** Caption above the limits table; differs per coverage. */
  limits_caption: string;
  limits: DocumentDetail[];
  deductibles: DocumentDetail[];
  endorsements: DocumentDetail[];
  exclusions: DocumentDetail[];
  conditions: DocumentDetail[];
  tables: DocumentTable[];
}

/**
 * One row of the premium breakdown table on the summary page.
 */
export interface DocumentPricedLine {
  /** Line of business as the summary table names it, e.g. "Workers Compensation". */
  label: string;
  /**
   * Regulatory status, as the samples' "Admitted / Non Admitted" column prints it.
   *
   * This is a property of the POLICY and not of the carrier writing it, so the
   * brief's ban on carrier information does not reach it — a client is entitled to
   * know whether the state guaranty fund stands behind their coverage. The carrier
   * NAME and quote reference that sit beside it in the samples remain excluded.
   *
   * Null when the quote did not state it, and the whole column is then omitted
   * rather than printed blank.
   */
  admitted: string | null;
  /** Carrier premium plus broker fee, already combined. One number. */
  price: number;
}

export interface DocumentCustomer {
  named_insured: string | null;
  dba: string | null;
  mailing_address: string | null;
  location_address: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  entity_type: string | null;
  business_description: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  /**
   * The client's own FEIN, shown on the Named Insured page. Present because it is
   * the client's identifier, not a carrier's. Still sensitive: it must not appear
   * in logs, filenames or error messages.
   */
  fein: string | null;
}

/**
 * One row of the liability classification schedule.
 *
 * Carrier-supplied rating detail that nonetheless describes the INSURED's own
 * operations, which is why it crosses into the client document when the premium
 * and the rates behind it do not.
 */
export interface DocumentClassification {
  location: string | null;
  classification: string;
  class_code: string | null;
  exposure: string | null;
  rating_basis: string | null;
}

/** One row of the premise schedule. Entirely the client's own information. */
export interface DocumentPremise {
  location: string | null;
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/** One policy's forms, as a headed list. */
export interface DocumentFormGroup {
  /** e.g. "Businessowners Policy". */
  group: string;
  /** Form names, verbatim. */
  items: string[];
}

export interface DocumentRecommendation {
  label: string;
  body: string;
}

/** Standing copy for the Key Coverage Descriptions pages. */
export interface DocumentCoverageDescription {
  /**
   * The coverage this describes, as its page is titled: "Property", "General
   * Liability", "Workers Comp". Safeside gives each coverage its own descriptions
   * page rather than running them together under one generic heading.
   */
  group: string;
  heading: string;
  body: string;
  /**
   * True for placeholder wording awaiting Safeside's own voice. Marked in the
   * output rather than hidden: copy that reads as finished does not get
   * proofread, and this is the page most likely to go out unread.
   */
  is_draft: boolean;
}

export interface ProposalDocumentModel {
  client_name: string;
  prepared_on: string;
  /** Policy term as printed on the summary page. */
  effective_date: string | null;
  expiration_date: string | null;

  customer: DocumentCustomer;

  /**
   * Premium page heading, which names the lines quoted — Safeside's own reads
   * "BOP/WC/DBL Premium and Subjectivities Prior to Binding". Built upstream
   * because the template has no line types to build it from.
   */
  premium_page_title: string;

  /** Summary-page breakdown table, one row per priced line. */
  priced_lines: DocumentPricedLine[];
  /** Coverage pages. A packaged line may produce more than one. */
  sections: DocumentSection[];

  /** Sum of every priced line. The figure printed large on page 4. */
  total: number;

  /**
   * Premium-page disclaimers the broker selected.
   *
   * Selected, not fixed: across Safeside's own proposals these differ, and not by
   * line of business either — one proposal carrying a workers compensation line
   * has none of the payroll and audit clauses another one does. It is a broker
   * judgement, so it is chosen per proposal from a library like recommendations.
   */
  premium_disclaimers: string[];

  coverage_descriptions: DocumentCoverageDescription[];
  /**
   * Forms, endorsements and exclusions, grouped by the policy they belong to —
   * "Businessowners Policy:" then its list, as Safeside prints it.
   *
   * Names only, with no status column. A carrier's own schedule marks options the
   * client declined as "Coverage not Selected"; those are dropped upstream rather
   * than printed, because a declined coverage listed under a heading that reads
   * "Forms, Endorsements, Exclusions" tells a client they have something they do
   * not. Safeside's own proposals list none of them.
   */
  forms_and_exclusions: DocumentFormGroup[];
  recommendations: DocumentRecommendation[];
  terms_note: string | null;
  recommendations_note: string | null;
}
