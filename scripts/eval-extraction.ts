/**
 * Extraction regression check.
 *
 *   node --env-file=.env scripts/eval-extraction.ts --record   capture goldens
 *   node --env-file=.env scripts/eval-extraction.ts            check against them
 *
 * The prompt is the core of this product and it has no other safety net. Editing
 * it can quietly make extraction worse on documents nobody re-checks, and the
 * failure is silent: a premium comes back null, a line is missed, confidence
 * drops — and the only symptom is a broker filling in a field by hand and
 * assuming that is normal.
 *
 * So: run real quotes through the real provider, and compare the structural
 * result against a recorded baseline. Run it before and after any prompt change.
 *
 * ── Where the goldens live ──────────────────────────────────────────────────
 *
 * NOT in the repo. They record premiums and field presence for real clients, so
 * they sit beside the samples at ~/safeside-samples/.extraction-goldens.json,
 * which is outside the repo tree. Only this script is committed.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * Roughly $0.01 per page, so a five-quote run is about $1. Not something to put
 * in CI; something to run deliberately when the prompt changes.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { AnthropicExtractionProvider } from '../apps/api/src/extraction/anthropic.ts';
import type { ExtractionResult } from '@safeside/shared';

const SAMPLES = join(process.env.HOME ?? '', 'safeside-samples');
const GOLDENS = join(SAMPLES, '.extraction-goldens.json');
const recording = process.argv.includes('--record');

/**
 * What a golden records.
 *
 * Structural facts only — the things a regression would break. No addresses, no
 * FEINs, no business descriptions: the presence of a field is what matters, not
 * its content. Premiums are included because a premium regression is the single
 * most damaging failure this tool has, and it cannot be caught without them.
 */
interface Golden {
  /** Hash of the PDF, so a golden follows the file rather than its name. */
  sha256: string;
  pages: number | null;
  lines: Array<{ line_type: string; premium: number | null; option_count: number; detail_count: number }>;
  /** Field names extraction found, sorted. Values deliberately excluded. */
  customer_fields_found: string[];
  carrier_name_count: number;
}

function goldenOf(result: ExtractionResult, sha256: string): Golden {
  return {
    sha256,
    pages: null,
    lines: result.lines
      .map((l) => ({
        line_type: l.line_type,
        premium: l.premium,
        option_count: l.options.length,
        detail_count: l.details.length,
      }))
      .sort((a, b) => a.line_type.localeCompare(b.line_type)),
    customer_fields_found: Object.entries(result.customer)
      .filter(([, cell]) => cell.meta.found)
      .map(([field]) => field)
      .sort(),
    carrier_name_count: result.carrier_names_seen.length,
  };
}

/** Differences that matter, described for a human. */
function diff(expected: Golden, actual: Golden): string[] {
  const problems: string[] = [];

  const byType = (g: Golden) => new Map(g.lines.map((l) => [l.line_type, l]));
  const before = byType(expected);
  const after = byType(actual);

  for (const [type, e] of before) {
    const a = after.get(type);
    if (!a) { problems.push(`line no longer extracted: ${type}`); continue; }

    // The one that matters most: a premium that was found and now is not.
    if (e.premium !== null && a.premium === null) {
      problems.push(`${type}: premium was ${e.premium}, now null`);
    } else if (e.premium !== a.premium) {
      problems.push(`${type}: premium ${e.premium} -> ${a.premium}`);
    }

    if (e.option_count !== a.option_count) {
      problems.push(`${type}: options ${e.option_count} -> ${a.option_count}`);
    }
    // Detail counts drift a little run to run; only a large drop is a signal.
    if (a.detail_count < e.detail_count * 0.8) {
      problems.push(`${type}: details dropped ${e.detail_count} -> ${a.detail_count}`);
    }
  }

  for (const type of after.keys()) {
    if (!before.has(type)) problems.push(`new line appeared: ${type}`);
  }

  const lost = expected.customer_fields_found.filter((f) => !actual.customer_fields_found.includes(f));
  if (lost.length) problems.push(`customer fields no longer found: ${lost.join(', ')}`);

  if (actual.carrier_name_count < expected.carrier_name_count) {
    problems.push(
      `carrier names ${expected.carrier_name_count} -> ${actual.carrier_name_count} ` +
      `(the leak guard depends on these)`,
    );
  }

  return problems;
}

/* -------------------------------------------------------------------------- */

if (!existsSync(SAMPLES)) {
  console.error(`No samples at ${SAMPLES}`);
  process.exit(1);
}

/** Carrier quotes only — Safeside's own proposals are not extraction inputs. */
function quoteFiles(): string[] {
  const out: string[] = [];
  for (const client of readdirSync(SAMPLES)) {
    const dir = join(SAMPLES, client);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.pdf') || f.startsWith('~$')) continue;
      if (/proposal/i.test(f)) continue;
      out.push(join(dir, f));
    }
  }
  return out.sort();
}

const files = quoteFiles();
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg === -1 ? 5 : Number(process.argv[limitArg + 1]);
const selected = files.slice(0, limit);

const provider = new AnthropicExtractionProvider(
  process.env.ANTHROPIC_API_KEY ?? '',
  process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
);

const goldens: Record<string, Golden> = existsSync(GOLDENS)
  ? JSON.parse(readFileSync(GOLDENS, 'utf8'))
  : {};

console.log(`${recording ? 'Recording' : 'Checking'} ${selected.length} quote(s)\n`);

let failed = 0;
let cost = 0;

for (const file of selected) {
  const bytes = new Uint8Array(readFileSync(file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const name = basename(file);
  // The filename carries the client's name, so log a short hash instead.
  const label = `${sha256.slice(0, 8)} (${name.length} char name)`;

  process.stdout.write(`  ${label} ... `);
  try {
    const { result, usage } = await provider.extract({ pdf: bytes, filename: name });
    cost += ((usage.inputTokens ?? 0) / 1e6) * 3 + ((usage.outputTokens ?? 0) / 1e6) * 15;

    const actual = goldenOf(result, sha256);

    if (recording) {
      goldens[sha256] = actual;
      console.log(`recorded — ${actual.lines.length} line(s)`);
      continue;
    }

    const expected = goldens[sha256];
    if (!expected) {
      console.log('no golden — run with --record first');
      continue;
    }

    const problems = diff(expected, actual);
    if (problems.length === 0) {
      console.log(`ok — ${actual.lines.length} line(s)`);
    } else {
      failed++;
      console.log('REGRESSED');
      for (const p of problems) console.log(`      ${p}`);
    }
  } catch (err) {
    failed++;
    console.log(`ERROR — ${err instanceof Error ? err.message.slice(0, 90) : String(err)}`);
  }
}

if (recording) {
  writeFileSync(GOLDENS, JSON.stringify(goldens, null, 2));
  console.log(`\nWrote ${Object.keys(goldens).length} golden(s) to ${GOLDENS}`);
  console.log('That file is outside the repo on purpose — it records real premiums.');
}

console.log(`\nSpent about $${cost.toFixed(2)}.`);
if (!recording) {
  console.log(failed === 0 ? 'No regressions.' : `${failed} file(s) regressed.`);
  process.exit(failed === 0 ? 0 : 1);
}
