import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { GeneratedDocument } from '@safeside/shared';
import { Button } from '../components/ui/Button.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/Card.tsx';
import { ErrorState, Loading } from '../components/ui/States.tsx';
import { api } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';

/**
 * The finished proposal: preview, download, and a way back.
 *
 * "Back to Edit" returns to review rather than regenerating on the spot — the
 * broker almost always wants to change something first, and regenerating an
 * unchanged document just burns time.
 */
export function ResultScreen() {
  const { id = '' } = useParams();
  const [doc, setDoc] = useState<GeneratedDocument | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      setDoc(await api.getDocument(id, signal));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading && !doc) return <Loading label="Loading the proposal…" />;

  if (error && !doc) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <ErrorState error={error} onRetry={() => void load()} />
        <p className="text-sm text-slate-500">
          If nothing has been generated yet, go back and press Generate.
        </p>
        <Link to={`/proposals/${id}/review`}>
          <Button variant="secondary">Back to edit</Button>
        </Link>
      </div>
    );
  }

  if (!doc) return null;

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-navy">Proposal ready</h1>
          <p className="mt-1 text-sm text-slate-500">
            Generated {formatDateTime(doc.generated_at)}
            {doc.page_count ? ` · ${doc.page_count} pages` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to={`/proposals/${id}/review`}>
            <Button variant="secondary">Back to edit</Button>
          </Link>
          {/* A plain anchor, not fetch(): the browser's own download handling
              gets the filename and progress right, and there is nothing to
              gain by pulling the bytes into JavaScript first. */}
          <a href={doc.download_url} download>
            <Button>Download PDF</Button>
          </a>
        </div>
      </header>

      <Card>
        <CardHeader title="Preview" subtitle="This is what the client receives." />
        <CardBody className="p-0">
          <iframe
            title="Proposal preview"
            src={doc.download_url}
            className="h-[820px] w-full rounded-b-lg border-0 bg-slate-100"
          />
        </CardBody>
      </Card>

      <p className="text-center text-sm text-slate-400">
        <Link to="/" className="underline hover:text-slate-600">All proposals</Link>
      </p>
    </div>
  );
}
