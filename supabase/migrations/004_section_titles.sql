-- 004_section_titles.sql
--
-- Match Safeside's own section headings.
--
-- Comparing a generated proposal against the real one page by page, the coverage
-- pages are titled "Business General Liability Coverage", not "General Liability
-- Coverage". The "Business" prefix distinguishes the commercial department's
-- pages from the personal lines ones, and it appears on every coverage section in
-- every sample proposal.

update sp_line_types set section_title = 'Business General Liability Coverage'      where code = 'general_liability';
update sp_line_types set section_title = 'Business Property Coverage'               where code = 'property';
update sp_line_types set section_title = 'Business Workers Compensation Coverage'   where code = 'workers_comp';
update sp_line_types set section_title = 'Business Disability / Paid Family Leave Coverage' where code = 'disability_pfl';
update sp_line_types set section_title = 'Business Auto Coverage'                   where code = 'commercial_auto';
update sp_line_types set section_title = 'Business Umbrella Coverage'               where code = 'umbrella';
update sp_line_types set section_title = 'Business Excess Liability Coverage'       where code = 'excess_liability';
update sp_line_types set section_title = 'Business Professional Liability Coverage' where code = 'professional_liability';
update sp_line_types set section_title = 'Business Errors & Omissions Coverage'     where code = 'errors_omissions';
update sp_line_types set section_title = 'Business Cyber Coverage'                  where code = 'cyber';
update sp_line_types set section_title = 'Business Crime Coverage'                  where code = 'crime';
update sp_line_types set section_title = 'Business Inland Marine Coverage'          where code = 'inland_marine';
update sp_line_types set section_title = 'Business Flood Coverage'                  where code = 'flood';
update sp_line_types set section_title = 'Business Employment Practices Coverage'   where code = 'employment_practices';
update sp_line_types set section_title = 'Business Liquor Liability Coverage'       where code = 'liquor_liability';

-- ---------------------------------------------------------------------------
-- Which details reach the client document
-- ---------------------------------------------------------------------------

-- Extraction is thorough on purpose: a broker reviewing a quote wants every limit
-- the carrier listed. Safeside's proposal is not — their four coverage pages carry
-- roughly fourteen figures where ours carry sixty-one, because they print the
-- headline limits and leave the rest to the policy.
--
-- So a detail now records whether it is headline. Everything is shown on the
-- review screen; only headline rows print. Defaulting to TRUE keeps current
-- behaviour until Safeside says which limits are headline for each line — picking
-- that list by guesswork would silently drop limits from a client's document,
-- which is the worst failure available here.
alter table sp_line_details
  add column if not exists is_headline boolean not null default true;

comment on column sp_line_details.is_headline is
  'True if this row prints in the client document. False rows stay visible on the review screen only. Defaults true: dropping a limit silently is worse than printing too many.';
