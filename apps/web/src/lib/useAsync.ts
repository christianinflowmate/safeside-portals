import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncResult<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  /**
   * Accepts a value or an updater, like useState. The updater form matters for
   * optimistic edits: a review screen applying several field changes in quick
   * succession must build on the latest state, not on a copy captured when the
   * handler was created.
   */
  setData: (next: T | null | ((current: T | null) => T | null)) => void;
}

/**
 * Fetch-on-mount with an explicit reload. Deliberately not a cache: this tool
 * has one user per proposal at a time, and stale data on a review screen is
 * worse than a round trip.
 */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
): AsyncResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setLoading(true);

    loadRef
      .current(controller.signal)
      .then((value) => {
        if (!live) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause);
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, reload, setData };
}
