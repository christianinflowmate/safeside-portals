-- 001_initial_schema.sql
-- Safeside Proposal Tool v1 — initial schema.
--
-- Every table is prefixed sp_ so this schema stays separable from anything else
-- that later lands in the same Postgres instance.
--
-- Two conventions matter throughout:
--
--   1. Extracted vs confirmed. Extraction writes ONLY to sp_extractions. Nothing
--      the model produces lands in sp_customers / sp_lines / sp_line_details until
--      a human confirms it on the review screen. That way re-running extraction can
--      never overwrite a broker's edits.
--
--   2. Carrier-facing vs client-facing. Columns marked INTERNAL ONLY hold carrier
--      identity and pricing detail that must never reach the generated proposal.
--      The document renderer reads from an explicit field whitelist; see
--      packages/shared/src/document-whitelist.ts.

-- gen_random_uuid()
create extension if not exists "pgcrypto";
-- citext, for case-insensitive email uniqueness on sp_users. Without this the
-- sp_users.email column type does not exist and the whole migration fails.
create extension if not exists "citext";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Proposal status is deliberately just these two, per the brief. Transient states
-- (analyzing, extraction failed) are derived from sp_files.extraction_status at
-- read time rather than denormalised here, so there is one source of truth.
create type sp_proposal_status as enum ('draft', 'generated');

create type sp_extraction_status as enum ('pending', 'running', 'succeeded', 'failed');

create type sp_job_status as enum ('queued', 'running', 'succeeded', 'failed');

-- What a row in sp_line_details represents. Endorsements/exclusions/forms are
-- collected across lines to build the "Forms, Endorsements & Exclusions" section.
create type sp_detail_kind as enum ('limit', 'deductible', 'endorsement', 'exclusion', 'form', 'condition');

-- ---------------------------------------------------------------------------
-- Users and sessions
-- ---------------------------------------------------------------------------

create table sp_users (
  id              uuid primary key default gen_random_uuid(),
  email           citext not null unique,
  password_hash   text not null,                  -- Argon2id
  display_name    text not null,
  is_active       boolean not null default true,
  is_admin        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Server-side sessions. The cookie carries an opaque random token; only its hash
-- is stored, so a database leak does not hand over live sessions.
create table sp_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references sp_users(id) on delete cascade,
  token_hash      text not null unique,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  user_agent      text,
  ip              inet
);

create index sp_sessions_user_idx on sp_sessions(user_id);
create index sp_sessions_expires_idx on sp_sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Proposals
-- ---------------------------------------------------------------------------

create table sp_proposals (
  id                  uuid primary key default gen_random_uuid(),
  owner_user_id       uuid not null references sp_users(id) on delete restrict,
  client_name         text not null default 'Untitled proposal',
  status              sp_proposal_status not null default 'draft',

  -- Free-text block appended under the generated Coverage Recommendations page,
  -- after any library recommendations the broker selected.
  recommendations_note text,

  -- Broker-authored notes for the "Policy Terms & Key Conditions" page.
  terms_note          text,

  confirmed_at        timestamptz,
  confirmed_by        uuid references sp_users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index sp_proposals_owner_idx on sp_proposals(owner_user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Uploaded files
-- ---------------------------------------------------------------------------

-- Uploaded quotes are written once and never modified. There is deliberately no
-- updated_at and no content column: the bytes live in Supabase Storage and are
-- read-only from the moment they land.
create table sp_files (
  id                uuid primary key default gen_random_uuid(),
  proposal_id       uuid not null references sp_proposals(id) on delete cascade,
  original_filename text not null,
  storage_path      text not null unique,
  size_bytes        bigint not null,
  mime_type         text not null,
  page_count        integer,
  sha256            text,
  extraction_status sp_extraction_status not null default 'pending',
  error_text        text,
  uploaded_by       uuid not null references sp_users(id),
  created_at        timestamptz not null default now()
);

create index sp_files_proposal_idx on sp_files(proposal_id);

-- ---------------------------------------------------------------------------
-- Extractions (append-only)
-- ---------------------------------------------------------------------------

-- One row per extraction attempt per file. Never updated in place beyond its own
-- completion, never deleted. When a field comes out wrong, the raw response is the
-- only way to find out why.
create table sp_extractions (
  id              uuid primary key default gen_random_uuid(),
  file_id         uuid not null references sp_files(id) on delete cascade,
  proposal_id     uuid not null references sp_proposals(id) on delete cascade,
  provider        text not null,                  -- 'anthropic' | 'fake'
  model           text,
  status          sp_extraction_status not null default 'pending',
  raw_response    jsonb,                          -- verbatim provider response
  parsed          jsonb,                          -- validated against ExtractionResult
  input_tokens    integer,
  output_tokens   integer,
  error_text      text,
  started_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index sp_extractions_file_idx on sp_extractions(file_id, started_at desc);
create index sp_extractions_proposal_idx on sp_extractions(proposal_id);

-- ---------------------------------------------------------------------------
-- Confirmed customer block
-- ---------------------------------------------------------------------------

-- Every field nullable: the review screen shows blanks flagged rather than hidden,
-- and a broker may legitimately generate with some of these empty.
create table sp_customers (
  proposal_id         uuid primary key references sp_proposals(id) on delete cascade,
  named_insured       text,
  dba                 text,
  mailing_address     text,
  location_address    text,
  contact_name        text,
  contact_phone       text,
  contact_email       text,
  fein                text,
  entity_type         text,
  business_description text,
  effective_date      date,
  expiration_date     date,

  -- Per-field provenance: confidence, whether the model found it, and any
  -- disagreement between source files that the broker resolved.
  -- Shape: { "<field>": { "confidence": 0.0-1.0, "found": bool,
  --                       "conflicts": [{"value": "...", "file_id": "..."}] } }
  field_meta          jsonb not null default '{}'::jsonb,

  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Coverage lines
-- ---------------------------------------------------------------------------

-- line_type is free text rather than an enum on purpose: an unexpected coverage
-- type coming back from extraction must not hard-fail the run. Canonical types
-- live in sp_line_types for ordering and boilerplate lookup, without a FK.
create table sp_line_types (
  code          text primary key,          -- 'general_liability', 'workers_comp', ...
  label         text not null,             -- 'General Liability'
  section_title text not null,             -- 'General Liability Coverage'
  display_order integer not null default 100,
  is_active     boolean not null default true
);

create table sp_lines (
  id              uuid primary key default gen_random_uuid(),
  proposal_id     uuid not null references sp_proposals(id) on delete cascade,
  line_type       text not null,
  -- The carrier's own wording for this line, preserved because brokers recognise it.
  line_type_label text,
  included        boolean not null default true,

  -- Null while more than one option exists and none has been chosen. Generation is
  -- blocked in that state; see the has_choice constraint in 002.
  selected_option_id uuid,

  -- INTERNAL ONLY. Never rendered into the client document.
  carrier_name    text,
  carrier_premium numeric(12,2),

  -- Broker fee, typed by the user. Also internal — only the combined figure ships.
  broker_fee      numeric(12,2) not null default 0,

  display_order   integer not null default 100,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index sp_lines_proposal_idx on sp_lines(proposal_id, display_order);

-- Where one quote presents the same line more than once — a higher and lower limit,
-- with and without a deductible buy-down — each version is a row here. The broker
-- must pick exactly one before the proposal can generate.
create table sp_line_options (
  id              uuid primary key default gen_random_uuid(),
  line_id         uuid not null references sp_lines(id) on delete cascade,
  label           text not null,             -- short, broker-facing: '$2M / $4M'
  carrier_premium numeric(12,2),             -- INTERNAL ONLY
  summary         jsonb not null default '{}'::jsonb,
  display_order   integer not null default 100,
  created_at      timestamptz not null default now()
);

create index sp_line_options_line_idx on sp_line_options(line_id, display_order);

alter table sp_lines
  add constraint sp_lines_selected_option_fk
  foreign key (selected_option_id) references sp_line_options(id) on delete set null;

-- Limits, deductibles, endorsements, exclusions, forms and conditions under a line.
-- Labels stay close to the carrier's own wording; rewording invites mistakes.
create table sp_line_details (
  id            uuid primary key default gen_random_uuid(),
  line_id       uuid not null references sp_lines(id) on delete cascade,
  kind          sp_detail_kind not null,
  label         text not null,
  value         text,
  display_order integer not null default 100,
  -- False when the model flagged this as low confidence, so the review screen can
  -- highlight it. Carried through confirmation for audit, not shown to the client.
  confident     boolean not null default true
);

create index sp_line_details_line_idx on sp_line_details(line_id, kind, display_order);

-- ---------------------------------------------------------------------------
-- Boilerplate libraries
-- ---------------------------------------------------------------------------

-- Standing copy for the "Key Coverage Descriptions" pages, keyed by coverage type.
-- Lives in the database rather than in code so the wording can be corrected without
-- a deploy.
create table sp_coverage_descriptions (
  id            uuid primary key default gen_random_uuid(),
  line_type     text not null,
  heading       text not null,
  body          text not null,
  display_order integer not null default 100,
  is_active     boolean not null default true,
  updated_at    timestamptz not null default now()
);

create index sp_coverage_descriptions_type_idx on sp_coverage_descriptions(line_type, display_order);

-- Library backing the "Coverage Recommendations" page. A recommendation is
-- suggested when its trigger line is ABSENT from the proposal — no cyber line
-- found, so Cyber Liability surfaces as something to recommend.
create table sp_recommendations (
  id                uuid primary key default gen_random_uuid(),
  label             text not null,
  body              text not null,
  suggest_when_line_absent text,
  display_order     integer not null default 100,
  is_active         boolean not null default true,
  updated_at        timestamptz not null default now()
);

-- Which recommendations the broker chose for a given proposal, with any inline edit.
create table sp_proposal_recommendations (
  proposal_id       uuid not null references sp_proposals(id) on delete cascade,
  recommendation_id uuid not null references sp_recommendations(id) on delete cascade,
  body_override     text,
  display_order     integer not null default 100,
  primary key (proposal_id, recommendation_id)
);

-- ---------------------------------------------------------------------------
-- Generated documents
-- ---------------------------------------------------------------------------

create table sp_documents (
  id            uuid primary key default gen_random_uuid(),
  proposal_id   uuid not null references sp_proposals(id) on delete cascade,
  storage_path  text not null unique,
  page_count    integer,
  sha256        text,
  generated_at  timestamptz not null default now(),
  generated_by  uuid not null references sp_users(id)
);

create index sp_documents_proposal_idx on sp_documents(proposal_id, generated_at desc);

-- ---------------------------------------------------------------------------
-- Background jobs
-- ---------------------------------------------------------------------------

-- A database-backed queue. At this volume it avoids standing up Redis, and the
-- claim is atomic so more than one worker process stays safe.
create table sp_jobs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,                    -- 'extract_file' | 'generate_document'
  payload       jsonb not null default '{}'::jsonb,
  status        sp_job_status not null default 'queued',
  attempts      integer not null default 0,
  max_attempts  integer not null default 3,
  locked_at     timestamptz,
  locked_by     text,
  error_text    text,
  run_after     timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index sp_jobs_claim_idx on sp_jobs(status, run_after) where status = 'queued';

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function sp_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'sp_users', 'sp_proposals', 'sp_lines', 'sp_customers',
    'sp_coverage_descriptions', 'sp_recommendations', 'sp_jobs'
  ] loop
    execute format(
      'create trigger %I_touch before update on %I for each row execute function sp_touch_updated_at()',
      t, t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

-- Important: the API connects with the Supabase service role key, which bypasses
-- RLS entirely. These deny-all policies are therefore a backstop, not the primary
-- control — they ensure that anon/authenticated keys (including anything that ever
-- leaks into the browser bundle) can read nothing at all. Ownership is enforced in
-- the API layer, in a single query helper every proposal read passes through.
-- See docs/security.md.

do $$
declare t text;
begin
  foreach t in array array[
    'sp_users', 'sp_sessions', 'sp_proposals', 'sp_files', 'sp_extractions',
    'sp_customers', 'sp_line_types', 'sp_lines', 'sp_line_options',
    'sp_line_details', 'sp_coverage_descriptions', 'sp_recommendations',
    'sp_proposal_recommendations', 'sp_documents', 'sp_jobs'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;
