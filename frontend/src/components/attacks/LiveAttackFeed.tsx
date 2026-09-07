/**
 * Real-time event stream for one attack (or legit-payment) run. Modeled
 * directly on components/LiveLog.tsx: poll while RUNNING, stop the moment
 * the run reaches a terminal state, degrade cleanly on RATE_LIMITED. Every
 * row rendered here is a real attack_run_events row the backend wrote at the
 * moment the corresponding real HTTP call or DB read resolved.
 */
import { useEffect, useState } from 'react';
import { attackApi, AttackApiError, RunDetail } from '@/lib/attackApi';
import { usePoll } from '@/lib/usePoll';
import { ACTOR_LABEL, ACTOR_TONE_CLASS, LAYER_LABEL } from '@/lib/attackEvents';
import { clockTime } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { OutcomeBadge } from './OutcomeBadge';

export function LiveAttackFeed({ runId, onRunUpdate }: { runId: string; onRunUpdate?: (detail: RunDetail) => void }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [rateLimited, setRateLimited] = useState(false);

  useEffect(() => {
    setDetail(null);
  }, [runId]);

  const { rateLimited: polledRateLimited } = usePoll(() => attackApi.run(runId), 900, {
    enabled: !detail || detail.run.status === 'RUNNING',
    onData: (data) => {
      setDetail(data);
      onRunUpdate?.(data);
    },
  });

  useEffect(() => {
    if (polledRateLimited) setRateLimited(true);
  }, [polledRateLimited]);

  return (
    <Card className="bg-secondary">
      <CardContent className="pt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold">Live attack execution</h3>
          {detail ? <OutcomeBadge status={detail.run.status} outcome={detail.run.outcome} /> : <Badge variant="info">Starting…</Badge>}
        </div>

        {rateLimited && (
          <p className="mb-3 text-pretty text-small text-secondary-foreground">
            PRISM is rate limiting this browser. Live updates paused — reload to catch up.
          </p>
        )}

        {detail?.run.summary && (
          <p className="mb-4 text-pretty text-small">{detail.run.summary}</p>
        )}
        {detail?.run.error_message && (
          <p className="mb-4 text-pretty text-small text-destructive">Error: {detail.run.error_message}</p>
        )}

        {!detail && <p className="text-small text-secondary-foreground">Waiting for the first real event…</p>}

        {detail && detail.events.length > 0 && (
          <ol className="grid gap-2" aria-live="polite">
            {detail.events.map((e) => (
              <li
                key={e.id}
                className="grid animate-log-in grid-cols-[68px_1fr] items-baseline gap-3 border-b pb-2 text-small last:border-0 last:pb-0"
              >
                <span className="font-mono text-caption tabular text-muted-foreground">{clockTime(e.ts)}</span>
                <span className="min-w-0">
                  <strong className={`font-medium ${ACTOR_TONE_CLASS[e.actor]}`}>{ACTOR_LABEL[e.actor]}</strong>
                  {e.prism_layer && e.prism_layer !== 'NONE' && (
                    <span className="ml-2 text-caption text-muted-foreground">· {LAYER_LABEL[e.prism_layer]}</span>
                  )}
                  <span className="mt-0.5 block text-pretty text-caption text-secondary-foreground">{e.message}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
