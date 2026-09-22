-- 012_premises_editable.sql
--
-- Let the premise schedule say "none", and tell that apart from "not yet set".
--
-- The column has been written by nothing since it was added in 007: the printed
-- Premise Information table is read straight out of the extraction JSON, so the
-- column sat at its '[]' default on every row. That was harmless while nothing
-- read it. It stops being harmless the moment a broker can edit the table,
-- because '[]' then has two meanings — "extraction found no premises, fall back"
-- and "the broker deleted every row" — and choosing the fallback would restore
-- rows they had just removed.
--
-- So: null means untouched, and anything else is the broker's answer, including
-- an empty array. The same distinction sp_proposals.disclaimers_chosen draws for
-- the same reason.
--
-- Backfilling every '[]' to null is safe precisely because nothing ever wrote
-- one: they are all the default, not a decision.

alter table sp_customers alter column premises drop not null;
alter table sp_customers alter column premises set default null;

update sp_customers set premises = null where premises = '[]'::jsonb;

comment on column sp_customers.premises is
  'Premise schedule. NULL means the broker has not touched it, so the merged extraction is used. Any array — empty included — is their answer.';
