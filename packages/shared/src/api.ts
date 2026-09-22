import type { LineType, LineDetail, PremiumComponent, LineSchedules, Premise } from './extraction.ts';

/**
 * The HTTP contract between apps/api and apps/web.
 *
 * Defined here so both sides compile against the same shapes and a rename breaks
 * the build rather than the running app.
 *
 * Money crosses the wire as a number. Dates cross as ISO strings — `Date` does
 * not survive JSON, and a string that is sometimes a date object is worse than a
 * string that always is not.
 */

/* --- Auth ----------------------------------------------------------------- */

export interface ApiUser {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
}

export interface LoginRequest {
  email: string;
  password: string;
}

/* --- Proposals list (screen 2) -------------------------------------------- */

export type ProposalStatus = 'draft' | 'generated';

/**
 * Transient states are derived from per-file extraction status rather than
 * stored, so the list can show "Analyzing" without a second source of truth that
 * could drift.
 */
export type ProposalDisplayStatus = 'draft' | 'analyzing' | 'extraction_failed' | 'generated';

export interface ProposalListItem {
  id: string;
  client_name: string;
  status: ProposalStatus;
  display_status: ProposalDisplayStatus;
  created_at: string;
  updated_at: string;
  file_count: number;
  files_extracting: number;
  files_failed: number;
  latest_document_id: string | null;
}

/* --- Upload and extraction (screens 3 and 4) ------------------------------ */

export type FileExtractionStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface ProposalFile {
  id: string;
  original_filename: string;
  size_bytes: number;
  page_count: number | null;
  extraction_status: FileExtractionStatus;
  error_text: string | null;
  created_at: string;
}

/**
 * Drives the analyzing screen. `stage` exists so the screen can say which file it
 * is on rather than showing an indeterminate spinner for a minute.
 */
export interface ExtractionProgress {
  proposal_id: string;
  files: ProposalFile[];
  total: number;
  completed: number;
  failed: number;
  /** True when nothing is pending or running, whatever the outcomes were. */
  done: boolean;
  /** Filename currently being read, when one is. */
  current_filename: string | null;
}

/* --- Review (screen 5) ---------------------------------------------------- */

export interface CustomerFieldConflict {
  value: string;
  file_id: string;
  filename: string;
}

export interface CustomerField {
  value: string | null;
  /** False when extraction did not find it — the review screen flags these. */
  found: boolean;
  confidence: number;
  /** Populated only when source files disagreed. */
  conflicts: CustomerFieldConflict[];
  /** True once a human has touched it; edits are never overwritten by re-extract. */
  edited: boolean;
}

export type CustomerFieldName =
  | 'named_insured' | 'dba' | 'mailing_address' | 'location_address'
  | 'contact_name' | 'contact_phone' | 'contact_email' | 'fein'
  | 'entity_type' | 'business_description' | 'effective_date' | 'expiration_date';

export type ReviewCustomer = Record<CustomerFieldName, CustomerField>;

export interface ReviewLineOption {
  id: string;
  label: string;
  /** INTERNAL — shown to the broker on review, never in the document. */
  carrier_premium: number | null;
  premium_components: PremiumComponent[];
  details: LineDetail[];
  source_filename: string | null;
  /** True when this option is a competing quote from a different file. */
  from_separate_file: boolean;
}

export interface ReviewLine {
  id: string;
  line_type: LineType;
  line_type_label: string | null;
  section_titles: string[];
  included: boolean;
  /** INTERNAL. */
  carrier_name: string | null;
  carrier_premium: number | null;
  premium_components: PremiumComponent[];
  broker_fee: number;
  /** carrier_premium + broker_fee. The only figure the client ever sees. */
  combined_price: number | null;
  options: ReviewLineOption[];
  selected_option_id: string | null;
  details: LineDetail[];
  /** 'admitted' | 'non_admitted' | null. Editable on review. */
  admitted: string | null;
  /** Structured tables for this line's coverage page. */
  schedules: LineSchedules | null;
  confidence: number;
  display_order: number;
  /**
   * True when itemised components do not sum to the premium. Advisory only —
   * carriers legitimately leave base premium un-itemised, so this must never
   * block generation.
   */
  components_unreconciled: boolean;
}

/** One selectable premium-page disclaimer. */
export interface ReviewDisclaimer {
  id: string;
  /** Short name for the checkbox, e.g. "Payroll audit". */
  label: string;
  /** The sentence that prints. */
  body: string;
  selected: boolean;
}

export interface ReviewRecommendation {
  id: string;
  label: string;
  body: string;
  /** Suggested because this coverage type is absent from the proposal. */
  suggested: boolean;
  selected: boolean;
  body_override: string | null;
}

export interface ProposalDetail {
  id: string;
  client_name: string;
  status: ProposalStatus;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  customer: ReviewCustomer;
  lines: ReviewLine[];
  recommendations: ReviewRecommendation[];
  recommendations_note: string | null;
  /** Premium-page disclaimers, with the broker's current selection. */
  disclaimers: ReviewDisclaimer[];
  /** The insured's sites, merged across quotes. */
  premises: Premise[];
  terms_note: string | null;
  files: ProposalFile[];
  /** Model observations, shown on review and never printed. */
  notes: Array<{ filename: string; note: string }>;
  /** Every carrier name seen. Feeds the leak guard; never leaves the tool. */
  carrier_names: string[];
  totals: ProposalTotals;
  /** Empty means Generate is enabled. */
  blocking_reasons: string[];
}

export interface ProposalTotals {
  carrier_premium: number;
  broker_fee: number;
  /** The grand total the client sees. */
  combined: number;
}

/* --- Mutations ------------------------------------------------------------ */

export interface UpdateCustomerRequest {
  fields: Partial<Record<CustomerFieldName, string | null>>;
}

export interface UpdateLineRequest {
  included?: boolean;
  /** 'admitted', 'non_admitted', or null to drop the column. */
  admitted?: string | null;
  broker_fee?: number;
  carrier_premium?: number | null;
  selected_option_id?: string | null;
  display_order?: number;
}

export interface UpdateLineDetailRequest {
  label?: string;
  value?: string | null;
}

export interface UpdateProposalRequest {
  client_name?: string;
  recommendations_note?: string | null;
  terms_note?: string | null;
}

export interface SelectDisclaimersRequest {
  /** Disclaimer ids, in the order they should print. */
  selected: string[];
}

export interface SelectRecommendationsRequest {
  selected: Array<{ recommendation_id: string; body_override?: string | null }>;
}

/* --- Documents (screen 6) ------------------------------------------------- */

export interface GeneratedDocument {
  id: string;
  proposal_id: string;
  page_count: number | null;
  generated_at: string;
  download_url: string;
}

/* --- Errors --------------------------------------------------------------- */

export interface ApiError {
  error: string;
  /** Present on 422 from the leak guard: which fields named a carrier. */
  leak_findings?: Array<{ term: string; path: string; excerpt: string }>;
  /** Present on 400 validation failures. */
  details?: string[];
}
