import { useCallback, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/AppShell.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/Card.tsx';
import { Field, Input } from '../components/ui/Input.tsx';
import { ErrorState } from '../components/ui/States.tsx';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { formatBytes } from '../lib/format.ts';

/** Local identity for a queued file — File itself is not a stable React key. */
interface Queued {
  key: string;
  file: File;
}

let counter = 0;
const nextKey = () => `f${(counter += 1)}`;

export function UploadScreen() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [clientName, setClientName] = useState('');
  const [queue, setQueue] = useState<Queued[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  /** Names of files turned away for not being PDFs, so we can say which. */
  const [rejected, setRejected] = useState<string[]>([]);

  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;

    /*
     * Say which files are not going. The server drops anything that is not a
     * PDF, and it used to do so in silence: a broker who selected a folder
     * holding three quotes and a Word document got a proposal built from three
     * files and nothing anywhere saying the fourth had been discarded. The only
     * clue was a file count they had no reason to re-count.
     */
    const all = Array.from(incoming);
    const isPdf = (f: File) =>
      f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
    const pdfs = all.filter(isPdf);
    setRejected(all.filter((f) => !isPdf(f)).map((f) => f.name));
    if (pdfs.length === 0) return;

    const added = pdfs.map((file) => ({ key: nextKey(), file }));
    setQueue((current) => {
      // Same name and size twice is a double-drop, not two documents.
      const seen = new Set(current.map((q) => `${q.file.name}:${q.file.size}`));
      return [...current, ...added.filter((q) => !seen.has(`${q.file.name}:${q.file.size}`))];
    });
  }, []);

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  const totalBytes = queue.reduce((sum, q) => sum + q.file.size, 0);
  const canSubmit = clientName.trim().length > 0 && queue.length > 0 && !busy;

  async function onSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createProposal(clientName.trim());
      if (!created?.id) {
        throw new Error('The API created a proposal but did not return an id.');
      }
      await api.uploadFiles(
        created.id,
        queue.map((q) => q.file),
      );
      void navigate(`/proposals/${created.id}/analyzing`, { replace: true });
    } catch (cause) {
      setError(cause);
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="New proposal"
        subtitle="One client. Add every carrier quote you want considered."
        actions={
          <Button variant="ghost" onClick={() => void navigate('/')}>
            Cancel
          </Button>
        }
      />

      {error ? <ErrorState error={error} className="mb-4" /> : null}

      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-5">
        <Card>
          <CardHeader
            title="Documents"
            subtitle="PDFs from the carriers. Several files, one client."
          />
          <CardBody>
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                'flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-12 text-center transition-colors',
                dragging ? 'border-navy bg-navy/5' : 'border-rule bg-panel',
              )}
            >
              <p className="text-sm font-medium text-navy">Drop quote files here</p>
              <p className="text-xs text-ink-muted">or</p>
              <Button onClick={() => inputRef.current?.click()}>Choose files</Button>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = '';
                }}
              />
            </div>

            {queue.length > 0 ? (
              <ul className="mt-4 divide-y divide-rule rounded-md border border-rule">
                {queue.map((item) => (
                  <li key={item.key} className="flex items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">
                      {item.file.name}
                    </span>
                    <span className="shrink-0 text-xs text-ink-muted">
                      {formatBytes(item.file.size)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${item.file.name}`}
                      disabled={busy}
                      onClick={() =>
                        setQueue((current) => current.filter((q) => q.key !== item.key))
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-xs text-ink-muted">No files added yet.</p>
            )}

            {rejected.length > 0 ? (
              <p
                role="alert"
                className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
              >
                Not added — only PDFs can be read:{' '}
                <span className="font-medium">{rejected.join(', ')}</span>
              </p>
            ) : null}
          </CardBody>
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="Client" />
            <CardBody className="flex flex-col gap-4">
              <Field
                label="Client name"
                htmlFor="client-name"
                hint="Used to find this proposal later. The named insured is pulled from the documents."
              >
                <Input
                  id="client-name"
                  value={clientName}
                  autoFocus
                  disabled={busy}
                  placeholder="e.g. Northgate Bakery LLC"
                  onChange={(event) => setClientName(event.target.value)}
                />
              </Field>

              <div className="rounded border border-rule bg-panel px-3 py-2 text-xs text-ink-muted">
                {queue.length} file{queue.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
              </div>

              <Button variant="primary" disabled={!canSubmit} onClick={() => void onSubmit()}>
                {busy ? 'Uploading…' : 'Upload and analyze'}
              </Button>

              {!busy && queue.length === 0 ? (
                <p className="text-xs text-ink-muted">Add at least one file to continue.</p>
              ) : null}
              {!busy && queue.length > 0 && clientName.trim() === '' ? (
                <p className="text-xs text-ink-muted">Enter a client name to continue.</p>
              ) : null}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
