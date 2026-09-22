import type {
  CustomerFieldName,
  FileExtractionStatus,
  LineType,
  ProposalDisplayStatus,
} from '@safeside/shared';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return money.format(value);
}

/** Parses what a broker typed into a money input. "$1,376.50" is fair game. */
export function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '').trim();
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export const DISPLAY_STATUS_LABEL: Record<ProposalDisplayStatus, string> = {
  draft: 'Draft',
  analyzing: 'Analyzing',
  extraction_failed: 'Extraction failed',
  generated: 'Generated',
};

export const FILE_STATUS_LABEL: Record<FileExtractionStatus, string> = {
  pending: 'Waiting',
  running: 'Reading',
  succeeded: 'Read',
  failed: 'Failed',
};

/** Carrier wording wins where we have it; this is the fallback. */
const LINE_TYPE_LABEL: Record<LineType, string> = {
  general_liability: 'General Liability',
  property: 'Property',
  business_owners_policy: 'Business Owners Policy',
  workers_comp: 'Workers Compensation',
  commercial_auto: 'Commercial Auto',
  umbrella: 'Umbrella',
  excess_liability: 'Excess Liability',
  professional_liability: 'Professional Liability',
  errors_omissions: 'Errors & Omissions',
  cyber: 'Cyber',
  crime: 'Crime',
  inland_marine: 'Inland Marine',
  flood: 'Flood',
  disability_pfl: 'Disability / PFL',
  employment_practices: 'Employment Practices',
  liquor_liability: 'Liquor Liability',
  other: 'Other Coverage',
};

export function lineTypeLabel(lineType: LineType): string {
  return LINE_TYPE_LABEL[lineType] ?? 'Coverage';
}

export const CUSTOMER_FIELD_ORDER: CustomerFieldName[] = [
  'named_insured',
  'dba',
  'entity_type',
  'fein',
  'mailing_address',
  'location_address',
  'contact_name',
  'contact_phone',
  'contact_email',
  'business_description',
  'effective_date',
  'expiration_date',
];

export const CUSTOMER_FIELD_LABEL: Record<CustomerFieldName, string> = {
  named_insured: 'Named insured',
  dba: 'DBA',
  mailing_address: 'Mailing address',
  location_address: 'Location address',
  contact_name: 'Contact name',
  contact_phone: 'Contact phone',
  contact_email: 'Contact email',
  fein: 'FEIN',
  entity_type: 'Entity type',
  business_description: 'Business description',
  effective_date: 'Effective date',
  expiration_date: 'Expiration date',
};

/** Fields worth more than a single-line input. */
export const MULTILINE_CUSTOMER_FIELDS = new Set<CustomerFieldName>([
  'mailing_address',
  'location_address',
  'business_description',
]);

export const DATE_CUSTOMER_FIELDS = new Set<CustomerFieldName>([
  'effective_date',
  'expiration_date',
]);

export const LOW_CONFIDENCE = 0.7;

export const DETAIL_KIND_LABEL: Record<string, string> = {
  limit: 'Limits',
  deductible: 'Deductibles',
  endorsement: 'Endorsements',
  exclusion: 'Exclusions',
  form: 'Forms',
  condition: 'Conditions',
};

/** Order the review screen groups a line's details in. */
export const DETAIL_KIND_ORDER = [
  'limit',
  'deductible',
  'endorsement',
  'exclusion',
  'form',
  'condition',
];
