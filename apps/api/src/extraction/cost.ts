/**
 * What reading a proposal cost.
 *
 * Every extraction already records its token counts; nothing has ever shown
 * them. That made the API account an invisible resource, and the first sign it
 * had run dry was a quote that would not read — a billing problem arriving
 * disguised as a broken document.
 *
 * Rates come from the environment rather than being written in here. Published
 * prices change, and a figure derived from a rate nobody checked is worse than
 * no figure at all: it looks authoritative and is quietly wrong. Unset means
 * token counts are reported without money, which is still enough to see that one
 * proposal cost eight times another.
 */

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  /** Extraction runs, including ones that failed — those cost money too. */
  runs: number;
  /** Null when no rates are configured. */
  cost_usd: number | null;
}

function rate(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function costUsd(inputTokens: number, outputTokens: number): number | null {
  const inRate = rate('ANTHROPIC_INPUT_COST_PER_MTOK');
  const outRate = rate('ANTHROPIC_OUTPUT_COST_PER_MTOK');
  // Both or neither. Half a price is a wrong price.
  if (inRate === null || outRate === null) return null;
  const usd = (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
  // Sub-cent amounts are real and worth seeing; a proposal can cost $0.004.
  return Math.round(usd * 10_000) / 10_000;
}

export function summarise(
  rows: Array<{ input_tokens: number | null; output_tokens: number | null }>,
): UsageSummary {
  let input = 0;
  let output = 0;
  for (const r of rows) {
    input += r.input_tokens ?? 0;
    output += r.output_tokens ?? 0;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    runs: rows.length,
    cost_usd: costUsd(input, output),
  };
}
