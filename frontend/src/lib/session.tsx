/**
 * Who is signed in on this device, and what their balance is.
 *
 * One fetch of /me, shared by the header, the identity strip and every page,
 * so the balance shown in two places is always the same number. The session
 * itself lives in an httpOnly cookie the browser sends automatically; this
 * holds only what the server tells us about it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, OfflineError } from './api-client';

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
  /** True once the browser has gone offline without ever confirming a session — the "loading forever" case RequireSession must not treat as signed out. */
  offline: boolean;
  refresh: () => Promise<Me | null>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  // A ref, not a dependency: `refresh`'s identity must stay stable across a
  // successful fetch, or the effect below that calls it on mount would refire
  // every time `me` changes and refetch forever.
  const meRef = useRef<Me | null>(null);
  meRef.current = me;

  const refresh = useCallback(async () => {
    try {
      const fresh = await api.me();
      setOffline(false);
      setMe(fresh);
      return fresh;
    } catch (err) {
      // Losing connectivity says nothing about whether this device is signed
      // in — PRISM just cannot confirm it right now. Clearing `me` here used
      // to sign the user out from under an in-progress payment the instant a
      // network blip touched any /me refresh, which is exactly the bug that
      // turned a dropped connection into a lost transaction.
      if (err instanceof OfflineError) {
        setOffline(true);
        return meRef.current;
      }
      // A real 401 (or any other failure) is the ordinary signed-out case.
      setOffline(false);
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
    () => ({ me, loading, offline, refresh, signOut }),
    [me, loading, offline, refresh, signOut]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
