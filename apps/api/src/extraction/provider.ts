import type { ExtractionResult } from '@safeside/shared';

/**
 * Extraction sits behind this interface so the provider is swappable.
 *
 * Two implementations exist: `anthropic` (real) and `fake` (replays committed
 * fixtures, makes no network calls). The fake is what lets the review screen be
 * built and demoed without burning tokens on every hot reload, and what keeps the
 * test suite deterministic and offline.
 */
export interface ExtractionProvider {
  readonly name: string;
  readonly model: string | null;

  extract(input: ExtractionInput): Promise<ExtractionOutcome>;
}

export interface ExtractionInput {
  /** Raw PDF bytes. Never a path — the worker may not share a filesystem. */
  pdf: Uint8Array;
  /** Original filename, passed to the model purely as context. */
  filename: string;
}

export interface ExtractionOutcome {
  result: ExtractionResult;
  /** Verbatim provider response, stored in sp_extractions.raw_response. */
  raw: unknown;
  usage: { inputTokens: number | null; outputTokens: number | null };
  model: string | null;
}

export class ExtractionError extends Error {
  readonly detail: unknown;
  /** Whether retrying the same input could plausibly succeed. */
  readonly retryable: boolean;

  constructor(message: string, detail?: unknown, retryable: boolean = false) {
    super(message);
    this.name = 'ExtractionError';
    this.detail = detail;
    this.retryable = retryable;
  }
}
