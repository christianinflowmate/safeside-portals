import { useCallback, useRef, useState } from 'react';
import type { ProposalDetail } from '@safeside/shared';
import type { SaveState } from '../../components/ui/States.tsx';
import { api, errorMessage } from '../../lib/api.ts';
import { useAsync } from '../../lib/useAsync.ts';

export interface ReviewController {
  detail: ProposalDetail | null;
  loading: boolean;
  error: unknown;
  reload: () => void;
  saveState: SaveState;
  saveError: string | undefined;
  /** Optimistic local edit. Shows the change now; does not talk to the API. */
  update: (updater: (detail: ProposalDetail) => ProposalDetail) => void;
  /**
   * Sends a mutation, then refetches so totals and blocking_reasons come from
   * the server rather than being recomputed here in a second, divergent place.
   * `reconcile` gets a last word over the refetched copy, which is how in-flight
   * edits survive a response that raced them.
   */
  commit: (
    request: () => Promise<unknown>,
    reconcile?: (fresh: ProposalDetail) => ProposalDetail,
  ) => Promise<void>;
}

/**
 * Fetch the proposal, building the draft first if it is not there yet.
 *
 * The worker materialises the draft immediately after it marks the last file
 * read — but /status reports `done` off the file rows alone, so the analyzing
 * screen can navigate here in the gap between those two steps. Landing in that
 * gap showed "No coverage lines were found. Check the uploaded files." over a
 * perfectly good proposal, and only a manual refresh cleared it.
 *
 * So: no lines and nothing still extracting means the draft is missing rather
 * than empty. POST /materialize — idempotent, and locked server-side against the
 * worker doing the same thing — then read it back.
 */
async function loadReview(id: string, signal?: AbortSignal): Promise<ProposalDetail> {
  const detail = await api.getProposal(id, signal);
  if (detail.lines.length > 0) return detail;

  const stillReading = detail.files.some((f) =>
    f.extraction_status === 'pending' || f.extraction_status === 'running',
  );
  if (stillReading || detail.files.length === 0) return detail;

  // A failure here is not fatal: fall back to what we already read, so the
  // screen shows the real empty state rather than an error.
  try {
    await api.materialize(id, signal);
  } catch {
    return detail;
  }
  return api.getProposal(id, signal);
}

export function useReview(id: string): ReviewController {
  const { data, error, loading, reload, setData } = useAsync(
    (signal) => loadReview(id, signal),
    [id],
  );

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  /* Only the newest refetch may write state; earlier ones are stale by then. */
  const seq = useRef(0);

  const update = useCallback(
    (updater: (detail: ProposalDetail) => ProposalDetail) => {
      setData((current) => (current ? updater(current) : current));
    },
    [setData],
  );

  const commit = useCallback<ReviewController['commit']>(
    async (request, reconcile) => {
      const mine = (seq.current += 1);
      setSaveState('saving');
      setSaveError(undefined);
      try {
        await request();
        const fresh = await api.getProposal(id);
        if (seq.current !== mine) return;
        setData(reconcile ? reconcile(fresh) : fresh);
        setSaveState('saved');
      } catch (cause) {
        if (seq.current !== mine) return;
        setSaveState('error');
        setSaveError(errorMessage(cause));
      }
    },
    [id, setData],
  );

  return { detail: data, loading, error, reload, saveState, saveError, update, commit };
}
