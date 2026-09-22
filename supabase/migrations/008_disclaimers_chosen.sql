-- 008_disclaimers_chosen.sql
--
-- Distinguish "the broker has not looked at this yet" from "the broker looked and
-- chose none".
--
-- 006 seeded the disclaimer library with a default_on flag so a proposal nobody
-- touched still carries the clause that appears on three of Safeside's four
-- sample proposals. The absence of rows in sp_proposal_disclaimers was standing in
-- for "never chosen" — which means a broker who deliberately unticks everything
-- gets the default back on the next load, and it silently reappears in the
-- document. There is no way to say "none".
--
-- A flag on the proposal separates the two states. Set when a selection is saved,
-- whatever that selection contains.

alter table sp_proposals
  add column disclaimers_chosen boolean not null default false;

comment on column sp_proposals.disclaimers_chosen is
  'True once a broker has saved a premium-disclaimer selection, including an empty one. While false, sp_premium_disclaimers.default_on applies.';

-- Existing proposals that already have a selection have plainly been chosen.
update sp_proposals p set disclaimers_chosen = true
 where exists (select 1 from sp_proposal_disclaimers d where d.proposal_id = p.id);
