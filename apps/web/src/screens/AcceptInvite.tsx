import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Field, Input } from '../components/ui/Input.tsx';
import { Loading } from '../components/ui/States.tsx';
import { api, errorMessage } from '../lib/api.ts';

/**
 * Where an invite link lands: choose a password, and you're in.
 *
 * Public on purpose — the person has no account yet. Everything that matters is
 * checked by the server on submit (used, expired, withdrawn, already has an
 * account); the lookup on load exists only so a dead link says why straight away
 * instead of after someone has typed a password twice.
 */
export function AcceptInviteScreen() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const [invite, setInvite] = useState<{ email: string; display_name: string } | null>(null);
  const [deadReason, setDeadReason] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api.lookupInvite(token, controller.signal)
      .then(setInvite)
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setDeadReason(errorMessage(cause));
      });
    return () => controller.abort();
  }, [token]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password.length < 12) { setError('Choose a password of at least 12 characters.'); return; }
    if (password !== again) { setError('The two passwords do not match.'); return; }

    setSaving(true);
    try {
      await api.acceptInvite(token, password);
      // The server set the session cookie; let the app notice it, then go in.
      await refresh();
      void navigate('/', { replace: true });
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-panel px-6">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-lg font-semibold tracking-tight text-navy">Safeside Proposals</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {invite ? `Welcome, ${invite.display_name}. Choose a password to finish setting up.` : 'Account invitation'}
          </p>
        </div>

        {deadReason ? (
          <div className="flex flex-col gap-3 rounded-md border border-rule bg-white p-5">
            <p role="alert" className="text-sm text-red-800">{deadReason}</p>
            <Link to="/login" className="text-sm font-medium text-navy hover:underline">Go to sign in</Link>
          </div>
        ) : !invite ? (
          <Loading label="Checking your invite…" />
        ) : (
          <form
            onSubmit={(event) => void onSubmit(event)}
            className="flex flex-col gap-4 rounded-md border border-rule bg-white p-5"
          >
            <Field label="Email">
              {/* Shown, and given to a password manager, but not editable: the
                  invite is for this address. */}
              <Input type="email" name="username" autoComplete="username" value={invite.email} readOnly />
            </Field>

            <Field label="Choose a password" htmlFor="new-password" hint="12 characters or more.">
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>

            <Field label="Password again" htmlFor="confirm-password">
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                value={again}
                onChange={(event) => setAgain(event.target.value)}
              />
            </Field>

            {error ? (
              <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {error}
              </p>
            ) : null}

            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Setting up…' : 'Create my account'}
            </Button>
          </form>
        )}

        <p className="mt-3 text-xs text-ink-muted">
          This link works once. Nobody at Safeside will ever ask you for the password you choose.
        </p>
      </div>
    </div>
  );
}
