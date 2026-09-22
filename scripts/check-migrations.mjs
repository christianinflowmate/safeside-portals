/**
 * Apply every migration to a throwaway in-process Postgres and assert the result.
 *
 *   npm run db:check
 *
 * This needs no Supabase project, no password and no network. PGlite is real
 * Postgres compiled to WebAssembly, so a migration that passes here is a migration
 * that parses, orders its dependencies correctly and produces the objects it
 * claims to — the failures that otherwise surface only on first deploy.
 *
 * It is not a substitute for running against Supabase. Extension availability and
 * role behaviour differ. It is a substitute for finding out about a typo at the
 * worst possible moment.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

const EXPECTED_TABLES = [
  'sp_users', 'sp_sessions', 'sp_proposals', 'sp_files', 'sp_extractions',
  'sp_customers', 'sp_line_types', 'sp_lines', 'sp_line_options',
  'sp_line_details', 'sp_coverage_descriptions', 'sp_recommendations',
  'sp_proposal_recommendations', 'sp_documents', 'sp_jobs',
  'sp_login_attempts', 'sp_premium_disclaimers', 'sp_proposal_disclaimers',
];

const EXPECTED_TYPES = [
  'sp_proposal_status', 'sp_extraction_status', 'sp_job_status', 'sp_detail_kind',
];

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

const db = await PGlite.create({ extensions: { citext, pgcrypto } });

console.log('Applying migrations:');
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  try {
    await db.exec(readFileSync(join(DIR, f), 'utf8'));
    console.log(`  ✓ ${f}`);
  } catch (err) {
    console.log(`  ✗ ${f}\n\n${err.message}\n`);
    process.exit(1);
  }
}

console.log('\nTables:');
const { rows: tables } = await db.query(
  `select tablename from pg_tables where schemaname = 'public' and tablename like 'sp\\_%'`,
);
const present = new Set(tables.map((r) => r.tablename));
for (const t of EXPECTED_TABLES) check(present.has(t), t);
const extra = [...present].filter((t) => !EXPECTED_TABLES.includes(t));
if (extra.length) console.log(`  · also present: ${extra.join(', ')}`);

console.log('\nEnum types:');
const { rows: types } = await db.query(
  `select typname from pg_type where typname like 'sp\\_%' and typtype = 'e'`,
);
const typeNames = new Set(types.map((r) => r.typname));
for (const t of EXPECTED_TYPES) check(typeNames.has(t), t);

// RLS must be both enabled and FORCED. Enabled alone still exempts the table
// owner, which is not the guarantee docs/security.md claims.
console.log('\nRow Level Security (enabled AND forced):');
const { rows: rls } = await db.query(
  `select relname, relrowsecurity, relforcerowsecurity
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and relname like 'sp\\_%' and relkind = 'r'`,
);
for (const r of rls.sort((a, b) => a.relname.localeCompare(b.relname))) {
  check(r.relrowsecurity && r.relforcerowsecurity, r.relname,
    r.relrowsecurity && r.relforcerowsecurity ? '' : `enabled=${r.relrowsecurity} forced=${r.relforcerowsecurity}`);
}

console.log('\nEnd-to-end insert through every foreign key:');
try {
  await db.exec(`
    insert into sp_users (id, email, password_hash, display_name)
      values ('11111111-1111-1111-1111-111111111111', 'Broker@Example.test', 'argon2-placeholder', 'Test Broker');
    insert into sp_proposals (id, owner_user_id, client_name)
      values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Northgate Bakery LLC');
    insert into sp_files (id, proposal_id, original_filename, storage_path, size_bytes, mime_type, uploaded_by)
      values ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'quote.pdf', 'p/22/quote.pdf', 1024, 'application/pdf', '11111111-1111-1111-1111-111111111111');
    insert into sp_extractions (file_id, proposal_id, provider, status)
      values ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'anthropic', 'succeeded');
    insert into sp_customers (proposal_id, named_insured)
      values ('22222222-2222-2222-2222-222222222222', 'Northgate Bakery LLC');
    insert into sp_lines (id, proposal_id, line_type, carrier_premium, broker_fee)
      values ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'general_liability', 2400.00, 350.00);
    insert into sp_line_options (id, line_id, label, carrier_premium)
      values ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', '$1M / $2M', 2400.00);
    update sp_lines set selected_option_id = '55555555-5555-5555-5555-555555555555' where id = '44444444-4444-4444-4444-444444444444';
    insert into sp_line_details (line_id, kind, label, value)
      values ('44444444-4444-4444-4444-444444444444', 'limit', 'Each Occurrence', '$1,000,000');
    insert into sp_documents (proposal_id, storage_path, generated_by)
      values ('22222222-2222-2222-2222-222222222222', 'd/22/proposal.pdf', '11111111-1111-1111-1111-111111111111');
  `);
  check(true, 'insert across users → proposals → files → extractions → lines → options → details → documents');
} catch (err) {
  check(false, 'end-to-end insert', err.message);
}

// citext: the same email in different case must collide.
try {
  await db.exec(`insert into sp_users (email, password_hash, display_name)
                 values ('broker@example.test', 'x', 'Duplicate')`);
  check(false, 'email uniqueness is case-insensitive', 'duplicate was ACCEPTED');
} catch {
  check(true, 'email uniqueness is case-insensitive (citext)');
}

// Cascade: deleting a proposal must not strand its children.
try {
  await db.exec(`delete from sp_proposals where id = '22222222-2222-2222-2222-222222222222'`);
  const { rows } = await db.query(`select
      (select count(*) from sp_files)::int as files,
      (select count(*) from sp_lines)::int as lines,
      (select count(*) from sp_line_details)::int as details,
      (select count(*) from sp_documents)::int as documents`);
  const r = rows[0];
  check(r.files === 0 && r.lines === 0 && r.details === 0 && r.documents === 0,
    'deleting a proposal cascades to its children', JSON.stringify(r));
} catch (err) {
  check(false, 'cascade delete', err.message);
}

// updated_at triggers
try {
  const { rows } = await db.query(
    `select count(*)::int as n from pg_trigger where tgname like '%\\_touch' and not tgisinternal`,
  );
  check(rows[0].n === 8, 'updated_at triggers installed', `found ${rows[0].n}, expected 8`);
} catch (err) {
  check(false, 'updated_at triggers', err.message);
}

console.log(
  failures === 0
    ? `\nSchema verified — ${EXPECTED_TABLES.length} tables, all checks passed.`
    : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
