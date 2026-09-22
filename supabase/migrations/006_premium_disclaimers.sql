-- 006_premium_disclaimers.sql
--
-- Disclaimers on the premium page are chosen per proposal, not fixed copy.
--
-- Across four sample proposals they differ: one carries four clauses about
-- payroll, audit, officer inclusion and subcontractors; the others carry
-- "Minimum Deposit applies if the policy is rated by payroll or sales", some with
-- "Action Over" alongside.
--
-- It is not derivable from the lines quoted either — one proposal with a workers
-- compensation line carries none of the payroll clauses. So it is a broker
-- judgement, and it needs a library with a per-proposal selection, exactly like
-- coverage recommendations.

create table sp_premium_disclaimers (
  id            uuid primary key default gen_random_uuid(),
  label         text not null,
  body          text not null,
  /** Ticked by default on a new proposal. */
  default_on    boolean not null default false,
  display_order integer not null default 100,
  is_active     boolean not null default true,
  updated_at    timestamptz not null default now()
);

create table sp_proposal_disclaimers (
  proposal_id   uuid not null references sp_proposals(id) on delete cascade,
  disclaimer_id uuid not null references sp_premium_disclaimers(id) on delete cascade,
  display_order integer not null default 100,
  primary key (proposal_id, disclaimer_id)
);

create trigger sp_premium_disclaimers_touch
  before update on sp_premium_disclaimers
  for each row execute function sp_touch_updated_at();

alter table sp_premium_disclaimers enable row level security;
alter table sp_premium_disclaimers force row level security;
alter table sp_proposal_disclaimers enable row level security;
alter table sp_proposal_disclaimers force row level security;

-- Transcribed from Safeside's own premium pages. Every one of these appears
-- verbatim in at least one sample proposal.
insert into sp_premium_disclaimers (label, body, default_on, display_order) values
  ('Minimum Deposit',
   'Minimum Deposit applies if the policy is rated by payroll or sales',
   true, 10),

  ('Action Over',
   'Action Over',
   false, 20),

  ('States disclosed',
   'Coverage is based on the locations and states disclosed. Any operations, employees, or work performed in additional states must be reported to ensure proper coverage.',
   false, 30),

  ('Owner inclusion (WC)',
   'Owner inclusion or exclusion under Workers Compensation is governed by state regulations. In New York, corporate officers are automatically included unless a signed exclusion form is on file.',
   false, 40),

  ('Payroll audit',
   'This policy is rated on estimated payroll and will be audited at policy expiration. Premiums may increase or decrease based on actual payroll figures.',
   false, 50),

  ('Subcontractors',
   'Any subcontractors without proof of insurance may be counted toward payroll during the audit.',
   false, 60);
