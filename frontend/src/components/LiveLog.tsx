/**
 * The security log for one transaction, filling in as it happens.
 *
 * This is the screen-side proof of the central claim: the reader watches
 * CHALLENGE_ISSUED appear with "challenge = intent hash" beside it, then
 * ASSERTION_VERIFIED, then the risk decision, then settlement. Nothing here
 * is narrated by the client; every line is an audit row the server wrote.
 *
 * Polling stops the moment the transaction reaches a terminal state, so a
 * finished payment costs nothing. See usePoll for why that matters.
 */
import { useEffect, useState } from 'react';
import { api, TimelineEvent } from '@/lib/api-client';
import { usePoll } from '@/lib/usePoll';
import { describeEvent, summarise, toneClass } from '@/lib/events';
import { clockTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

export function LiveLog({ txId, live }: { txId: string; live: boolean }) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);

  // One fetch on mount covers the already-finished case with no interval at
  // all. While the payment is in flight, usePoll takes over below.
  useEffect(() => {
    let cancelled = false;
    api.timeline(txId).then(
      (data) => !cancelled && setEvents(data.events),
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, [txId]);

  const { rateLimited } = usePoll(() => api.timeline(txId), 2000, {
    enabled: live,
    onData: (data) => setEvents(data.events),
  });

  return (
    <Card className="bg-secondary">
      <CardContent className="pt-6">
        <section aria-label="Security log for this payment">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-semibold">Security log</h3>
            {live && !rateLimited ? (
              <Badge variant="info">Live</Badge>
            ) : rateLimited ? (
              <Badge variant="warning">Paused</Badge>
            ) : (
              <Badge>Complete</Badge>
            )}
          </div>

          {rateLimited && (
            <p className="text-pretty text-small text-secondary-foreground">
              PRISM is rate limiting this browser, so live updates stopped. Reload the page in a
              minute to catch up. Nothing about the payment itself changed.
            </p>
          )}

          {!events && (
            <p className="text-small text-secondary-foreground">Waiting for the first event…</p>
          )}

          {events && events.length === 0 && (
            <p className="text-small text-secondary-foreground">
              No events recorded yet. The first one appears when the intent is locked.
            </p>
          )}

          {events && events.length > 0 && (
            <ol className="grid gap-2" aria-live="polite">
              {events.map((e, i) => {
                const { label, tone } = describeEvent(e.event);
                const detail = summarise(e.data);
                return (
                  <li
                    key={`${e.at}-${i}`}
                    className="grid animate-log-in grid-cols-[52px_1fr] items-baseline gap-3 border-b pb-2 text-small last:border-0 last:pb-0"
                  >
                    <span className="font-mono text-caption tabular text-muted-foreground">
                      {clockTime(e.at)}
                    </span>
                    <span className="min-w-0">
                      <strong className={`font-medium ${toneClass(tone)}`}>{label}</strong>
                      {detail.length > 0 && (
                        <span className="mt-0.5 block text-pretty text-caption text-secondary-foreground">
                          {detail.join(' · ')}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
