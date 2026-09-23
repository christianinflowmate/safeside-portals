import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ProposalListItem } from '@safeside/shared';
import { PageHeader } from '../components/AppShell.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Card } from '../components/ui/Card.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { EmptyState, ErrorState, Loading } from '../components/ui/States.tsx';
import { api } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';
import { useAsync } from '../lib/useAsync.ts';

/** Where a row goes when clicked, which depends on how far along it is. */
function destinationFor(item: ProposalListItem): string {
  if (item.display_status === 'analyzing') return `/proposals/${item.id}/analyzing`;
  if (item.display_status === 'generated') return `/proposals/${item.id}/result`;
  return `/proposals/${item.id}/review`;
}

export function ProposalsListScreen() {
  const navigate = useNavigate();
  const { data, error, loading, reload } = useAsync(
    (signal) => api.listProposals(signal),
    [],
  );

  /*
   * Deleting asks first, in the row itself.
   *
   * A proposal holds a client's quotes and everything read out of them, and this
   * cannot be undone. A single click next to a link people click all day is the
   * wrong shape for that, and a browser confirm() dialog is easy to dismiss
   * without reading. Turning the row into the question is harder to do by
   * accident.
   */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function remove(id: string) {
    setDeleting(id);
    setDeleteError(null);
    try {
      await api.deleteProposal(id);
      setConfirming(null);
      reload();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'That proposal could not be deleted.');
    } finally {
      setDeleting(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Proposals"
        subtitle="Every proposal you have started."
        actions={
          <Button variant="primary" onClick={() => void navigate('/proposals/new')}>
            New Proposal
          </Button>
        }
      />

      {error ? <ErrorState error={error} onRetry={reload} className="mb-4" /> : null}
      {deleteError ? (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {deleteError}
        </div>
      ) : null}

      <Card>
        {loading || !data ? (
          error ? (
            <EmptyState title="The proposal list could not be loaded." />
          ) : (
            <Loading label="Loading proposals…" />
          )
        ) : data.length === 0 ? (
          <EmptyState
            title="No proposals yet"
            body="Start one by uploading the carrier quotes for a client."
            action={
              <Button variant="primary" onClick={() => void navigate('/proposals/new')}>
                New Proposal
              </Button>
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-[11px] uppercase tracking-wide text-ink-muted">
                <th className="px-5 py-2 font-semibold">Client</th>
                <th className="px-5 py-2 font-semibold">Created</th>
                <th className="px-5 py-2 font-semibold">Status</th>
                <th className="px-5 py-2 font-semibold">Files</th>
                <th className="px-5 py-2 text-right font-semibold">Document</th>
                <th className="px-5 py-2 text-right font-semibold" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.map((item) => (
                <tr key={item.id} className="border-b border-rule last:border-0 hover:bg-panel">
                  <td className="px-5 py-2.5">
                    <Link
                      to={destinationFor(item)}
                      className="font-medium text-navy hover:underline"
                    >
                      {item.client_name || 'Untitled client'}
                    </Link>
                  </td>
                  <td className="px-5 py-2.5 text-ink-muted">
                    {formatDateTime(item.created_at)}
                  </td>
                  <td className="px-5 py-2.5">
                    <StatusBadge status={item.display_status} />
                    {item.files_failed > 0 && item.display_status !== 'extraction_failed' ? (
                      <span className="ml-2 text-xs text-red-700">
                        {item.files_failed} file{item.files_failed === 1 ? '' : 's'} failed
                      </span>
                    ) : null}
                  </td>
                  <td className="px-5 py-2.5 text-ink-muted">
                    {item.file_count}
                    {item.files_extracting > 0 ? ` (${item.files_extracting} reading)` : ''}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {item.latest_document_id ? (
                      <Link
                        to={`/proposals/${item.id}/result`}
                        className="font-medium text-gold-text hover:underline"
                      >
                        Download
                      </Link>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-right whitespace-nowrap">
                    {confirming === item.id ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-xs text-ink-muted">Delete for good?</span>
                        <button
                          type="button"
                          disabled={deleting === item.id}
                          onClick={() => void remove(item.id)}
                          className="rounded border border-red-300 px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          {deleting === item.id ? 'Deleting…' : 'Delete'}
                        </button>
                        <button
                          type="button"
                          disabled={deleting === item.id}
                          onClick={() => setConfirming(null)}
                          className="rounded px-2 py-0.5 text-xs text-ink-muted hover:bg-panel disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete ${item.client_name || 'Untitled client'}`}
                        onClick={() => { setDeleteError(null); setConfirming(item.id); }}
                        className="rounded px-2 py-0.5 text-xs text-ink-muted hover:bg-red-50 hover:text-red-700"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
