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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
