import type { ReactNode } from 'react';
import { ApiRequestError } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { Button } from './Button.tsx';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-5 py-10 text-sm text-ink-muted">
      <span
        aria-hidden
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-rule border-t-navy"
      />
      {label}
    </div>
  );
}

/**
 * Failures are shown, never swallowed. A 404 from an endpoint that is not built
 * yet must look like a 404 and not like an empty list.
 */
export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const status = error instanceof ApiRequestError ? error.status : null;
  const message =
    error instanceof Error ? error.message : 'Something went wrong.';
  const details = error instanceof ApiRequestError ? error.details : [];

  return (
    <div
      role="alert"
      className={cn(
        'rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium">
            {status ? `${status === 0 ? 'Network' : status} — ` : ''}
            {message}
          </p>
          {details.length > 0 ? (
            <ul className="mt-1 list-inside list-disc text-xs">
              {details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </div>
        {onRetry ? (
          <Button size="sm" onClick={onRetry} className="shrink-0">
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-medium text-navy">{title}</p>
      {body ? <p className="max-w-md text-sm text-ink-muted">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Tells the broker whether the thing they just typed actually landed. */
export function SaveIndicator({ state, error }: { state: SaveState; error?: string }) {
  if (state === 'idle') return null;
  if (state === 'saving') return <span className="text-xs text-ink-muted">Saving…</span>;
  if (state === 'saved') return <span className="text-xs text-ink-muted">Saved</span>;
  return (
    <span className="text-xs font-medium text-red-700">
      Not saved{error ? ` — ${error}` : ''}
    </span>
  );
}
