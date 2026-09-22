# Supabase

Project `safeside-proposals` (ref in 1Password), org Inflowmate,
region us-west-2 (Oregon), compute micro.

## Connection method

Migrations and the API connect through the **session pooler**, not direct
connection:

    postgresql://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:5432/postgres

The hostname carries the region, so it differs per project — an earlier project
was us-east-1 and reusing that hostname fails with a bare DNS error that gives no
hint about the cause. `scripts/set-db-password.mjs` takes `--host` for that case
and tests the connection before reporting success.

Direct connection resolves to IPv6 only unless the paid IPv4 add-on is enabled, so
it fails from most IPv4 networks. The session pooler is IPv4-proxied at no cost and
preserves session semantics, which the transaction pooler does not — migrations
need session state for things like advisory locks and `set local`.

The password is percent-encoded into the URI by `scripts/set-db-password.mjs`.
Supabase generates passwords containing `@ : / ? #`, all of which are URI-significant
and will silently produce a malformed connection string if pasted raw.

## Status

The schema is live on this project as of 2026-09-20. All eight migrations applied
against PostgreSQL 17.6; 18 `sp_` tables plus `sp_migrations`, RLS enabled and
forced on all 18 (the ledger is deliberately exempt — it is infrastructure, and
only the service role ever reaches it).

The `pg` driver had never executed until then; only PGlite had been exercised. It
has now been run end to end against this project: login, a proposal read spanning
nine tables, transactional writes through the disclaimer and line endpoints, PDF
generation, and a download round-tripping `sp-documents`. The generated document
reflected every edit made through the API.

One gap remains: the **test suite still runs on PGlite only**. `freshDb` in
`apps/api/src/test-support.ts` creates a PGlite instance, so nothing in CI would
catch a divergence between the two drivers — PGlite is PostgreSQL 18 in WASM and
this project is 17.6. The end-to-end run above was done by hand and is not
repeatable by `npm test`. Pointing the suite at a scratch Supabase database, or at
a local Postgres container, is the way to close it.

## Buckets

Both private, PDF-only, 50 MB per file:

- `sp-uploads` — carrier quotes as uploaded. Write-once; never modified, renamed or
  overwritten after landing.
- `sp-documents` — generated proposals.

A pre-existing `pp-quotes` bucket is on this project from earlier work. Nothing in
this codebase reads or writes it.

## Schema ownership

Everything this app creates is prefixed `sp_`. Migrations are numbered SQL files in
`supabase/migrations`, applied by `npm run db:migrate`. Schema changes are never
made by hand in the dashboard SQL editor — if it is not a file in that directory,
it does not exist.
