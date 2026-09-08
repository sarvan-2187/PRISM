/**
 * Browser connectivity, tracked once and shared everywhere a page needs to
 * disable a submit button or explain a failure. `navigator.onLine` only means
 * "attached to a network interface," not "can reach PRISM" — the api-client's
 * per-request offline check is what actually protects a call — but it is
 * enough to gate the UI so a payment is never even attempted while the
 * browser knows it has no connection.
 */
import { useEffect, useState } from 'react';

export function useOnline(): boolean {
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

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
