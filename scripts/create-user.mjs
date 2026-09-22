/**
 * Create a login account.
 *
 *   node --env-file=.env scripts/create-user.mjs
 *   node --env-file=.env scripts/create-user.mjs --email a@b.com --name "A Broker" --admin
 *
 * There is no self-registration in v1 — accounts are created here by an admin.
 * The password is read with echo off and never appears in shell history, in the
 * terminal, or in any log.
 *
 * Runs against DATABASE_URL when set, otherwise the local PGlite database, so an
 * account can be made before Supabase credentials exist.
 */
import { hash } from '@node-rs/argon2';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};

/**
 * Queue of lines for non-interactive input.
 *
 * Piped stdin arrives as one chunk, so a reader that consumes the whole stream
 * leaves nothing for the next prompt — the second read then hangs forever on a
 * stream that has already ended. Buffering into a queue lets several prompts be
 * served from one piped input, which is what makes this script usable in a script
 * or a test as well as by hand.
 */
const pipedLines = [];
let pipedDone = false;
const pipedWaiters = [];

if (!process.stdin.isTTY) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) {
      const waiter = pipedWaiters.shift();
      if (waiter) waiter(line.trim());
      else pipedLines.push(line.trim());
    }
  });
  process.stdin.on('end', () => {
    if (buf.trim()) {
      const waiter = pipedWaiters.shift();
      if (waiter) waiter(buf.trim());
      else pipedLines.push(buf.trim());
    }
    pipedDone = true;
    // Anything still waiting gets an empty string rather than hanging.
    while (pipedWaiters.length) pipedWaiters.shift()('');
  });
}

function nextPipedLine() {
  if (pipedLines.length) return Promise.resolve(pipedLines.shift());
  if (pipedDone) return Promise.resolve('');
  return new Promise((resolve) => pipedWaiters.push(resolve));
}

function readHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    if (!stdin.isTTY) {
      nextPipedLine().then((line) => { stdout.write('\n'); resolve(line); });
      return;
    }
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '') {
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
        stdout.write('\n'); return resolve(buf.trim());
      }
      if (ch === '') { stdout.write('\n'); process.exit(130); }
      if (ch === '' || ch === '\b') { buf = buf.slice(0, -1); return; }
      buf += ch;
    };
    stdin.on('data', onData);
  });
}

function readLine(prompt) {
  process.stdout.write(prompt);
  if (!process.stdin.isTTY) return nextPipedLine();
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => resolve(String(d).trim()));
  });
}

async function openDb() {
  const url = process.env.DATABASE_URL;
  if (url && url.trim()) {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await client.connect();
    return {
      label: 'Supabase',
      query: (sql, params) => client.query(sql, params),
      close: () => client.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const db = await PGlite.create(process.env.PGLITE_DATA_DIR ?? join(ROOT, 'apps/api/.pglite'),
    { extensions: { citext, pgcrypto } });

  // The local database may be brand new; applying migrations here means
  // create-user works as the very first command anyone runs.
  if (existsSync(MIGRATIONS)) {
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      try { await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8')); }
      catch (err) { if (!/already exists/i.test(err.message)) throw err; }
    }
  }
  return {
    label: 'local PGlite',
    query: (sql, params) => db.query(sql, params),
    close: () => db.close(),
  };
}

const db = await openDb();
console.log(`Creating a user in: ${db.label}\n`);

const email = arg('email') ?? (await readLine('Email: '));
const name = arg('name') ?? (await readLine('Display name: '));
const isAdmin = argv.includes('--admin');

if (!email || !name) {
  console.error('Email and display name are required.');
  await db.close();
  process.exit(1);
}

const password = await readHidden('Password (min 12 chars): ');
if (password.length < 12) {
  console.error('Password must be at least 12 characters.');
  await db.close();
  process.exit(1);
}
const again = await readHidden('Confirm password: ');
if (password !== again) {
  console.error('Passwords did not match.');
  await db.close();
  process.exit(1);
}

// OWASP's current Argon2id guidance. Must match apps/api/src/auth/passwords.ts.
const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

try {
  const { rows } = await db.query(
    `insert into sp_users (email, password_hash, display_name, is_admin)
     values ($1,$2,$3,$4) returning id, email, display_name, is_admin`,
    [email, passwordHash, name, isAdmin],
  );
  const u = rows[0];
  console.log(`\nCreated ${u.display_name} <${u.email}>${u.is_admin ? '  (admin)' : ''}`);
  console.log(`  id: ${u.id}`);
} catch (err) {
  if (/duplicate key|unique/i.test(err.message)) {
    console.error(`\nA user with that email already exists.`);
  } else {
    console.error(`\nCould not create the user: ${err.message}`);
  }
  await db.close();
  process.exit(1);
}

await db.close();
