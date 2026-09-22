/**
 * Migration runner.
 *
 *   node --env-file=.env scripts/migrate.mjs          apply pending migrations
 *   node --env-file=.env scripts/migrate.mjs --status show what would run
 *   node --env-file=.env scripts/migrate.mjs --reconcile <file>
 *                                                    re-record one checksum
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
const reconcileArg = (() => {
  const i = process.argv.indexOf('--reconcile');
  return i === -1 ? null : (process.argv[i + 1] ?? '');
})();

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

/*
 * Re-record one applied migration's checksum.
 *
 * The checksum covers the whole file, comments included, so rewording a comment
 * in a migration that has already run stops every later run. The runner cannot
 * tell a reworded comment from a changed statement, and is right not to guess —
 * but that leaves no way forward when the comment genuinely had to change.
 *
 * Which is not hypothetical: client names had to come out of comments in
 * migrations that were already applied, and the statements underneath could not
 * be touched. Without this, a deploy that runs migrations fails forever on a
 * file whose SQL is correct.
 *
 * Legitimate ONLY when the SQL itself is unchanged, and establishing that against
 * the live schema is the job of whoever runs this. It takes one filename at a
 * time so it cannot be waved at the whole directory, and it never alters the
 * database — only the record of what was already applied.
 */
if (reconcileArg !== null) {
  if (!reconcileArg || reconcileArg.startsWith('--')) {
    console.error('--reconcile needs a filename, e.g. --reconcile 011_premium_components.sql');
    await client.end();
    process.exit(1);
  }
  const previous = appliedByName.get(reconcileArg);
  if (!previous) {
    console.error(`${reconcileArg} is not recorded as applied — nothing to reconcile.`);
    await client.end();
    process.exit(1);
  }
  let sql;
  try {
    sql = readFileSync(join(MIGRATIONS_DIR, reconcileArg), 'utf8');
  } catch {
    console.error(`${reconcileArg} is not in supabase/migrations.`);
    await client.end();
    process.exit(1);
  }
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (sha256 === previous) {
    console.log(`${reconcileArg} already matches what is recorded — nothing to do.`);
    await client.end();
    process.exit(0);
  }
  await client.query('update sp_migrations set sha256 = $1 where filename = $2', [
    sha256,
    reconcileArg,
  ]);
  console.log(
    `Re-recorded ${reconcileArg}\n` +
      `  was: ${previous.slice(0, 12)}\n  now: ${sha256.slice(0, 12)}\n\n` +
      'The database schema was NOT touched. If the SQL in that file changed rather\n' +
      'than its comments, this has just hidden that — write a new numbered migration.',
  );
  await client.end();
  process.exit(0);
}

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
