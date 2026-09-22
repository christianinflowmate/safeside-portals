/**
 * Migration runner.
 *
 *   node --env-file=.env scripts/migrate.mjs          apply pending migrations
 *   node --env-file=.env scripts/migrate.mjs --status show what would run
 *
 * Migrations are numbered SQL files in supabase/migrations, applied in filename
 * order, each inside a transaction, each recorded in sp_migrations. Schema changes
 * are never made by hand in the Supabase dashboard — if it is not a file in this
 * directory, it does not exist.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const statusOnly = process.argv.includes('--status');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Copy it from Supabase → Settings → Database.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  // Supabase terminates TLS with a cert this client does not have in its trust
  // store; the connection is still encrypted.
  ssl: { rejectUnauthorized: false },
});

await client.connect();

await client.query(`
  create table if not exists sp_migrations (
    filename    text primary key,
    sha256      text not null,
    applied_at  timestamptz not null default now()
  )
`);

const { rows: applied } = await client.query('select filename, sha256 from sp_migrations');
const appliedByName = new Map(applied.map((r) => [r.filename, r.sha256]));

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

let ran = 0;
for (const filename of files) {
  const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  const previous = appliedByName.get(filename);

  if (previous) {
    // An already-applied migration that has since been edited means the database
    // and the repo disagree about history. Fail loudly rather than guess.
    if (previous !== sha256) {
      console.error(
        `\n${filename} has changed since it was applied.\n` +
          `  applied: ${previous.slice(0, 12)}\n  on disk: ${sha256.slice(0, 12)}\n\n` +
          `Write a new numbered migration instead of editing an applied one.`,
      );
      await client.end();
      process.exit(1);
    }
    console.log(`  = ${filename}`);
    continue;
  }

  if (statusOnly) {
    console.log(`  + ${filename}  (would apply)`);
    ran++;
    continue;
  }

  process.stdout.write(`  + ${filename} ... `);
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into sp_migrations (filename, sha256) values ($1, $2)', [
      filename,
      sha256,
    ]);
    await client.query('commit');
    console.log('ok');
    ran++;
  } catch (err) {
    await client.query('rollback');
    console.log('FAILED');
    console.error(`\n${filename} failed and was rolled back:\n  ${err.message}\n`);
    await client.end();
    process.exit(1);
  }
}

await client.end();
console.log(
  ran === 0
    ? '\nUp to date.'
    : statusOnly
      ? `\n${ran} migration(s) pending.`
      : `\nApplied ${ran} migration(s).`,
);
