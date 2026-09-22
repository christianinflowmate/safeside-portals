import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Field, Input } from '../components/ui/Input.tsx';
import { Loading } from '../components/ui/States.tsx';
import { ApiRequestError, errorMessage } from '../lib/api.ts';

interface FromState {
  from?: string;
}

/**
 * There is no self-registration and no password reset — accounts are created by
 * an admin out of band, so this screen offers nothing but the two fields.
 */
export function LoginScreen() {
  const { status, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'loading') return <Loading label="Checking your session…" />;
  if (status === 'authenticated') {
    const from = (location.state as FromState | null)?.from;
    return <Navigate to={from && from !== '/login' ? from : '/'} replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 401) {
        setError('That email and password do not match an account.');
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-panel px-6">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-lg font-semibold tracking-tight text-navy">Safeside Proposals</h1>
          <p className="mt-1 text-sm text-ink-muted">Sign in to continue.</p>
        </div>

        <form
          onSubmit={(event) => void onSubmit(event)}
          className="flex flex-col gap-4 rounded-md border border-rule bg-white p-5"
        >
          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              type="email"
              name="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>

          <Field label="Password" htmlFor="password">
            <Input
              id="password"
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
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

          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-3 text-xs text-ink-muted">
          Accounts are created by an administrator. There is no self-registration or
          password reset — ask an admin if you are locked out.
        </p>
      </div>
    </div>
  );
}
