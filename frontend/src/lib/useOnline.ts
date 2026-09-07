/**
 * navigator.onLine + the online/offline events — BLACKOUT (FC-01-A).
 *
 * PRISM had no offline/online handling anywhere before this card: no service
 * worker, no navigator.onLine usage, no retry queue (confirmed by a full
 * grep of frontend/src). This is the one place that changes.
 *
 * navigator.onLine is a coarse signal — true mostly means "has a network
 * interface," not "can reach the PRISM backend" — which is exactly why
 * DevTools' Network > Offline throttling (a real interface-down simulation)
 * is what the demo uses rather than trusting this alone for anything
 * security-relevant. It drives UI only; every actual security decision in
 * the offline flow is made by signed, capped, single-use artifacts that
 * remain sound regardless of what this hook reports.
 */
import { useEffect, useState } from 'react';

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
