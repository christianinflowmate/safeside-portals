import type { ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.tsx';
import { Button } from './ui/Button.tsx';
import { Loading } from './ui/States.tsx';

/** Every route but /login sits behind this. Any 401 lands back at the form. */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <Loading label="Checking your session…" />;
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

export function AppShell() {
  const { user, signOut } = useAuth();

  return (
    <div className="min-h-screen bg-panel">
      <header className="border-b border-rule bg-white">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between px-6">
          <Link to="/" className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight text-navy">Safeside</span>
            <span className="text-sm text-ink-muted">Proposals</span>
          </Link>
          <div className="flex items-center gap-3 text-xs text-ink-muted">
            {user ? <span>{user.display_name || user.email}</span> : null}
            <Button size="sm" variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-end justify-between gap-6">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-navy">{title}</h1>
        {subtitle ? <div className="mt-1 text-sm text-ink-muted">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
