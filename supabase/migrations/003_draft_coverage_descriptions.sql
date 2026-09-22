-- 003_draft_coverage_descriptions.sql
--
-- Draft copy for the eleven coverage types that had none.
--
-- Migration 002 transcribed Safeside's own wording from their proposals, which
-- covers General Liability, Property, Workers Compensation, Disability/PFL and
-- Errors & Omissions. The rest — including business_owners_policy, the most
-- common line in the sample corpus — had no Safeside wording anywhere, and were
-- left empty rather than invented.
--
-- These are DRAFTS. They are plain-English descriptions of what each coverage
-- does, written to be edited, and every one is flagged is_draft so the tool can
-- say so rather than presenting them as Safeside's own voice. The distinction
-- matters: copy that reads as finished does not get proofread.

alter table sp_coverage_descriptions
  add column if not exists is_draft boolean not null default false;

comment on column sp_coverage_descriptions.is_draft is
  'True for placeholder copy awaiting Safeside''s own wording. Surfaced in the UI and marked in the generated document.';

-- Anything already present came from Safeside's real proposals.
update sp_coverage_descriptions set is_draft = false where is_draft is null;

insert into sp_coverage_descriptions (line_type, heading, body, display_order, is_draft) values

-- Business Owners Policy — the most common line in the corpus and, until now,
-- the one with no description at all.
('business_owners_policy', 'Business Owners Policy',
 'A packaged policy combining property and general liability cover for small and mid-sized businesses. It protects the premises, contents and equipment, and covers claims brought against the business for injury or damage to others.', 10, true),
('business_owners_policy', 'Business Income',
 'Replaces income lost while the premises cannot be used after covered damage, and pays the extra costs of continuing to trade in the meantime.', 20, true),

('commercial_auto', 'Commercial Auto Liability',
 'Covers injury and property damage the business is liable for arising from vehicles it owns, hires or borrows.', 10, true),
('commercial_auto', 'Physical Damage',
 'Covers damage to the business''s own vehicles, whether from collision or from other causes such as fire, theft or weather.', 20, true),

('umbrella', 'Umbrella Liability',
 'Adds a further limit above the underlying general liability, auto and employers liability policies, responding once those limits are exhausted.', 10, true),

('excess_liability', 'Excess Liability',
 'Provides additional limit above a specified underlying policy. It follows that policy''s terms and responds only after its limit is used up.', 10, true),

('professional_liability', 'Professional Liability',
 'Covers claims that professional advice or services caused a client financial loss, including the cost of defending them.', 10, true),

('cyber', 'Cyber Liability',
 'Responds to a data breach or cyber attack: notifying affected people, restoring data and systems, business interruption, and liability to third parties.', 10, true),
('cyber', 'Funds Transfer Fraud',
 'Covers money lost when an employee is deceived into transferring funds to a fraudulent account.', 20, true),

('crime', 'Commercial Crime',
 'Covers loss of money, securities and property from employee dishonesty, forgery, theft, and computer or funds-transfer fraud.', 10, true),

('inland_marine', 'Inland Marine',
 'Covers property that moves or sits away from the premises — tools, equipment, stock in transit and property in the care of others.', 10, true),

('flood', 'Flood',
 'Covers damage from rising surface water, which standard property policies exclude. Written separately, usually with its own waiting period before cover begins.', 10, true),

('employment_practices', 'Employment Practices Liability',
 'Covers claims by employees and applicants over wrongful termination, discrimination, harassment and related employment matters, including defence costs.', 10, true),

('liquor_liability', 'Liquor Liability',
 'Covers claims arising from serving alcohol, which general liability excludes for businesses that sell or serve it.', 10, true),

('errors_omissions', 'Errors & Omissions',
 'Covers claims that a mistake or omission in the services provided caused a client financial loss.', 90, true)

on conflict do nothing;
