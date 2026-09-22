import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ApiUser } from '@safeside/shared';
import { api, ApiRequestError, UNAUTHORIZED_EVENT } from '../lib/api.ts';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthValue {
  status: AuthStatus;
  user: ApiUser | null;
  /** Non-null when /api/auth/me failed for a reason other than "not logged in". */
  error: unknown;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<ApiUser | null>(null);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      if (!mounted.current) return;
      setUser(me);
      setError(null);
      setStatus('authenticated');
    } catch (cause) {
      if (!mounted.current) return;
      setUser(null);
      // A 401 is the expected "not signed in" answer, not a failure to report.
      setError(cause instanceof ApiRequestError && cause.status === 401 ? null : cause);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /*
   * The cookie is httpOnly, so the only signal that a session ended is a 401
   * from some other call. api.ts broadcasts those; here is where they land.
   */
  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null);
      setError(null);
      setStatus('anonymous');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      await api.login({ email, password });
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* Whether or not the server cleared it, this tab is done with the session. */
    }
    setUser(null);
    setError(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ status, user, error, signIn, signOut, refresh }),
    [status, user, error, signIn, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
