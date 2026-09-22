import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ExtractionProgress, ProposalFile } from '@safeside/shared';
import { PageHeader } from '../components/AppShell.tsx';
import { Badge } from '../components/ui/Badge.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/Card.tsx';
import { ErrorState, Loading } from '../components/ui/States.tsx';
import { api } from '../lib/api.ts';
import { FILE_STATUS_LABEL, formatBytes } from '../lib/format.ts';

const POLL_MS = 2000;

function fileTone(status: ProposalFile['extraction_status']) {
  if (status === 'failed') return 'red' as const;
  if (status === 'succeeded') return 'green' as const;
  if (status === 'running') return 'navy' as const;
  return 'neutral' as const;
}

export function AnalyzingScreen() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [acting, setActing] = useState(false);
  /* True once extraction has settled with failures and polling has stopped. */
  const [holding, setHolding] = useState(false);

  const poll = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await api.getStatus(id, signal);
        setProgress(next);
        setError(null);
        return next;
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return null;
        setError(cause);
        return null;
      }
    },
    [id],
  );

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;

    const tick = async () => {
      const next = await poll(controller.signal);
      if (!live) return;
      if (next?.done) {
        // Nothing failed: straight on to review, as the brief asks.
        if (next.failed === 0) {
          void navigate(`/proposals/${id}/review`, { replace: true });
          return;
        }
        // Something failed: stop and let the broker decide what to do about it.
        setHolding(true);
        return;
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };

    void tick();

    return () => {
      live = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [id, poll, navigate]);

  async function removeFile(fileId: string) {
    setActing(true);
    try {
      await api.deleteFile(id, fileId);
      const next = await poll();
      if (next && next.done && next.failed === 0) {
        void navigate(`/proposals/${id}/review`, { replace: true });
        return;
      }
      if (next && !next.done) setHolding(false);
    } catch (cause) {
      setError(cause);
    } finally {
      setActing(false);
    }
  }

  if (!progress && error) {
    return (
      <>
        <PageHeader title="Analyzing" />
        <ErrorState error={error} onRetry={() => void poll()} />
        <div className="mt-4">
          <Button onClick={() => void navigate('/')}>Back to proposals</Button>
        </div>
      </>
    );
  }

  if (!progress) {
    return (
      <>
        <PageHeader title="Analyzing" />
        <Card>
          <Loading label="Asking the API what it is up to…" />
        </Card>
      </>
    );
  }

  const total = progress.total || progress.files.length || 1;
  const settled = progress.completed + progress.failed;
  const percent = Math.min(100, Math.round((settled / total) * 100));
  const failedFiles = progress.files.filter((f) => f.extraction_status === 'failed');

  return (
    <>
      <PageHeader
        title="Reading the documents"
        subtitle={
          progress.done
            ? 'Extraction finished.'
            : progress.current_filename
              ? `Currently reading ${progress.current_filename}`
              : 'Waiting for the next file…'
        }
        actions={
          <Button variant="ghost" onClick={() => void navigate('/')}>
            Back to proposals
          </Button>
        }
      />

      {error ? <ErrorState error={error} onRetry={() => void poll()} className="mb-4" /> : null}

      <Card className="max-w-3xl">
        <CardHeader
          title={`${settled} of ${total} files`}
          subtitle={
            progress.failed > 0
              ? `${progress.completed} read, ${progress.failed} failed`
              : `${progress.completed} read`
          }
          actions={
            !progress.done ? (
              <span className="text-xs text-ink-muted">Checking every 2s</span>
            ) : null
          }
        />
        <CardBody className="flex flex-col gap-4">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-panel"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-navy transition-[width] duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>

          <ul className="divide-y divide-rule rounded-md border border-rule">
            {progress.files.map((file) => (
              <li key={file.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">
                    {file.original_filename}
                  </span>
                  {file.error_text ? (
                    <span className="block truncate text-xs text-red-700">
                      {file.error_text}
                    </span>
                  ) : (
                    <span className="block text-xs text-ink-muted">
                      {formatBytes(file.size_bytes)}
                      {file.page_count ? ` · ${file.page_count} pages` : ''}
                    </span>
                  )}
                </span>
                <Badge tone={fileTone(file.extraction_status)}>
                  {FILE_STATUS_LABEL[file.extraction_status] ?? file.extraction_status}
                </Badge>
              </li>
            ))}
            {progress.files.length === 0 ? (
              <li className="px-3 py-3 text-sm text-ink-muted">
                This proposal has no files attached.
              </li>
            ) : null}
          </ul>
        </CardBody>
      </Card>

      {failedFiles.length > 0 ? (
        <Card className="mt-5 max-w-3xl border-red-200">
          <CardHeader
            title={`${failedFiles.length} file${failedFiles.length === 1 ? '' : 's'} could not be read`}
            subtitle="Drop the file and carry on with the rest, or start again with different documents."
          />
          <CardBody className="flex flex-col gap-3">
            {failedFiles.map((file) => (
              <div
                key={file.id}
                className="flex items-center justify-between gap-4 rounded border border-rule px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {file.original_filename}
                  </p>
                  <p className="truncate text-xs text-red-700">
                    {file.error_text ?? 'The extractor gave no reason.'}
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={acting}
                  onClick={() => void removeFile(file.id)}
                  className="shrink-0"
                >
                  Remove and continue
                </Button>
              </div>
            ))}

            <div className="flex items-center gap-2 pt-1">
              <Button variant="primary" onClick={() => void navigate(`/proposals/${id}/review`)}>
                Continue to review
              </Button>
              <Button variant="danger" onClick={() => void navigate('/proposals/new')}>
                Start over
              </Button>
              {holding ? (
                <span className="text-xs text-ink-muted">
                  Nothing else is running, so this will not change on its own.
                </span>
              ) : null}
            </div>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
