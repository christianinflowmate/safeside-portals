-- 007_schedules_and_admitted.sql
--
-- Three things Safeside's own proposals print that we were not capturing.
--
-- 1. Admitted / Non-Admitted, a column on the premium table. This is the
--    regulatory status of the POLICY, not the identity of the carrier writing it,
--    so it is not carrier information under the brief's rule. A client is entitled
--    to know whether a policy is backed by the state guaranty fund.
--
-- 2. The liability classification schedule — location, classification, class code,
--    exposure, rating basis. Per line, because a WC class code belongs to the WC
--    line and a GL one to the GL line.
--
-- 3. The premise schedule — location, address, city, state, zip. Per proposal,
--    because it describes the insured's own sites, not any one policy.
--
-- Both schedules are stored as jsonb rather than as tables. They are display-only
-- carrier-supplied schedules: nothing joins to a class code, nothing aggregates a
-- premise, and the broker edits them as whole rows or not at all. A table each
-- would add two entities and their access-control paths for no query we ever make.

-- 1 ---------------------------------------------------------------------------
-- Constrained rather than free text: the premium table prints this verbatim, and
-- a typo'd "Non Admited" reaches a client.
alter table sp_lines
  add column admitted text
    check (admitted is null or admitted in ('admitted', 'non_admitted'));

comment on column sp_lines.admitted is
  'Regulatory status of the policy. Null means the quote did not state it, and the column is then omitted from the premium table entirely rather than printed blank.';

-- 2 ---------------------------------------------------------------------------
alter table sp_lines
  add column classifications jsonb not null default '[]'::jsonb;

comment on column sp_lines.classifications is
  'Liability classification schedule: [{location, classification, class_code, exposure, rating_basis}]. Carrier-supplied, printed as-is.';

-- 3 ---------------------------------------------------------------------------
alter table sp_customers
  add column premises jsonb not null default '[]'::jsonb;

comment on column sp_customers.premises is
  'Premise schedule: [{location, address, city, state, zip}]. The insured own sites.';
