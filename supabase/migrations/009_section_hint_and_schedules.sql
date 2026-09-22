-- 009_section_hint_and_schedules.sql
--
-- Two changes, both about coverage pages carrying what Safeside's own do.
--
-- 1. section_hint was never persisted.
--
--    Extraction tags every detail as belonging to the liability or the property
--    half of a packaged policy, and packages/shared/src/sections.ts treats that
--    tag as authoritative — with a keyword matcher behind it described in the
--    code as a safety net "for older extractions predating the hint".
--
--    There was no column to store it in, so the hint was discarded on write and
--    every read fell back to the safety net. The net catches most rows and drops
--    the ones it cannot classify: "Property Deductible" matches no liability or
--    property keyword, lands on the General Liability page by the
--    unclassified-goes-first rule, fails that page's headline filter and is
--    dropped. The broker saw the deductible on review; the client's document did
--    not have it.
--
-- 2. The coverage pages carry structured schedules, not just a limits list.
--
--    Read off eleven of Safeside's own proposals:
--      General Liability  — Liability Classification            (9/11)
--      Property           — Premise Information                 (6/11)
--                         — Subjects of Insurance               (6/11)
--      Workers Comp       — States, Employers Liability,
--                           WC Rating Basis, Individuals        (4/11)
--
--    One jsonb object per line rather than a column each: they are display-only
--    carrier tables, nothing joins to them, and a column per schedule would mean
--    a migration every time Safeside adds a row type.

alter table sp_line_details
  add column section_hint text
    check (section_hint is null or section_hint in ('liability', 'property'));

comment on column sp_line_details.section_hint is
  'Which half of a packaged policy this detail belongs to, as extraction tagged it. Authoritative; the keyword classifier in sections.ts is only a fallback for rows this is null on.';

alter table sp_lines
  add column schedules jsonb not null default '{}'::jsonb;

comment on column sp_lines.schedules is
  'Structured tables for this line''s coverage page: {classifications, premises, subjects_of_insurance, states, employers_liability, rating_basis, individuals}. Carrier-supplied, printed as-is.';

-- classifications had its own column in 007. Fold it in, so every schedule lives
-- in one place rather than one of seven being special.
update sp_lines
   set schedules = jsonb_build_object('classifications', classifications)
 where classifications is not null
   and jsonb_array_length(classifications) > 0;

alter table sp_lines drop column classifications;
