/**
 * Development harness: run real extraction against a local carrier quote.
 *
 *   node --env-file=.env scripts/try-extract.ts "<path to pdf>"
 *
 * Prints STRUCTURE ONLY — line types, confidence, option counts, which customer
 * fields were found. It deliberately never prints extracted values for the
 * customer block, because those are real business names, addresses and FEINs and
 * they do not belong in a terminal log. Full output is written to a gitignored
 * file if you need to inspect it.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { AnthropicExtractionProvider } from '../apps/api/src/extraction/anthropic.ts';
import type { ExtractionResult } from '@safeside/shared';

const file = process.argv[2];
if (!file) {
  console.error('usage: node --env-file=.env scripts/try-extract.ts <pdf>');
  process.exit(1);
}

const pdf = new Uint8Array(readFileSync(file));
const filename = basename(file);
const provider = new AnthropicExtractionProvider(
  process.env.ANTHROPIC_API_KEY ?? '',
  process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
);

console.log(`\nExtracting: ${filename}  (${(pdf.length / 1024 / 1024).toFixed(1)} MB)`);
const started = Date.now();
const { result, raw, usage, model } = await provider.extract({ pdf, filename });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

report(result, { seconds, usage, model });

mkdirSync(resolve('out'), { recursive: true });
const outPath = resolve('out', `${filename.replace(/\.pdf$/i, '')}.extraction.json`);
writeFileSync(outPath, JSON.stringify({ result, raw }, null, 2));
console.log(`\nFull output (contains client data, gitignored): ${outPath}`);

function report(
  r: ExtractionResult,
  ctx: { seconds: string; usage: { inputTokens: number | null; outputTokens: number | null }; model: string | null },
) {
  const cost =
    ((ctx.usage.inputTokens ?? 0) / 1e6) * 3 + ((ctx.usage.outputTokens ?? 0) / 1e6) * 15;

  console.log(
    `Done in ${ctx.seconds}s · ${ctx.model} · ` +
      `${ctx.usage.inputTokens} in / ${ctx.usage.outputTokens} out · ~$${cost.toFixed(3)}\n`,
  );

  console.log('CUSTOMER BLOCK (values withheld — structure only)');
  for (const [field, cell] of Object.entries(r.customer)) {
    const { value, meta } = cell as { value: unknown; meta: { found: boolean; confidence: number; note: string | null } };
    const mark = !meta.found ? '·· absent' : meta.confidence >= 0.8 ? 'ok      ' : '!! LOW  ';
    const conf = meta.found ? `${(meta.confidence * 100).toFixed(0)}%` : '—';
    const len = value == null ? '' : ` (${String(value).length} chars)`;
    console.log(`  ${mark} ${field.padEnd(22)} ${conf.padStart(4)}${len}${meta.note ? `  — ${meta.note}` : ''}`);
  }

  console.log(`\nCOVERAGE LINES (${r.lines.length})`);
  for (const line of r.lines) {
    const opts = line.options.length ? `  [${line.options.length} OPTIONS]` : '';
    const prem = line.premium != null ? `$${line.premium.toLocaleString()}` : '—';
    console.log(
      `  ${line.line_type.padEnd(24)} ${String(Math.round(line.confidence * 100)).padStart(3)}%  ` +
        `${prem.padStart(12)}  ${line.details.length} details${opts}`,
    );
    if (line.line_type_label) console.log(`      carrier wording: "${line.line_type_label}"`);
    if (line.premium_components.length) {
      const sum = line.premium_components.reduce((a, c) => a + c.amount, 0);
      const tallies = line.premium != null && Math.abs(sum - line.premium) < 0.01 ? 'sums OK' : `!! components sum to $${sum.toLocaleString()}`;
      console.log(`      components (${line.premium_components.length}, ${tallies}):`);
      for (const c of line.premium_components) {
        console.log(`        ${c.is_fee ? 'fee ' : '    '} ${c.label.padEnd(30)} $${c.amount.toLocaleString()}`);
      }
    }
    for (const o of line.options) {
      console.log(`      option: "${o.label}" — ${o.premium != null ? `$${o.premium.toLocaleString()}` : '—'}`);
    }
    const lowConf = line.details.filter((d) => d.confidence < 0.7);
    if (lowConf.length) console.log(`      !! ${lowConf.length} low-confidence details`);
  }

  console.log(`\nCARRIER NAMES SEEN (${r.carrier_names_seen.length}) — these must never reach the client PDF`);
  for (const n of r.carrier_names_seen) console.log(`  · ${n}`);

  if (r.notes.length) {
    console.log('\nMODEL NOTES');
    for (const n of r.notes) console.log(`  · ${n}`);
  }
}
