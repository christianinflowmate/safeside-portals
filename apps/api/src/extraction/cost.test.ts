import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { costUsd, summarise } from './cost.ts';

const KEYS = ['ANTHROPIC_INPUT_COST_PER_MTOK', 'ANTHROPIC_OUTPUT_COST_PER_MTOK'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('what reading a proposal cost', () => {
  test('no configured rates means no money, not a guessed figure', () => {
    assert.equal(costUsd(1_000_000, 500_000), null);
  });

  /*
   * Half a price is a wrong price: applying an input rate while treating output
   * as free understates every figure, and does so invisibly.
   */
  test('one rate without the other is still no money', () => {
    process.env.ANTHROPIC_INPUT_COST_PER_MTOK = '3';
    assert.equal(costUsd(1_000_000, 1_000_000), null);
    delete process.env.ANTHROPIC_INPUT_COST_PER_MTOK;
    process.env.ANTHROPIC_OUTPUT_COST_PER_MTOK = '15';
    assert.equal(costUsd(1_000_000, 1_000_000), null);
  });

  test('with both rates it prices input and output separately', () => {
    process.env.ANTHROPIC_INPUT_COST_PER_MTOK = '3';
    process.env.ANTHROPIC_OUTPUT_COST_PER_MTOK = '15';
    assert.equal(costUsd(1_000_000, 0), 3);
    assert.equal(costUsd(0, 1_000_000), 15);
    assert.equal(costUsd(1_000_000, 1_000_000), 18);
  });

  test('keeps sub-cent amounts, because one file genuinely costs a fraction of a cent', () => {
    process.env.ANTHROPIC_INPUT_COST_PER_MTOK = '3';
    process.env.ANTHROPIC_OUTPUT_COST_PER_MTOK = '15';
    const usd = costUsd(1_000, 200);
    assert.ok(usd !== null && usd > 0, 'a small run should not round away to zero');
    assert.ok(usd < 0.01);
  });

  test('a nonsense rate is ignored rather than producing a nonsense total', () => {
    process.env.ANTHROPIC_INPUT_COST_PER_MTOK = 'free';
    process.env.ANTHROPIC_OUTPUT_COST_PER_MTOK = '15';
    assert.equal(costUsd(1_000_000, 1_000_000), null);
  });

  test('sums every run and treats missing counts as zero', () => {
    const s = summarise([
      { input_tokens: 100, output_tokens: 10 },
      { input_tokens: null, output_tokens: null },
      { input_tokens: 400, output_tokens: 90 },
    ]);
    assert.equal(s.input_tokens, 500);
    assert.equal(s.output_tokens, 100);
    // Three runs, not two: a failed extraction still spent tokens.
    assert.equal(s.runs, 3);
    assert.equal(s.cost_usd, null);
  });

  test('no runs is zero, not an error', () => {
    const s = summarise([]);
    assert.deepEqual(s, { input_tokens: 0, output_tokens: 0, runs: 0, cost_usd: null });
  });
});
