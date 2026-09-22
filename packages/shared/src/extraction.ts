import { z } from 'zod';

/**
 * The extraction contract.
 *
 * This shape is used in four places and must stay identical in all of them:
 *   - the JSON schema handed to the model as a tool definition
 *   - validation of whatever the model returns
 *   - the API response type
 *   - the review screen's form model
 *
 * Defined once here, inferred everywhere else, so a rename cannot drift between
 * the model and the UI.
 */

/** Money is always a number. Never "$1,376.50". */
const Money = z.number().finite().nonnegative();

/** Dates are always ISO yyyy-mm-dd. */
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected yyyy-mm-dd');

/**
 * Confidence is the model's own read on whether it got this right, and it drives
 * the yellow flags on the review screen. `found: false` means the field is not in
 * the document at all — which is a legitimate outcome, not an error.
 */
export const FieldMetaSchema = z.object({
  found: z.boolean(),
  confidence: z.number().min(0).max(1),
  /** Page the value came from, for "where did this come from?" on review. */
  page: z.number().int().positive().nullable().default(null),
  /** Why the model was unsure. Only populated when confidence is low. */
  note: z.string().nullable().default(null),
});
export type FieldMeta = z.infer<typeof FieldMetaSchema>;

/** A value plus its provenance. Null value is always allowed — never invent one. */
const tracked = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({ value: inner.nullable(), meta: FieldMetaSchema });

export const CustomerBlockSchema = z.object({
  named_insured: tracked(z.string()),
  dba: tracked(z.string()),
  mailing_address: tracked(z.string()),
  location_address: tracked(z.string()),
  contact_name: tracked(z.string()),
  contact_phone: tracked(z.string()),
  contact_email: tracked(z.string()),
  fein: tracked(z.string()),
  entity_type: tracked(z.string()),
  business_description: tracked(z.string()),
  effective_date: tracked(IsoDate),
  expiration_date: tracked(IsoDate),
});
export type CustomerBlock = z.infer<typeof CustomerBlockSchema>;

/**
 * Canonical coverage types. `other` is deliberately available: an unexpected line
 * must degrade into a reviewable row, never fail the extraction run.
 */
export const LINE_TYPES = [
  'general_liability',
  'property',
  'business_owners_policy',
  'workers_comp',
  'commercial_auto',
  'umbrella',
  'excess_liability',
  'professional_liability',
  'errors_omissions',
  'cyber',
  'crime',
  'inland_marine',
  'flood',
  'disability_pfl',
  'employment_practices',
  'liquor_liability',
  'other',
] as const;
export const LineTypeSchema = z.enum(LINE_TYPES);
export type LineType = z.infer<typeof LineTypeSchema>;

export const DETAIL_KINDS = [
  'limit',
  'deductible',
  'endorsement',
  'exclusion',
  'form',
  'condition',
] as const;
export const DetailKindSchema = z.enum(DETAIL_KINDS);

/**
 * One limit / deductible / endorsement row.
 *
 * `label` keeps the carrier's own wording. Brokers recognise "Each Occurrence" and
 * "General Aggregate"; rewording them to something tidier invites mistakes.
 */
/**
 * Which half of a packaged policy a detail belongs to.
 *
 * Safeside presents a BOP as two coverage pages — General Liability and Property
 * — so a packaged line's limits have to be split between them. The model reading
 * the document is better placed to decide than a keyword list in our code: it can
 * see which table a limit sat in and what heading it was under.
 *
 * Null for unpackaged lines, where there is nothing to split.
 */
export const SectionHintSchema = z.enum(['liability', 'property']).nullable();

export const LineDetailSchema = z.object({
  kind: DetailKindSchema,
  label: z.string().min(1),
  value: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  section_hint: SectionHintSchema.default(null),
});
export type LineDetail = z.infer<typeof LineDetailSchema>;

/**
 * One itemised component of a line's premium.
 *
 * Packaged policies price in parts — a BOP quote will itemise liability, property,
 * bundle enhancements, terrorism and statutory fees, then total them. The broker
 * needs the breakdown to sanity-check the number; the client only ever sees the
 * combined figure. Both facts are why this is structured rather than prose.
 */
export const PremiumComponentSchema = z.object({
  label: z.string().min(1),
  /**
   * Signed, unlike every other money field here. Carriers itemise discounts,
   * credits and pay-in-full reductions as components, and a non-negative type
   * makes them unrepresentable — the components then overstate the total by twice
   * the discount and the reconciliation check fires on a correct quote.
   */
  amount: z.number().finite(),
  /** True for statutory fees and surcharges rather than premium proper. */
  is_fee: z.boolean().default(false),
});
export type PremiumComponent = z.infer<typeof PremiumComponentSchema>;

/**
 * A variant of the same coverage within one quote — a higher and lower limit, with
 * and without a deductible buy-down. Siblings under a line, never separate lines.
 *
 * Getting this boundary right is the hardest judgement in extraction: GL at $1M/$2M
 * vs GL at $2M/$4M are options, but GL primary vs a GL excess layer are two lines.
 * The model will sometimes get it wrong, so the review screen lets a broker split a
 * line into options or promote an option into its own line.
 */
export const LineOptionSchema = z.object({
  label: z.string().min(1),
  premium: Money.nullable(),
  premium_components: z.array(PremiumComponentSchema).default([]),
  details: z.array(LineDetailSchema).default([]),
});
export type LineOption = z.infer<typeof LineOptionSchema>;

/**
 * The liability classification schedule a carrier prints alongside the premium:
 * which operation at which location is rated, on what basis, at what exposure.
 *
 * Safeside reproduces this table in the client proposal. It is rating detail but
 * not carrier identity — it describes the insured's own operations — so it is one
 * of the few carrier-supplied tables that crosses into the client document.
 */
export const ClassificationSchema = z.object({
  /** Location number as the schedule labels it, e.g. "1" or "Loc 1 Bldg 2". */
  location: z.string().nullable(),
  /** The classification wording, verbatim. */
  classification: z.string(),
  /** Class code, e.g. "91580" or "8810". */
  class_code: z.string().nullable(),
  /** The rated amount, e.g. "250,000" or "$1,200,000". Kept as printed. */
  exposure: z.string().nullable(),
  /** e.g. "Payroll", "Gross Sales", "Area", "Per Capita". */
  rating_basis: z.string().nullable(),
});
export type Classification = z.infer<typeof ClassificationSchema>;

/**
 * The premise schedule: the insured's own sites. Client information throughout,
 * with no carrier content in it at all.
 */
export const PremiseSchema = z.object({
  location: z.string().nullable(),
  address: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
});
export type Premise = z.infer<typeof PremiseSchema>;

/**
 * Subjects of Insurance — the property schedule, one row per insured thing.
 *
 * Columns read off Safeside's own property pages: what is covered, at what limit,
 * on what valuation basis, against which causes, with what deductible.
 */
export const SubjectOfInsuranceSchema = z.object({
  location: z.string().nullable(),
  building: z.string().nullable(),
  /** e.g. "Business Personal Property", "Business Income". */
  subject: z.string(),
  limit: z.string().nullable(),
  /** Coinsurance percentage, as printed: "80%". */
  coinsurance: z.string().nullable(),
  /** e.g. "Replacement Cost", "Actual Cash Value". */
  valuation: z.string().nullable(),
  /** e.g. "Special Form", "Basic". */
  cause_of_loss: z.string().nullable(),
  deductible: z.string().nullable(),
});
export type SubjectOfInsurance = z.infer<typeof SubjectOfInsuranceSchema>;

/** Employers Liability limits, the three-figure row on a workers comp page. */
export const EmployersLiabilitySchema = z.object({
  /** e.g. "Increased Employers Liability". */
  coverage: z.string(),
  limit: z.string().nullable(),
  disease_policy_limit: z.string().nullable(),
  disease_each_employee: z.string().nullable(),
});
export type EmployersLiability = z.infer<typeof EmployersLiabilitySchema>;

/** Workers Comp Rating Basis — the payroll schedule behind the WC premium. */
export const RatingBasisSchema = z.object({
  location: z.string().nullable(),
  state: z.string().nullable(),
  class_code: z.string().nullable(),
  description: z.string(),
  /** The rated amount, as printed. */
  exposure: z.string().nullable(),
  /** Usually "Payroll". */
  basis: z.string().nullable(),
});
export type RatingBasis = z.infer<typeof RatingBasisSchema>;

/**
 * Individuals Included/Excluded — officers and owners, whose inclusion under
 * workers compensation is a state-law question and a common source of disputes.
 */
export const IndividualSchema = z.object({
  name: z.string(),
  /** e.g. "Owner", "President". */
  title: z.string().nullable(),
  /** "Included" or "Excluded", as printed. */
  status: z.string().nullable(),
});
export type Individual = z.infer<typeof IndividualSchema>;

/**
 * Every structured table a coverage page can carry.
 *
 * One object rather than seven arrays on the line, because the template asks
 * "what tables does this section have" and a single shape answers it.
 */
export const LineSchedulesSchema = z.object({
  /** General Liability page. */
  classifications: z.array(ClassificationSchema).default([]),
  /** Property page. */
  subjects_of_insurance: z.array(SubjectOfInsuranceSchema).default([]),
  /** Workers Compensation page. */
  states: z.array(z.string()).default([]),
  employers_liability: z.array(EmployersLiabilitySchema).default([]),
  rating_basis: z.array(RatingBasisSchema).default([]),
  individuals: z.array(IndividualSchema).default([]),
  /**
   * A footnote Safeside prints under a schedule, e.g. a note that the carrier
   * confirmed an unusual class code. Kept because it explains a figure the client
   * would otherwise query.
   */
  note: z.string().nullable().default(null),
});
export type LineSchedules = z.infer<typeof LineSchedulesSchema>;

export const CoverageLineSchema = z.object({
  line_type: LineTypeSchema,
  /** The carrier's own name for this line, verbatim. */
  line_type_label: z.string().nullable(),

  /** INTERNAL ONLY — must never reach the generated document. */
  carrier_name: z.string().nullable(),

  /**
   * The total annual cost the carrier charges for this line, inclusive of any
   * itemised components and statutory fees.
   *
   * This is the figure the broker fee is added to, and the sum of these across
   * included lines is the one number the client sees. It must be populated
   * whenever the document states a price for this coverage — including packaged
   * policies that itemise internally. Null only when the line has options and the
   * prices sit on those instead.
   */
  premium: Money.nullable(),

  /** How `premium` was arrived at, when the carrier itemised it. */
  premium_components: z.array(PremiumComponentSchema).default([]),

  details: z.array(LineDetailSchema).default([]),

  /**
   * Populated only when the document genuinely presents this coverage more than
   * once. An empty array is the normal case and means "one version of this line".
   */
  options: z.array(LineOptionSchema).default([]),

  /**
   * Whether the policy is written on an admitted or a surplus-lines paper.
   *
   * The regulatory status of the POLICY, which is not the identity of the carrier
   * writing it — a client is entitled to know whether the state guaranty fund
   * stands behind their coverage. Null whenever the document does not say so; the
   * column is then dropped from the premium table rather than printed blank.
   */
  admitted: z.enum(['admitted', 'non_admitted']).nullable().default(null),

  /** Structured tables this line's coverage page carries. */
  schedules: LineSchedulesSchema.default({
    classifications: [], subjects_of_insurance: [], states: [],
    employers_liability: [], rating_basis: [], individuals: [], note: null,
  }),

  confidence: z.number().min(0).max(1),
  page_start: z.number().int().positive().nullable().default(null),
});
export type CoverageLine = z.infer<typeof CoverageLineSchema>;

export const ExtractionResultSchema = z.object({
  customer: CustomerBlockSchema,
  lines: z.array(CoverageLineSchema).default([]),
  /**
   * Every carrier name seen anywhere in the document. Feeds the leak guard that
   * scans the assembled proposal before a PDF is released — a field whitelist
   * alone cannot catch a carrier name embedded inside a limit label or form title.
   */
  carrier_names_seen: z.array(z.string()).default([]),
  /**
   * The insured's locations, where the quote schedules them.
   *
   * Top-level rather than inside CustomerBlockSchema because that block holds
   * tracked scalars — one value with one confidence each — and a schedule has no
   * single value to be confident about.
   */
  premises: z.array(PremiseSchema).default([]),

  /** Anything the model wants to tell the broker. Shown on review, never printed. */
  notes: z.array(z.string()).default([]),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
