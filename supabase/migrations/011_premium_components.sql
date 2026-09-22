-- 011_premium_components.sql
--
-- Keep the premium breakdown alongside the figure, so the arithmetic can be
-- checked.
--
-- A real property quote stated "Non-Admitted Premium $70,949" on the
-- carrier's page and "Total Policy Cost $86,154.64" on the summary page, the
-- difference being surplus lines tax and two policy fees. Extraction took the
-- first. Safeside's own proposal used the second. The tool would have quoted the
-- client $22,246 under the real cost across the two lines.
--
-- What makes it detectable without trusting the model twice: extraction had
-- already itemised the fees it left out. The components summed to $78,644 while
-- the premium it stored was $70,949 — the breakdown contradicted the figure. The
-- prompt has always said the components must sum to the premium, so this is
-- arithmetic anyone can check, and checking it does not depend on the model
-- having got the premium right.
--
-- Storing them is what makes that check possible on the review screen, where a
-- broker can still do something about it.

alter table sp_lines
  add column premium_components jsonb not null default '[]'::jsonb;

comment on column sp_lines.premium_components is
  'Itemised premium parts as extracted. Should sum to carrier_premium; the review screen warns when it does not.';
