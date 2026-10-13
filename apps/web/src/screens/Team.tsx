import { useState, type FormEvent } from 'react';
import type { CreatedInvite, InviteStatus } from '@safeside/shared';
import { PageHeader } from '../components/AppShell.tsx';
import { Badge, type BadgeTone } from '../components/ui/Badge.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/Card.tsx';
import { Field, Input } from '../components/ui/Input.tsx';
import { ErrorState, Loading } from '../components/ui/States.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';
import { useAsync } from '../lib/useAsync.ts';

/**
 * Invite people. Admins only — the server refuses everyone else, and the header
 * link only appears for admins.
 *
 * The link is shown once, right after it is made, because that is the only time
 * it exists: the database keeps a hash. Lost it? Invite the same address again;
 * that issues a new link and kills the old one.
 */

const STATUS: Record<InviteStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Waiting', tone: 'amber' },
  used: { label: 'Joined', tone: 'green' },
  expired: { label: 'Expired', tone: 'neutral' },
  revoked: { label: 'Withdrawn', tone: 'neutral' },
};

function inviteLink(token: string) {
  return `${window.location.origin}/invite/${token}`;
}

function inviteMessage(created: CreatedInvite) {
  const first = created.invite.display_name.split(/\s+/)[0];
  return (
    `Hi ${first}, here's your link to set up your account on the Safeside proposal tool:\n` +
    `${inviteLink(created.token)}\n\n` +
    `Open it, choose a password, and you're in. It works once and expires on ` +
    `${formatDateTime(created.invite.expires_at)}.`
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? 'Copied ✓' : label}
    </Button>
  );
}

export function TeamScreen() {
  const { data, error, loading, reload } = useAsync((signal) => api.listInvites(signal), []);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setCreated(null);
    setSaving(true);
    try {
      const result = await api.createInvite({ email: email.trim(), display_name: name.trim(), is_admin: isAdmin });
      setCreated(result);
      setName('');
      setEmail('');
      setIsAdmin(false);
      reload();
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function withdraw(id: string) {
    setWithdrawing(id);
    try {
      await api.revokeInvite(id);
      if (created?.invite.id === id) setCreated(null);
      reload();
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setWithdrawing(null);
    }
  }

  return (
    <>
      <PageHeader title="Team" subtitle="Invite people to the proposal tool. They choose their own password." />

      <div className="grid max-w-5xl gap-5 lg:grid-cols-[22rem_1fr]">
        <Card>
          <CardHeader title="Invite someone" />
          <CardBody>
            <form onSubmit={(event) => void onInvite(event)} className="flex flex-col gap-4">
              <Field label="Name" htmlFor="invite-name">
                <Input id="invite-name" required value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Email" htmlFor="invite-email" hint="They will sign in with this address.">
                <Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  id="invite-admin"
                  type="checkbox"
                  className="mt-0.5"
                  checked={isAdmin}
                  onChange={(e) => setIsAdmin(e.target.checked)}
                />
                <span>
                  Make them an admin
                  <span className="block text-xs text-ink-muted">Admins can invite other people.</span>
                </span>
              </label>

              {formError ? (
                <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {formError}
                </p>
              ) : null}

              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? 'Creating…' : 'Create invite link'}
              </Button>
            </form>
          </CardBody>
        </Card>

        <div className="flex flex-col gap-5">
          {created ? (
            <Card className="border-emerald-300">
              <CardHeader
                title={`Invite link for ${created.invite.display_name}`}
                subtitle="Copy it now — this is the only time it is shown. It works once."
              />
              <CardBody className="flex flex-col gap-3">
                <code className="block break-all rounded border border-rule bg-panel px-3 py-2 text-xs text-ink">
                  {inviteLink(created.token)}
                </code>
                <div className="flex flex-wrap gap-2">
                  <CopyButton text={inviteLink(created.token)} label="Copy link" />
                  <CopyButton text={inviteMessage(created)} label="Copy message with link" />
                </div>
                <p className="text-xs text-ink-muted">
                  Expires {formatDateTime(created.invite.expires_at)}. Lost it? Invite the same email again — that makes a
                  new link and switches this one off.
                </p>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Invites" />
            {error ? (
              <CardBody><ErrorState error={error} onRetry={reload} /></CardBody>
            ) : loading || !data ? (
              <CardBody><Loading label="Loading invites…" /></CardBody>
            ) : data.length === 0 ? (
              <CardBody><p className="text-sm text-ink-muted">Nobody has been invited yet.</p></CardBody>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-rule text-left text-[11px] uppercase tracking-wide text-ink-muted">
                    <th className="px-5 py-2 font-semibold">Name</th>
                    <th className="px-5 py-2 font-semibold">Email</th>
                    <th className="px-5 py-2 font-semibold">Status</th>
                    <th className="px-5 py-2 font-semibold">When</th>
                    <th className="px-5 py-2" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.map((inv) => (
                    <tr key={inv.id} className="border-b border-rule last:border-0">
                      <td className="px-5 py-2.5 text-ink">
                        {inv.display_name}
                        {inv.is_admin ? <span className="ml-2 text-xs text-ink-muted">admin</span> : null}
                      </td>
                      <td className="px-5 py-2.5 text-ink-muted">{inv.email}</td>
                      <td className="px-5 py-2.5">
                        <Badge tone={STATUS[inv.status].tone}>{STATUS[inv.status].label}</Badge>
                      </td>
                      <td className="px-5 py-2.5 text-ink-muted">
                        {inv.status === 'used' && inv.used_at
                          ? `Joined ${formatDateTime(inv.used_at)}`
                          : inv.status === 'pending'
                            ? `Expires ${formatDateTime(inv.expires_at)}`
                            : `Sent ${formatDateTime(inv.created_at)}`}
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        {inv.status === 'pending' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={withdrawing === inv.id}
                            onClick={() => void withdraw(inv.id)}
                          >
                            {withdrawing === inv.id ? 'Withdrawing…' : 'Withdraw'}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
