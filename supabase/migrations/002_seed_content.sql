-- 002_seed_content.sql
-- Boilerplate copy libraries, transcribed from Safeside's existing proposals.
--
-- Everything below is Safeside's OWN standing wording, lifted from the redesigned
-- proposal template (and, for Errors & Omissions, from the older Word template that
-- the redesign has not yet replaced). No client-specific value appears here: no
-- named insured, address, FEIN, premium, fee amount or policy number. Passages that
-- carried one in the source have been generalised.
--
-- This is seed data, not source of truth. The wording is meant to be corrected in
-- the app, on the boilerplate screens, rather than edited here and redeployed — that
-- is the whole reason sp_coverage_descriptions and sp_recommendations are tables and
-- not constants in packages/shared. Re-running this migration will not clobber those
-- edits: every insert below is guarded so it adds only rows that are missing.

-- ---------------------------------------------------------------------------
-- 1. Line types
-- ---------------------------------------------------------------------------
-- display_order follows the order the redesign presents sections in — General
-- Liability, Property, Workers Compensation, Disability / PFL — with the coverage
-- types the redesign has no sample for ordered after those, and 'other' last so an
-- unrecognised line sorts to the bottom of the document.

insert into sp_line_types (code, label, section_title, display_order) values
  ('general_liability',    'General Liability',               'General Liability Coverage',               10),
  ('property',             'Property',                        'Property Coverage',                        20),
  ('business_owners_policy','Business Owner''s Policy',       'Business Owner''s Policy Coverage',        30),
  ('workers_comp',         'Workers Compensation',            'Workers Compensation Coverage',            40),
  ('disability_pfl',       'Disability / Paid Family Leave',  'Disability / Paid Family Leave Coverage',  50),
  ('commercial_auto',      'Commercial Auto',                 'Commercial Auto Coverage',                 60),
  ('umbrella',             'Umbrella',                        'Umbrella Coverage',                        70),
  ('excess_liability',     'Excess Liability',                'Excess Liability Coverage',                80),
  ('professional_liability','Professional Liability',         'Professional Liability Coverage',          90),
  ('errors_omissions',     'Errors & Omissions',              'Errors & Omissions Coverage',             100),
  ('cyber',                'Cyber Liability',                 'Cyber Liability Coverage',                110),
  ('crime',                'Commercial Crime',                'Commercial Crime Coverage',               120),
  ('inland_marine',        'Inland Marine',                   'Inland Marine Coverage',                  130),
  ('flood',                'Flood',                           'Flood Coverage',                          140),
  ('employment_practices', 'Employment Practices Liability',  'Employment Practices Liability Coverage', 150),
  ('liquor_liability',     'Liquor Liability',                'Liquor Liability Coverage',               160),
  ('other',                'Additional Coverage',             'Additional Coverage',                     900)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Key Coverage Descriptions
-- ---------------------------------------------------------------------------
-- The redesign's "Key Coverage Descriptions" pages. Each row is one line of those
-- pages: the term on the left, the explanation on the right. The first row under
-- each line_type is the coverage itself; the rows after it explain the limits and
-- conditions that appear on that coverage's page.
--
-- Only four coverage types have descriptions in the samples (general_liability,
-- property, workers_comp, disability_pfl) plus errors_omissions from the older
-- template. The remaining line types have no Safeside wording to transcribe and are
-- deliberately left empty rather than invented — they should be written in-app.
--
-- line_type 'other' additionally holds the document-level standing blocks that have
-- no per-coverage home: the Policy Terms & Key Conditions page, the NY Regulation
-- 194 disclosure, the Minimum Earned acknowledgement, and the lead-in and
-- acknowledgement that frame the Coverage Recommendations page.

insert into sp_coverage_descriptions (line_type, heading, body, display_order)
select v.line_type, v.heading, v.body, v.display_order
from (values

  -- General Liability ------------------------------------------------------
  ('general_liability', 'General Liability',
   'Covers legal expenses and damages if your business is held liable for bodily injury or property damage to others occurring on your premises or caused by your operations.', 10),
  ('general_liability', 'General Aggregate',
   'The total limit available for all claims combined within a policy term.', 20),
  ('general_liability', 'Each Occurrence',
   'The most the insurer will pay for all damages from one event.', 30),
  ('general_liability', 'Fire Damage',
   'Protection for losses caused by fire to covered property.', 40),
  ('general_liability', 'Medical Expense',
   'Provides coverage for medical treatment of third-party injuries without requiring legal action.', 50),
  ('general_liability', 'Products / Completed Ops',
   'Covers liability for injuries or damage caused by your products or completed work.', 60),
  ('general_liability', 'Personal & Advertising Injury',
   'Covers liability for claims like slander or copyright infringement in your advertising.', 70),

  -- Property ---------------------------------------------------------------
  ('property', 'Property Insurance',
   'Protects your business building, equipment, furniture, and inventory against damage or loss caused by covered perils.', 10),
  ('property', 'Business Income',
   'Reimburses lost income and helps cover ongoing expenses if your business operations are disrupted due to a covered property loss.', 20),
  ('property', 'Deductible',
   'The portion of a covered loss you pay before your insurance coverage applies.', 30),
  ('property', 'Cause of Loss',
   'Defines the covered perils for your property insurance, such as fire, theft, or windstorm.', 40),
  ('property', 'Valuation',
   'Determines the basis for payment after a loss, such as replacement cost or actual cash value.', 50),
  ('property', 'Coinsurance',
   'The percentage of covered costs the policyholder must pay after the deductible, with the insurer paying the remaining share.', 60),

  -- Workers Compensation ---------------------------------------------------
  ('workers_comp', 'Workers Compensation',
   'Covers medical expenses and lost wages for employees injured on the job, as required by state law.', 10),
  ('workers_comp', 'Employers Liability',
   'Protects the employer against lawsuits by employees or their families for work-related injuries or illnesses not fully covered under workers compensation.', 20),

  -- Disability / Paid Family Leave -----------------------------------------
  -- The redesign prints these two beneath Workers Compensation, but they are their
  -- own coverage line and their own section, so they are keyed to disability_pfl.
  ('disability_pfl', 'Disability (DBL)',
   'Covers a portion of an employee''s wages if they are unable to work due to a non-work-related illness or injury.', 10),
  ('disability_pfl', 'Paid Family Leave (PFL)',
   'Provides paid time off to care for a family member, bond with a new child, or handle qualifying military family needs.', 20),

  -- Errors & Omissions (older template; no redesign sample exists yet) -------
  ('errors_omissions', 'Errors & Omissions',
   'Protects professionals from claims alleging errors, omissions, or negligence in their services.', 10),
  ('errors_omissions', 'General Aggregate',
   'The total limit available for all claims combined within a policy term.', 20),
  ('errors_omissions', 'Each Occurrence',
   'The most the insurer will pay for all damages from one event.', 30),
  ('errors_omissions', 'Retro Date',
   'The retroactive date is when incidents are covered under a claims-made policy. Any incident occurring before this date will not be covered.', 40),

  -- Document-level standing blocks -----------------------------------------
  ('other', 'Policy Terms & Key Conditions',
   'Coverage is subject to the terms, conditions, exclusions, and endorsements of the issued policies. Key points include:

01 Named Insured — Coverage applies only to the legal entity(ies) listed as named insured on the policy. If ownership or entity changes, coverage must be updated immediately.

02 Construction or Renovation — If any construction, renovation, or major repairs are being performed at the insured location, coverage terms may change and certain losses may be excluded. Notify us before work begins to ensure proper coverage is in place.

03 Vacancy — Extended vacancy (typically over 60 days) may limit or exclude coverage for certain perils. Notify us immediately of any vacancy.

04 Occupancy — Occupancy changes may nullify coverage. Notify us immediately of any occupancy changes.

05 Protective Safeguards — Required safety systems must be maintained.

06 Flood / Earthquake — Not included unless purchased separately.

07 Endorsements & Exclusions — Policies contain certain specific endorsements and exclusions that may add, limit, or remove coverage.

08 Review Responsibility — It is the insured''s responsibility to review policy documents upon receipt to ensure accuracy.', 800),

  ('other', 'NY Regulation 194 Disclosure & Payment Authorization',
   'Safeside Insurance is acting as your insurance broker. We represent you in your search for insurance coverage and may also work with insurance companies to obtain quotes and place coverage on your behalf. Our compensation may be from the insurance company, from you, or both. The primary source of our compensation is a commission paid by the insurance company, which is based on the premium you pay. We may also receive a service fee from you, as agreed in writing. In addition, we may receive other forms of compensation from insurance companies based on factors like the volume or profitability of the business we place with them. You may request more detailed information about the compensation we expect to receive in connection with your policy.

Authorization is hereby given to charge the service/policy fee stated in this proposal. I understand the broker fee is separate from and in addition to the insurance premium, is fully earned upon binding or renewal, and is non-refundable.', 810),

  ('other', 'Minimum Earned',
   'I hereby acknowledge and agree to the terms outlined below regarding the minimum earned policy and responsibility for payment collection failure associated with the insurance policy issued by Safeside Insurance Brokerage Inc.

01 Minimum Earned Policy — Upon issuance of the insurance policy, there is a minimum earned premium requirement, regardless of the duration for which the policy remains in force. Once the policy is issued, a portion of the premium becomes non-refundable, irrespective of any subsequent adjustments or cancellations.

02 Responsibility for Payment Collection Failure — It is my responsibility to ensure that premium is collected. If Safeside Insurance Brokerage Inc is unable to collect the premiums due to insufficient funds or for any other reason, I accept full responsibility for the outstanding payment.

03 Agreement to Resolve Payment Collection Issues — I agree to promptly address any issues related to payment collection, including providing updated bank account or credit card information, resolving insufficient fund situations, or making alternative payment arrangements as necessary.

04 Liability for Unpaid Premiums — Failure to fulfill payment obligations may result in consequences such as loss of coverage and potential legal action to recover unpaid premiums.', 820),

  ('other', 'Coverage Recommendations Introduction',
   'Your current quote delivers strong coverage for many common risks; however, certain events may still fall outside the scope of this policy. To help further protect your business, we recommend reviewing the additional coverages below. Please reach out for more details or tailored options.', 830),

  ('other', 'Acknowledgement by Insured',
   'I have reviewed the recommended coverages provided to me and have chosen not to purchase one or more of them at this time. I understand that any loss, damage, or expense related to the coverages I have declined will not be covered under my current insurance policy.', 840)

) as v(line_type, heading, body, display_order)
where not exists (
  select 1 from sp_coverage_descriptions d
  where d.line_type = v.line_type and d.heading = v.heading
);

-- ---------------------------------------------------------------------------
-- 3. Coverage Recommendations
-- ---------------------------------------------------------------------------
-- The redesign's "Coverage Recommendations" table, in its own order. Each row is
-- something the broker offers when the coverage is NOT in the quote, so
-- suggest_when_line_absent names the line whose absence should surface it.
--
-- It is null where the recommendation does not map onto one of the canonical line
-- types — Directors & Officers, Pollution, Ocean Marine and Trade / Accounts
-- Receivable have no code, and Product Liability is normally part of a General
-- Liability line rather than a line of its own, so keying it to a missing line would
-- suppress it on exactly the proposals that should offer it. A null here means the
-- broker picks it by hand rather than it being suggested automatically.

insert into sp_recommendations (label, body, suggest_when_line_absent, display_order)
select v.label, v.body, v.suggest_when_line_absent, v.display_order
from (values

  ('Flood & Earthquake',
   'Provides coverage against events typically excluded from standard policies, including floods, earthquakes, and other natural disasters.',
   'flood', 10),

  ('Excess Liability',
   'Provides additional liability coverage beyond the limits of standard policies, protecting the business against large or unexpected claims.',
   'excess_liability', 20),

  ('Employment Practices Liability (EPLI)',
   'Protects the business against claims related to employment practices such as discrimination, harassment, or wrongful termination.',
   'employment_practices', 30),

  ('Professional Liability (E&O)',
   'Protects against claims of professional mistakes or negligence.',
   'professional_liability', 40),

  ('Directors & Officers',
   'Protects directors and officers against claims arising from management decisions.',
   null, 50),

  ('Cyber Liability',
   'Covers losses and claims from data breaches or cyber attacks.',
   'cyber', 60),

  ('Commercial Crime',
   'Protects the business against theft, fraud, or employee dishonesty.',
   'crime', 70),

  ('Product Liability',
   'Covers claims from injury or damage caused by products.',
   null, 80),

  ('Pollution Liability',
   'Covers claims from environmental damage or pollution incidents.',
   null, 90),

  ('Inland Marine',
   'Covers equipment, goods, and valuables outside the premises.',
   'inland_marine', 100),

  ('Ocean Marine',
   'Covers goods and cargo in transit over water.',
   null, 110),

  ('Trade / Accounts Receivable',
   'Protects the business against loss of money owed by customers due to insolvency or default.',
   null, 120)

) as v(label, body, suggest_when_line_absent, display_order)
where not exists (
  select 1 from sp_recommendations r where r.label = v.label
);
