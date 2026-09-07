/**
 * The only place this app creates an interval.
 *
 * Three rules it exists to enforce, all of them about not burning the
 * server's rate-limit budget during a demo:
 *
 *  1. A hidden tab does not poll. Two laptops sit side by side and only the
 *     one being looked at should be spending requests.
 *  2. Polling stops the moment `enabled` goes false, which callers tie to a
 *     transaction reaching a terminal state.
 *  3. A RATE_LIMITED response stops this poller permanently and reports it,
 *     so the UI degrades to a manual refresh instead of hammering a closed
 *     door. `defaultLimiter` is 300 requests per 15 minutes, shared across
 *     every tab on one IP.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api-client';

export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  options: { enabled?: boolean; onData?: (value: T) => void } = {}
) {
  const { enabled = true, onData } = options;
  const [rateLimited, setRateLimited] = useState(false);

  // Held in refs so a caller passing inline closures does not restart the
  // interval on every render.
  const fnRef = useRef(fn);
  const onDataRef = useRef(onData);
  fnRef.current = fn;
  onDataRef.current = onData;

  useEffect(() => {
    if (!enabled || rateLimited) return;

    let cancelled = false;

    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const value = await fnRef.current();
        if (!cancelled) onDataRef.current?.(value);
      } catch (err) {
        if (err instanceof ApiError && err.failureCode === 'RATE_LIMITED') {
          if (!cancelled) setRateLimited(true);
        }
        // Any other failure is transient: the next tick retries.
      }
    };

    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, intervalMs, rateLimited]);

  return { rateLimited };
}
