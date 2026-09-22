/**
 * Assemble DATABASE_URL from the Supabase session pooler parameters plus a
 * password entered with echo off.
 *
 *   node scripts/set-db-password.mjs
 *
 * Everything except the password is public project metadata, so the only thing
 * you type is the secret. The password is percent-encoded before it goes into the
 * URI: Supabase generates passwords containing characters like @ : / ? # and any
 * of those pasted raw will silently produce a malformed connection string.
 */
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = join(ROOT, '.env');

// Session pooler, from the project's Connect sheet. IPv4-proxied, which direct
// connection is not — see docs/supabase.md.
//
// The hostname carries the project's REGION. safeside-proposals is in us-west-2
// (Oregon); the earlier project was us-east-1, and using the wrong one fails with
// a DNS error that says nothing about the real cause. Override with --host if the
// Connect sheet shows something different (the aws-0/aws-1 prefix varies).
// Read from the environment rather than hard-coded: the project ref identifies
// the live database, and this repo is public. Both are on the Supabase Connect
// sheet, and SUPABASE_PROJECT_REF sits in .env alongside the other values.
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? '';
const REGION = process.env.SUPABASE_REGION ?? 'us-west-2';

if (!PROJECT_REF) {
  console.error('SUPABASE_PROJECT_REF is not set. Copy it from Supabase -> Connect.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const argHost = argv.includes('--host') ? argv[argv.indexOf('--host') + 1] : null;

const HOST = argHost ?? `aws-0-${REGION}.pooler.supabase.com`;
const PORT = 5432;
const DATABASE = 'postgres';
const USER = `postgres.${PROJECT_REF}`;

function readHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    if (!stdin.isTTY) {
      let buf = '';
      stdin.on('data', (d) => (buf += d));
      stdin.on('end', () => resolve(buf.trim()));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        return resolve(buf.trim());
      }
      if (ch === '') { stdout.write('\n'); process.exit(130); }
      if (ch === '' || ch === '\b') { buf = buf.slice(0, -1); return; }
      buf += ch;
    };
    stdin.on('data', onData);
  });
}

const password = await readHidden('Supabase database password: ');
if (!password) {
  console.error('Nothing entered — DATABASE_URL unchanged.');
  process.exit(1);
}

const url = `postgresql://${USER}:${encodeURIComponent(password)}@${HOST}:${PORT}/${DATABASE}`;

const lines = readFileSync(ENV, 'utf8').split('\n');
let found = false;
for (let i = 0; i < lines.length; i++) {
  if (/^DATABASE_URL=/.test(lines[i])) {
    lines[i] = `DATABASE_URL=${url}`;
    found = true;
    break;
  }
}
if (!found) lines.push(`DATABASE_URL=${url}`);

writeFileSync(ENV, lines.join('\n'), { mode: 0o600 });
chmodSync(ENV, 0o600);

const encoded = encodeURIComponent(password) !== password;
console.log(
  `\nDATABASE_URL written to .env (mode 600, gitignored).\n` +
    `  host:     ${HOST}\n  user:     ${USER}\n` +
    `  password: ${password.length} chars${encoded ? ', percent-encoded for the URI' : ''}\n`,
);

/*
 * Verify before declaring success.
 *
 * A wrong region, a mistyped password or an unencoded special character all
 * produce the same symptom later — a connection error at some unrelated moment —
 * so the check belongs here, while the person who can fix it is still watching.
 */
process.stdout.write('Testing the connection... ');
try {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const { rows } = await client.query('select current_database() as db, version() as v');
  await client.end();
  console.log('connected.');
  console.log(`  database: ${rows[0].db}`);
  console.log(`  server:   ${rows[0].v.split(',')[0]}`);
  console.log('\nNext: npm run db:migrate');
} catch (err) {
  console.log('FAILED.');
  console.error(`  ${err.message}`);
  if (/ENOTFOUND|EAI_AGAIN/.test(err.message)) {
    console.error(`\n  That hostname does not resolve. The region in it is probably wrong —`);
    console.error(`  check the Connect sheet and re-run with:  --host <hostname>`);
  } else if (/password|auth/i.test(err.message)) {
    console.error(`\n  The password was rejected. Reset it in Settings -> Database and try again.`);
  }
  console.error(`\n  DATABASE_URL was still written; fix and re-run to overwrite it.`);
  process.exit(1);
}
