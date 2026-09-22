/**
 * Write secrets into .env without them appearing on screen, in shell history, or
 * in a chat transcript.
 *
 *   node scripts/set-env.mjs                 prompt for every empty secret
 *   node scripts/set-env.mjs DATABASE_URL    prompt for one specific key
 *
 * Input is read with echo off, so pasting a service role key leaves no trace in
 * the scrollback. Existing values are never printed back — only whether one is
 * already set.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = join(ROOT, '.env');
const EXAMPLE = join(ROOT, '.env.example');

/** Keys treated as secret: prompted with echo off, never displayed. */
const SECRET_KEYS = new Set([
  'DATABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'SESSION_SECRET',
]);

if (!existsSync(ENV)) {
  copyFileSync(EXAMPLE, ENV);
  console.log('Created .env from .env.example');
}
chmodSync(ENV, 0o600);

const lines = readFileSync(ENV, 'utf8').split('\n');
const wanted = process.argv.slice(2);

function readHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);

    if (!stdin.isTTY) {
      // Non-interactive: fall back to a normal line read so this still works when
      // piped, at the cost of the echo-off guarantee.
      const rl = createInterface({ input: stdin, output: stdout, terminal: false });
      rl.once('line', (line) => { rl.close(); resolve(line.trim()); });
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';

    const onData = (ch) => {
      // Enter, or Ctrl-D on an empty buffer, ends input.
      if (ch === '\r' || ch === '\n' || ch === '') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(buf.trim());
        return;
      }
      if (ch === '') { stdout.write('\n'); process.exit(130); }        // Ctrl-C
      if (ch === '' || ch === '\b') { buf = buf.slice(0, -1); return; } // Backspace
      buf += ch;
    };

    stdin.on('data', onData);
  });
}

let changed = 0;
for (let i = 0; i < lines.length; i++) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(lines[i]);
  if (!match) continue;

  const [, key, current] = match;
  if (wanted.length && !wanted.includes(key)) continue;
  if (!wanted.length && current !== '') continue;   // only fill blanks by default
  if (!SECRET_KEYS.has(key) && !wanted.includes(key)) continue;

  const state = current === '' ? 'empty' : 'already set — enter to keep';
  const value = await readHidden(`${key} (${state}): `);
  if (value === '') continue;

  lines[i] = `${key}=${value}`;
  changed++;
}

if (changed === 0) {
  console.log('Nothing changed.');
} else {
  writeFileSync(ENV, lines.join('\n'), { mode: 0o600 });
  console.log(`Updated ${changed} value(s) in .env (mode 600, gitignored).`);
}
