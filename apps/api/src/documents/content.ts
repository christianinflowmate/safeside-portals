/**
 * Standing copy for the proposal's fixed pages.
 *
 * ── What is in here and what is not ────────────────────────────────────────
 *
 * Everything below is Safeside's OWN wording, transcribed from the real 22-page
 * template in the sample corpus. No client value appears: no named insured,
 * address, FEIN, premium, broker fee or policy number. The one page in the real
 * document that prints a fee amount — the Regulation 194 authorisation — renders
 * here as a blank for the signer to complete, which is what the second sample
 * proposal does anyway.
 *
 * Where the real page's content is DATA rather than boilerplate (the service-team
 * roster, the employee directory) or varies by line of business (the premium-page
 * disclaimers), there is a PLACEHOLDER block instead. Those are deliberately not
 * filled with something plausible: invented legal, regulatory or directory copy
 * that reads convincingly is worse than an obvious gap, because nobody proofreads
 * a paragraph that already sounds right.
 *
 * ── Why here and not in the database ───────────────────────────────────────
 *
 * sp_coverage_descriptions and sp_recommendations hold the copy a broker edits in
 * the app. These pages are different: they are the document's furniture, the same
 * on every proposal, and none of them has a home on ProposalDocumentModel — which
 * is the point, since the model carries the client's data and nothing else. When
 * the boilerplate screens grow to cover these pages too, this module becomes their
 * seed rather than their source.
 *
 * Transcription follows the same light normalisation as supabase/migrations/
 * 002_seed_content.sql: obvious typographic slips in the source are corrected, the
 * wording is not.
 */

/** One unit of standing copy. Rendered by template.ts; never contains markup. */
export type CopyBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; text: string }
  /** Numbered clauses, as on the Terms and Minimum Earned pages. */
  | { kind: 'clauses'; items: Array<{ heading?: string; text: string }> }
  | { kind: 'bullets'; items: string[] }
  /** Term-and-explanation pairs, as in the About Us values block. */
  | { kind: 'defs'; items: Array<{ term: string; text: string }> }
  /** Copy that is not available. Renders as a visibly unfinished block. */
  | { kind: 'placeholder'; what: string; why: string };

/**
 * In `paragraph` text, this token renders as a signature-style blank rather than
 * as literal characters. Used where the real document prints a figure that this
 * tool has no business printing.
 */
export const BLANK_TOKEN = '{blank}';

/* -------------------------------------------------------------------------- */
/* Running header and footer — real, on all 22 pages including the cover.      */
/* -------------------------------------------------------------------------- */

export const RUNNING_HEADER = 'Safe Secure Done';

export const FOOTER_DISCLAIMER =
  'This proposal is valid for 30 days and is for informational purposes only. ' +
  'Coverage is subject to the terms and conditions of the final policy';

/* -------------------------------------------------------------------------- */
/* Cover                                                                       */
/* -------------------------------------------------------------------------- */

export const COVER_TITLE = 'Commercial Insurance Proposal.';
export const COVER_BRAND = 'Safeside Insurance Brokerage';
export const COVER_TAGLINE = 'Safe · Secure · Done';

/**
 * Shown on the cover until the real artwork exists. Kept as copy rather than as a
 * code comment on purpose: a TODO nobody can see in the output is a TODO that
 * ships.
 */
export const COVER_ART_TODO =
  'TODO: cover artwork. The real cover is a full-bleed photograph with the title ' +
  'in heavy white type. Placeholder gradient until that asset is supplied.';

/* -------------------------------------------------------------------------- */
/* Page 3 — Statement From Our CEO  (REAL)                                     */
/* -------------------------------------------------------------------------- */

export const CEO_STATEMENT_TITLE = 'Statement From Our CEO';

export const CEO_STATEMENT: CopyBlock[] = [
  { kind: 'paragraph', text: 'Thank you for choosing Safeside Insurance Brokerage.' },
  {
    kind: 'paragraph',
    text:
      'We understand that selecting the right insurance partner is an important ' +
      'decision, and we truly value the opportunity you have given us to serve your ' +
      'insurance needs.',
  },
  {
    kind: 'paragraph',
    text:
      'Our team is committed to earning your trust every step of the way — through ' +
      'responsive service, clear communication, and tailored coverage that protects ' +
      'what matters most to you.',
  },
  {
    kind: 'paragraph',
    text:
      'We look forward to supporting you and building a lasting relationship built ' +
      'on integrity and care.',
  },
  { kind: 'paragraph', text: 'Committed to your success and here whenever you need.' },
];

export const CEO_SIGNOFF = { closing: 'Sincerely,', name: 'Harry Schonfeld', role: 'CEO' };

/* -------------------------------------------------------------------------- */
/* Page 4 — Premium Breakdown & Subjectivities                                 */
/* -------------------------------------------------------------------------- */

export const PREMIUM_PAGE_TITLE = 'Premium and Subjectivities Prior to Binding';

export const PREMIUM_TABLE_HEADINGS = {
  line: 'Line of Business',
  admitted: 'Admitted or Non Admitted',
  price: 'Total Premium including taxes/fees',
};

/*
 * The premium-page disclaimers are NOT here.
 *
 * They looked like standing copy and are not. Across four of Safeside's own
 * proposals they differ: one carries four clauses about payroll, audit, officer
 * inclusion and subcontractors; the others carry "Minimum Deposit applies if the
 * policy is rated by payroll or sales", two of them alongside "Action Over".
 *
 * Nor does the line of business predict it — a proposal WITH a workers
 * compensation line carries none of the payroll clauses. So it is a broker
 * judgement, and it lives in sp_premium_disclaimers with a per-proposal selection
 * exactly like coverage recommendations. See migration 006.
 *
 * model.premium_disclaimers holds what the broker ticked.
 */

/** Heading above the selected disclaimers. */
export const PREMIUM_DISCLAIMERS_HEADING = 'Disclaimers';

/**
 * Abbreviations for the premium page heading, which names the lines quoted:
 * "BOP/WC/DBL Premium and Subjectivities Prior to Binding".
 */
const LINE_ABBREVIATION: Record<string, string> = {
  business_owners_policy: 'BOP',
  general_liability: 'GL',
  property: 'PROP',
  workers_comp: 'WC',
  disability_pfl: 'DBL',
  commercial_auto: 'AUTO',
  umbrella: 'UMB',
  excess_liability: 'EXCESS',
  professional_liability: 'PL',
  errors_omissions: 'E&O',
  cyber: 'CYBER',
  crime: 'CRIME',
  inland_marine: 'IM',
  flood: 'FLOOD',
  employment_practices: 'EPLI',
  liquor_liability: 'LIQUOR',
};

/**
 * Build the premium page heading from the lines quoted.
 *
 * Falls back to the unprefixed title when nothing is recognised, rather than
 * printing an empty prefix or a raw enum value. A line type with no abbreviation
 * is left out of the prefix — the table below still names it in full.
 */
export function premiumPageTitle(lineTypes: string[]): string {
  const seen: string[] = [];
  for (const t of lineTypes) {
    const abbr = LINE_ABBREVIATION[t];
    if (abbr && !seen.includes(abbr)) seen.push(abbr);
  }
  return seen.length > 0 ? `${seen.join('/')} ${PREMIUM_PAGE_TITLE}` : PREMIUM_PAGE_TITLE;
}

export const SUBJECTIVITIES_HEADING = 'Subjectivities Prior to Binding';

/**
 * REAL — identical across all four sample proposals whatever lines are quoted.
 *
 * Plain strings rather than a bullets CopyBlock: Safeside prints these as rows of
 * a bordered table matching the premium table above them, and a CopyBlock has no
 * way to say that.
 */
export const SUBJECTIVITIES: string[] = [
  'Signed and Dated Application, Disclaimer, Authorization Form etc.',
  'Epay Link to process payment and Docusign to sign applications will be sent in a separate email.',
  'Installment fees from the carrier may apply on direct bill policies.',
];

/* -------------------------------------------------------------------------- */
/* Page 5 — Named Insured                                                      */
/* -------------------------------------------------------------------------- */

export const NAMED_INSURED_TITLE = 'Named Insured';

export const PREMISES_TITLE = 'Premise Information';
export const PREMISES_HEADINGS = ['Location', 'Address', 'City', 'State', 'Zip'];

export const CLASSIFICATIONS_TITLE = 'Liability Classification';
export const CLASSIFICATIONS_HEADINGS =
  ['Location', 'Classification', 'Class Code', 'Exposure', 'Rating Basis'];

/* -------------------------------------------------------------------------- */
/* Key Coverage Descriptions                                                   */
/* -------------------------------------------------------------------------- */

export const KEY_DESCRIPTIONS_TITLE = 'Key Coverage Descriptions';

/* -------------------------------------------------------------------------- */
/* Page 13 — Terms & Conditions / Forms, Endorsements, Exclusions              */
/* -------------------------------------------------------------------------- */

export const TERMS_TITLE = 'Terms & Conditions';
export const FORMS_SUBHEAD = 'Forms, Endorsements, Exclusions';

/* -------------------------------------------------------------------------- */
/* Page 14 — Policy Terms & Key Conditions  (REAL)                             */
/* -------------------------------------------------------------------------- */

export const TERMS_KEY_POINTS_TITLE = 'Policy Terms & Key Conditions';

export const TERMS_KEY_POINTS: CopyBlock[] = [
  {
    kind: 'paragraph',
    text:
      'Coverage is subject to the terms, conditions, exclusions and endorsements of ' +
      'the issued policies. Key points include:',
  },
  {
    kind: 'clauses',
    items: [
      {
        heading: 'Named Insured',
        text:
          'Coverage applies only to the legal entity(ies) listed as named insured on ' +
          'the policy. If ownership or entity changes, coverage must be updated ' +
          'immediately.',
      },
      {
        heading: 'Construction or Renovation',
        text:
          'If any construction, renovation or major repairs are being performed at the ' +
          'insured location, coverage terms may change. Certain losses may be excluded. ' +
          'Notify us before work begins to ensure proper coverage is in place.',
      },
      {
        heading: 'Vacancy',
        text:
          'Extended vacancy (typically over 60 days) may limit or exclude coverage for ' +
          'certain perils. Notify us immediately of any vacancy.',
      },
      {
        heading: 'Occupancy',
        text: 'Occupancy changes may nullify coverage. Notify us immediately of any occupancy changes.',
      },
      { heading: 'Protective Safeguards', text: 'Required safety systems must be maintained.' },
      { heading: 'Flood / Earthquake', text: 'Not included unless purchased separately.' },
      {
        heading: 'Endorsements & Exclusions',
        text:
          'Policies contain certain specific endorsements and exclusions that may add, ' +
          'limit or remove coverage.',
      },
      {
        heading: 'Review Responsibility',
        text:
          'It is the insured’s responsibility to review policy documents upon ' +
          'receipt to ensure accuracy.',
      },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Page 15 — Coverage Recommendations  (REAL)                                  */
/* -------------------------------------------------------------------------- */

/* The "- Business Dept" suffix is on 10 of Safeside's 11 proposals. */
export const RECOMMENDATIONS_TITLE = 'Coverage Recommendations - Business Dept';

export const RECOMMENDATIONS_INTRO =
  'Your current quote delivers strong coverage for many common risks; however, ' +
  'certain events may still fall outside the scope of this policy. To help further ' +
  'protect your business, we recommend reviewing the additional coverages below. ' +
  'Please reach out for more details or tailored options.';

export const RECOMMENDATIONS_ACK_TITLE = 'Acknowledgement By Insured';

export const RECOMMENDATIONS_ACK =
  'I have reviewed the recommended coverages provided to me and have chosen not to ' +
  'purchase one or more of them at this time. I understand that any loss, damage, or ' +
  'expense related to the coverages I have declined will not be covered under my ' +
  'current insurance policy.';

/* -------------------------------------------------------------------------- */
/* Page 16 — NY Regulation & Minimum Earned  (REAL)                            */
/* -------------------------------------------------------------------------- */

export const NY_REGULATION_TITLE = 'NY Regulation & Minimum Earned';

export const NY_REGULATION: CopyBlock[] = [
  { kind: 'heading', text: 'NY Regulation 194 Disclosure & Payment Authorization' },
  {
    kind: 'paragraph',
    text:
      'Safeside Insurance is acting as your insurance broker. We represent you in your ' +
      'search for insurance coverage and may also work with insurance companies to ' +
      'obtain quotes and place coverage on your behalf. Our compensation may be from ' +
      'the insurance company, from you, or both. The primary source of our compensation ' +
      'is a commission paid by the insurance company, which is based on the premium you ' +
      'pay. We may also receive a service fee from you, as agreed in writing. In ' +
      'addition, we may receive other forms of compensation from insurance companies ' +
      'based on factors like the volume or profitability of the business we place with ' +
      'them. You may request more detailed information about the compensation we expect ' +
      'to receive in connection with your policy.',
  },
  {
    /*
     * The real template prints the broker fee here as a figure. It renders as a
     * blank instead: the fee is internal to the brokerage, ProposalDocumentModel
     * deliberately has no field carrying it, and the second sample proposal leaves
     * the same blank on the page.
     */
    kind: 'paragraph',
    text:
      `Authorization is hereby given to charge a service/policy fee of $${BLANK_TOKEN}. ` +
      'I understand the broker fee is separate from and in addition to the insurance ' +
      'premium, is fully earned upon binding or renewal, and is non-refundable.',
  },
];

export const MINIMUM_EARNED_HEADING = 'Minimum Earned';

export const MINIMUM_EARNED: CopyBlock[] = [
  {
    kind: 'paragraph',
    text:
      'I hereby acknowledge and agree to the terms outlined below regarding the ' +
      'minimum earned policy and responsibility for payment collection failure ' +
      'associated with the insurance policy issued by Safeside Insurance Brokerage Inc.',
  },
  {
    kind: 'clauses',
    items: [
      {
        heading: 'Minimum Earned Policy',
        text:
          'I understand that upon issuance of the insurance policy, there is a minimum ' +
          'earned premium requirement, regardless of the duration for which the policy ' +
          'remains in force. This means that once the policy is issued, a portion of the ' +
          'premium becomes non-refundable, irrespective of any subsequent adjustments or ' +
          'cancellations.',
      },
      {
        heading: 'Responsibility for Payment Collection Failure',
        text:
          'I acknowledge that it is my responsibility to ensure that premium is ' +
          'collected. In the event that Safeside Insurance Brokerage Inc is unable to ' +
          'collect the premiums due to insufficient funds, or is unable to collect the ' +
          'premiums due from the bank or closing for any reason, I accept full ' +
          'responsibility for the outstanding payment.',
      },
      {
        heading: 'Agreement to Resolve Payment Collection Issues',
        text:
          'I agree to promptly address any issues related to payment collection, ' +
          'including but not limited to providing updated bank account or credit card ' +
          'information, resolving insufficient fund situations, or making alternative ' +
          'payment arrangements as necessary.',
      },
      {
        heading: 'Liability for Unpaid Premiums',
        text:
          'I understand that failure to fulfill payment obligations may result in ' +
          'consequences such as loss of coverage and potential legal actions to recover ' +
          'unpaid premiums.',
      },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Page 17 — Payment Authorization Form  (REAL)                                */
/* -------------------------------------------------------------------------- */

export const PAYMENT_AUTHORIZATION_TITLE = 'Payment Authorization Form - Business';

export const PAYMENT_AUTHORIZATION: CopyBlock[] = [
  {
    kind: 'paragraph',
    text:
      `I hereby authorize Safeside Insurance Brokerage Inc to charge the amount of $${BLANK_TOKEN} ` +
      'for the payment of my insurance premium, and I authorize Safeside Insurance ' +
      'Brokerage to set up my account on an auto pay schedule directly with the carrier ' +
      'if applicable.',
  },
  { kind: 'paragraph', text: 'I understand and agree that:' },
  {
    kind: 'bullets',
    items: [
      'This payment is authorized and valid, and I will not dispute this charge with my bank, credit card company, or payment processor.',
      'It is my responsibility to ensure funds are available at the time of processing.',
      'Returned, declined, or disputed payments may result in cancellation of coverage.',
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Page 18 — Disclaimer & Notice of Acceptance  (REAL)                         */
/* -------------------------------------------------------------------------- */

export const DISCLAIMER_TITLE = 'Disclaimer & Notice of Acceptance';

export const DISCLAIMER: CopyBlock[] = [
  { kind: 'heading', text: 'Applicant’s Statement & Acknowledgment' },
  {
    kind: 'paragraph',
    text:
      'I declare that the statements and information provided in this application and ' +
      'in any supporting documents are true, accurate, and complete to the best of my ' +
      'knowledge. I understand that the insurer will rely on this information in ' +
      'underwriting and issuing the policy, and that any misrepresentation, omission, ' +
      'or concealment of material facts may result in the denial of a claim and/or ' +
      'cancellation or rescission of my policy.',
  },
  { kind: 'paragraph', text: 'I acknowledge and agree that:' },
  {
    kind: 'clauses',
    items: [
      {
        text:
          'I have carefully reviewed this application in its entirety and confirm it ' +
          'accurately reflects my operations, property, and insurance needs.',
      },
      {
        text:
          'This application is not a binder and no coverage will be effective until ' +
          'confirmed in writing by Safeside Insurance or the insurance carrier.',
      },
      {
        text:
          'Any quotation provided is subject to change based on underwriting review, ' +
          'inspections, and/or receipt of additional information.',
      },
      {
        text:
          'I am responsible for promptly reporting any changes in the information ' +
          'provided in this application to Safeside Insurance.',
      },
      {
        text:
          'Coverage is subject to all terms, conditions, exclusions, and endorsements ' +
          'of the policy issued.',
      },
      {
        text:
          'If a minimum earned premium applies, I understand that portion of the ' +
          'premium is fully earned at policy inception and non-refundable.',
      },
      {
        text:
          'Certain coverages may be subject to mandatory inspections, and required ' +
          'improvements must be completed within the insurer’s timeframe to ' +
          'maintain coverage.',
      },
    ],
  },
  { kind: 'heading', text: 'New York Fraud Warning' },
  {
    kind: 'paragraph',
    text:
      'Any person who knowingly and with intent to defraud any insurance company or ' +
      'other person files an application for insurance containing any materially false ' +
      'information, or conceals for the purpose of misleading information concerning ' +
      'any fact material thereto, commits a fraudulent insurance act, which is a crime, ' +
      'and shall also be subject to a civil penalty not to exceed five thousand dollars ' +
      'and the stated value of the claim for each such violation.',
  },
  {
    kind: 'paragraph',
    text:
      'By signing below, I confirm I have read, reviewed, and accepted this application ' +
      'as accurate, and I understand and agree to the statements above.',
  },
];

export const DISCLAIMER_NOTICE =
  'COVERAGE CANNOT BE BACKDATED. WE MUST RECEIVE PAYMENT AND FORMS PRIOR TO THE EFFECTIVE DATE.';

/* -------------------------------------------------------------------------- */
/* Page 19 — About Us  (REAL)                                                  */
/* -------------------------------------------------------------------------- */

export const ABOUT_US_TITLE = 'About Us';

export const ABOUT_US: CopyBlock[] = [
  {
    kind: 'paragraph',
    text:
      'Since 2007, Safeside Insurance has been dedicated to delivering dependable ' +
      'insurance solutions across all 50 states. We specialise in crafting tailored ' +
      'packages for diverse industries, including real estate, healthcare, ' +
      'manufacturing, and more.',
  },
  {
    kind: 'paragraph',
    text:
      'Our dedicated team of over 50 experienced professionals ensures every client ' +
      'receives personalized, expert service.',
  },
  {
    kind: 'paragraph',
    text:
      'We take pride in delivering exceptional support and comprehensive coverage, ' +
      'offering solutions meticulously tailored to meet each client’s unique needs.',
  },
  { kind: 'heading', text: 'Our Mission' },
  {
    kind: 'paragraph',
    text:
      'At Safeside Insurance, our mission is to provide exceptional, tailored insurance ' +
      'solutions with unmatched service. We are committed to delivering fast, reliable ' +
      'and comprehensive coverage that protects what matters most to our clients, ' +
      'ensuring peace of mind and long-term security.',
  },
  { kind: 'heading', text: 'Our Values' },
  {
    kind: 'defs',
    items: [
      { term: 'Personalized Service', text: 'Tailored insurance solutions for your unique needs.' },
      { term: 'Expert Support', text: 'Dedicated professionals specializing in various industries.' },
      { term: 'Fast Turnaround', text: 'Quick responses and efficient processing to meet your needs.' },
      { term: 'Reliable Coverage', text: 'Comprehensive insurance options to safeguard what matters most.' },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Page 20 — Our Team                                                          */
/* -------------------------------------------------------------------------- */

export const OUR_TEAM_TITLE = 'Our Team - Business';

export const OUR_TEAM: CopyBlock[] = [
  {
    kind: 'paragraph',
    text:
      'At Safeside, we understand that each sector has unique requirements. Our team of ' +
      'insurance professionals is dedicated to understanding your challenges and ' +
      'providing solutions that offer peace of mind.',
  },
  {
    kind: 'paragraph',
    text:
      'It is about protecting what matters most to you. Whether you are safeguarding ' +
      'your business, property, home, or family, we are committed to offering ' +
      'personalized service and expert guidance every step of the way.',
  },
  {
    kind: 'paragraph',
    text: 'Please do not hesitate to reach out with any questions or concerns.',
  },
  { kind: 'heading', text: 'Your Service Team' },
  {
    /*
     * Safeside's real Business-department contacts, read from the staff directory
     * page in their own proposals. Not invented, and not client data.
     *
     * The real page prints the account executive assigned to THIS client, which
     * varies per proposal and is not derivable from a quote. Until the tool can
     * capture that, every commercial proposal gets the Business department's
     * shared contacts — correct for the client to use, just not personalised.
     * Replace with a per-proposal roster when Safeside decides how it is assigned.
     */
    kind: 'defs',
    items: [
      { term: 'New Business', text: 'bnb@safesideins.com — for the quickest response' },
      { term: 'Business Service', text: 'bizservice@safesideins.com — for the quickest response' },
      { term: 'Toby Wettenstein', text: 'Account Executive · toby@safesideins.com' },
      { term: 'Peri Kahan', text: 'Account Executive · peri@safesideins.com' },
      { term: 'Becky Silberman', text: 'Customer Service · becky@safesideins.com' },
      { term: 'Fay Vogel', text: 'Customer Service · fay@safesideins.com' },
    ],
  },
  { kind: 'heading', text: 'Additional Contacts' },
  {
    kind: 'defs',
    items: [
      { term: 'Harry Schonfeld', text: 'President & CEO · harry@safesideins.com' },
      { term: 'Goldie Glauber', text: 'Director of Operations · goldie@safesideins.com' },
      { term: 'Accounting', text: 'accounting@safesideins.com' },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Page 21 — Employee Directory                                                */
/* -------------------------------------------------------------------------- */

export const EMPLOYEE_DIRECTORY_TITLE = 'Employee Directory';

export const EMPLOYEE_DIRECTORY: CopyBlock[] = [
  {
    /*
     * In the real template this page is a single placed image of the directory, so
     * there is no text to transcribe even in principle.
     */
    kind: 'placeholder',
    what: 'Employee directory',
    why:
      'The real page is a placed image of the brokerage directory, so there is no ' +
      'text in the source to transcribe. Supply either the artwork or a structured ' +
      'staff list the template can typeset.',
  },
];

/* -------------------------------------------------------------------------- */
/* Page 22 — Back page  (REAL)                                                 */
/* -------------------------------------------------------------------------- */

export const BACK_PAGE = {
  brand: 'Safeside Insurance Brokerage Inc.',
  address: ['368 New Hempstead Rd, Suite 301', 'New City, NY 10956'],
  contact: [
    { label: 'Telephone', value: '(845) 364-0000' },
    { label: 'Fax', value: '(845) 678-3656' },
    { label: 'Email', value: 'info@safesideins.com' },
    { label: 'Web', value: 'www.safesideins.com' },
  ],
};
