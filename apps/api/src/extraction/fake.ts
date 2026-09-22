import { createHash } from 'node:crypto';
import type { ExtractionResult } from '@safeside/shared';
import type { ExtractionInput, ExtractionOutcome, ExtractionProvider } from './provider.ts';

/**
 * Offline extraction provider.
 *
 * Exists so the review screen can be built and demoed without an API key, and so
 * tests are deterministic and cost nothing. It makes no network calls.
 *
 * Output is derived from a hash of the file bytes, so the same PDF always yields
 * the same result and two different PDFs yield different ones — which is what
 * makes it useful for exercising the merge and option paths. Every value here is
 * invented; nothing is drawn from a real quote.
 */
export class FakeExtractionProvider implements ExtractionProvider {
  readonly name = 'fake';
  readonly model = null;

  async extract({ pdf, filename }: ExtractionInput): Promise<ExtractionOutcome> {
    const digest = createHash('sha256').update(pdf).digest();
    const pick = <T>(xs: readonly T[], at: number): T => xs[digest[at] % xs.length]!;
    const money = (at: number, base: number) => base + (digest[at] % 40) * 25;

    const shape = pick(['bop', 'wc', 'options'] as const, 0);

    const cell = (value: string | null, confidence = 0.92) => ({
      value,
      meta: { found: value !== null, confidence, page: null, note: null },
    });

    const customer = {
      named_insured: cell('Northgate Bakery LLC', 0.97),
      dba: cell(null, 0),
      mailing_address: cell('1 Example Way, Springfield, NY 10001', 0.88),
      location_address: cell('1 Example Way, Springfield, NY 10001', 0.9),
      contact_name: cell(shape === 'wc' ? 'A. Baker' : null, 0.6),
      contact_phone: cell(null, 0),
      contact_email: cell(null, 0),
      fein: cell(null, 0),
      // Deliberately low: mirrors the real behaviour of inferring entity type
      // from a legal suffix, which is exactly what the review screen must flag.
      entity_type: cell('LLC', 0.55),
      business_description: cell('Retail bakery and coffee service', 0.85),
      effective_date: cell('2026-10-01', 0.95),
      expiration_date: cell('2027-10-01', 0.95),
    };

    /* The same premise in every shape, so the merge's de-duplication is exercised
     * whenever two fixtures are uploaded to one proposal. */
    const PREMISES = [
      { location: '1', address: '1 Example Way', city: 'Springfield', state: 'NY', zip: '10001' },
    ];

    const result: ExtractionResult =
      shape === 'wc'
        ? {
            customer,
            lines: [{
              line_type: 'workers_comp',
              line_type_label: 'Workers Compensation',
              carrier_name: 'Example Mutual Insurance Company',
              premium: money(1, 900),
              premium_components: [
                { label: 'Class Code 8810 — Clerical', amount: money(1, 900) - 300, is_fee: false },
                { label: 'Expense Constant', amount: 250, is_fee: true },
                { label: 'State Assessment', amount: 50, is_fee: true },
              ],
              details: [
                { kind: 'limit', label: 'Each Accident', value: '$1,000,000', confidence: 0.95, section_hint: null },
                { kind: 'limit', label: 'Disease — Policy Limit', value: '$1,000,000', confidence: 0.95, section_hint: null },
                { kind: 'endorsement', label: 'Waiver of Subrogation', value: 'Included', confidence: 0.8, section_hint: null },
              ],
              options: [],
              admitted: 'admitted',
              schedules: {
                classifications: [],
                subjects_of_insurance: [],
                states: ['NY'],
                employers_liability: [{
                  coverage: 'Increased Employers Liability', limit: '$1,000,000',
                  disease_policy_limit: '$1,000,000', disease_each_employee: '$1,000,000',
                }],
                rating_basis: [
                  { location: '1', state: 'NY', class_code: '8810',
                    description: 'Clerical Office Employees', exposure: '$45,500', basis: 'Payroll' },
                  { location: '1', state: 'NY', class_code: '2003',
                    description: 'Bakery — Retail', exposure: '$340,000', basis: 'Payroll' },
                ],
                individuals: [
                  { name: 'A. Baker', title: 'Owner', status: 'Excluded' },
                ],
                note: null,
              },
              confidence: 0.94,
              page_start: 1,
            }],
            premises: PREMISES,
            carrier_names_seen: ['Example Mutual Insurance Company', 'Safeside Insurance Brokerage'],
            notes: ['Offline fixture — no document was read.'],
          }
        : shape === 'options'
          ? {
              customer,
              lines: [{
                line_type: 'general_liability',
                line_type_label: 'Commercial General Liability',
                carrier_name: 'Example Casualty Group',
                premium: null,
                premium_components: [],
                details: [],
                options: [
                  {
                    label: '$1M / $2M',
                    premium: money(2, 2000),
                    premium_components: [],
                    details: [
                      { kind: 'limit', label: 'Each Occurrence', value: '$1,000,000', confidence: 0.95, section_hint: null },
                      { kind: 'limit', label: 'General Aggregate', value: '$2,000,000', confidence: 0.95, section_hint: null },
                    ],
                  },
                  {
                    label: '$2M / $4M',
                    premium: money(2, 2000) + 700,
                    premium_components: [],
                    details: [
                      { kind: 'limit', label: 'Each Occurrence', value: '$2,000,000', confidence: 0.95, section_hint: null },
                      { kind: 'limit', label: 'General Aggregate', value: '$4,000,000', confidence: 0.95, section_hint: null },
                    ],
                  },
                ],
                admitted: 'non_admitted',
                schedules: {
                  classifications: [{
                    location: '1', classification: 'Bakeries — with baking on premises',
                    class_code: '10100', exposure: '$250,000', rating_basis: 'Gross Sales',
                  }],
                  subjects_of_insurance: [], states: [], employers_liability: [],
                  rating_basis: [], individuals: [], note: null,
                },
                confidence: 0.9,
                page_start: 2,
              }],
              premises: PREMISES,
              carrier_names_seen: ['Example Casualty Group'],
              notes: ['Offline fixture presenting two limit options, to exercise the option picker.'],
            }
          : {
              customer,
              lines: [{
                line_type: 'business_owners_policy',
                line_type_label: 'Businessowners Policy',
                carrier_name: 'Example Insurance Group',
                premium: money(3, 1200),
                premium_components: [
                  { label: 'Liability', amount: 900, is_fee: false },
                  { label: 'Property', amount: money(3, 1200) - 960, is_fee: false },
                  { label: 'NY Fire Fee', amount: 4.5, is_fee: true },
                  { label: 'Discounts', amount: -55, is_fee: false },
                ],
                details: [
                  { kind: 'limit', label: 'Each Occurrence', value: '$1,000,000', confidence: 0.95, section_hint: 'liability' },
                  { kind: 'limit', label: 'General Aggregate', value: '$2,000,000', confidence: 0.95, section_hint: 'liability' },
                  { kind: 'limit', label: 'Business Personal Property', value: '$30,000', confidence: 0.93, section_hint: 'property' },
                  { kind: 'limit', label: 'Business Income', value: 'Actual Loss Sustained', confidence: 0.75, section_hint: 'property' },
                  { kind: 'deductible', label: 'Property Deductible', value: '$1,000', confidence: 0.95, section_hint: 'property' },
                  { kind: 'endorsement', label: 'Equipment Breakdown', value: 'Included', confidence: 0.85, section_hint: 'property' },
                  { kind: 'exclusion', label: 'Water Exclusion', value: null, confidence: 0.65, section_hint: 'property' },
                ],
                options: [],
                admitted: 'admitted',
                schedules: {
                  classifications: [{
                    location: '1', classification: 'Bakeries — with baking on premises',
                    class_code: '10100', exposure: '$250,000', rating_basis: 'Gross Sales',
                  }],
                  subjects_of_insurance: [
                    { location: '1', building: '1', subject: 'Business Personal Property',
                      limit: '$30,000', coinsurance: '80%', valuation: 'Replacement Cost',
                      cause_of_loss: 'Special Form', deductible: '$1,000' },
                    { location: '1', building: '1', subject: 'Business Income',
                      limit: 'Actual Loss Sustained', coinsurance: null, valuation: null,
                      cause_of_loss: 'Special Form', deductible: '72 hours' },
                  ],
                  states: [], employers_liability: [], rating_basis: [], individuals: [],
                  note: null,
                },
                confidence: 0.93,
                page_start: 1,
              }],
              premises: PREMISES,
              carrier_names_seen: ['Example Insurance Group', 'Safeside Insurance Brokerage'],
              notes: [`Offline fixture for ${filename} — no document was read.`],
            };

    return {
      result,
      raw: { provider: 'fake', note: 'No API call was made.' },
      usage: { inputTokens: null, outputTokens: null },
      model: null,
    };
  }
}
