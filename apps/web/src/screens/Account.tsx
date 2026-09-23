import { useState, type FormEvent } from 'react';
import { PageHeader } from '../components/AppShell.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Card, CardBody, CardHeader } from '../components/ui/Card.tsx';
import { Field, Input } from '../components/ui/Input.tsx';
import { useAuth } from '../auth/AuthContext.tsx';
import { api, ApiRequestError, errorMessage } from '../lib/api.ts';

/**
 * Change your own password.
 *
 * Until this screen existed the only way to change one was an administrator
 * running a script at a terminal, which turns every rotation into somebody
 * else's errand — and a password nobody can change on their own is a password
 * that does not get changed.
 *
 * Still no reset-by-email: there is no mail sending anywhere in this system, and
 * a reset link is a whole second way into an account. Locked out is still an
 * admin's job.
 */
export function AccountScreen() {
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setDone(false);

    // Checked here as well as on the server: the mismatch is a typo the person
    // can fix without a round trip.
    if (next !== again) {
      setError('The two new passwords do not match.');
      return;
    }
    if (next.length < 12) {
      setError('The new password must be at least 12 characters.');
      return;
    }

    setSaving(true);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(true);
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 401) {
        setError('That is not your current password.');
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="Account" subtitle={user ? user.email : undefined} />

      <Card className="max-w-md">
        <CardHeader
          title="Change your password"
          subtitle="At least 12 characters. Everywhere else you are signed in will be signed out."
        />
        <CardBody>
          <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
            {/* Carries the account for a password manager, which cannot read the header. */}
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={user?.email ?? ''}
              readOnly
              hidden
            />

            <Field label="Current password" htmlFor="current-password">
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                required
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
              />
            </Field>

            <Field label="New password" htmlFor="new-password" hint="12 characters or more.">
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={next}
                onChange={(event) => setNext(event.target.value)}
              />
            </Field>

            <Field label="New password again" htmlFor="confirm-password">
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
              <p
                role="alert"
                className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
              >
                {error}
              </p>
            ) : null}

            {done ? (
              <p
                role="status"
                className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
              >
                Password changed. Any other browser signed in as you has been signed out.
              </p>
            ) : null}

            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Changing…' : 'Change password'}
            </Button>
          </form>
        </CardBody>
      </Card>

      <p className="mt-3 max-w-md text-xs text-ink-muted">
        Lost your password entirely? There is no reset link — an administrator runs
        <code className="mx-1">scripts/set-password.mjs</code> for you.
      </p>
    </>
  );
}
