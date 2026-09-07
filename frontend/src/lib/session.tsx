/**
 * Who is signed in on this device, and what their balance is.
 *
 * One fetch of /me, shared by the header, the identity strip and every page,
 * so the balance shown in two places is always the same number. The session
 * itself lives in an httpOnly cookie the browser sends automatically; this
 * holds only what the server tells us about it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api-client';

export interface Me {
  userId: string;
  email: string;
  displayName: string;
  balanceMinor: number;
  balanceFormatted: string;
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<Me | null>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const fresh = await api.me();
      setMe(fresh);
      return fresh;
    } catch {
      // A 401 here is the ordinary signed-out case, not an error worth showing.
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ me, loading, refresh, signOut }),
    [me, loading, refresh, signOut]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
