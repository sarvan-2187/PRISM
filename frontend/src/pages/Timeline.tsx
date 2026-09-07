/**
 * Security timeline. What PRISM did, and why.
 *
 * This is what makes the attack demonstrations self-evidencing: after any
 * blocked attempt, open this and the refusal is already recorded, in order,
 * with the conditions that produced it. The event vocabulary lives in
 * lib/events.ts and is shared with the live log, so the two can never
 * describe the same event differently.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, TimelineEvent, TransactionView } from '@/lib/api-client';
import { describeEvent, summarise, statusBadge, toneDot, STATUS_LABEL } from '@/lib/events';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export default function Timeline() {
  const { txId = '' } = useParams();
  const [tx, setTx] = useState<TransactionView | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.timeline(txId).then(
      ({ transaction, events: rows }) => {
        setTx(transaction);
        setEvents(rows);
      },
      (err) =>
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not reach PRISM. Check that the backend is running.'
        )
    );
  }, [txId]);

  if (error) {
    return (
      <Card>
        <CardContent className="grid gap-4 pt-6">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <Button asChild variant="secondary" block>
            <Link to="/home">Back to your account</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!tx) {
    return (
      <Card aria-busy="true">
        <CardContent className="grid gap-3 pt-6">
          <p className="text-small text-secondary-foreground">Reading the audit trail…</p>
          <Skeleton className="h-3.5 w-[60%]" />
          <Skeleton className="h-3.5 w-[40%]" />
        </CardContent>
      </Card>
    );
  }

  const started = events.length ? new Date(events[0].at).getTime() : 0;

  return (
    <div className="animate-enter-up">
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-h3 font-semibold">Security timeline</h1>
            <Badge variant={statusBadge(tx.status)}>
              {STATUS_LABEL[tx.status] ?? tx.status}
            </Badge>
          </div>
          <p className="mt-2 text-small text-secondary-foreground">
            {tx.amountFormatted} to {tx.payeeName}
            {tx.failureCode ? ` · ${tx.failureCode}` : ''}
          </p>

          {events.length === 0 ? (
            <div className="mt-6 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center">
              <h3 className="font-semibold">Nothing recorded yet</h3>
              <p className="mx-auto mt-2 max-w-[44ch] text-pretty text-small text-secondary-foreground">
                The first entry appears when the transaction is locked. If this stays empty, the
                payment was never started.
              </p>
            </div>
          ) : (
            <ol className="mt-6 border-l border-border-strong pl-5">
              {events.map((e, i) => {
                const { label, tone } = describeEvent(e.event);
                const detail = summarise(e.data);
                const offset = started ? new Date(e.at).getTime() - started : 0;
                return (
                  <li key={`${e.at}-${i}`} className="relative pb-5 pl-1 last:pb-0">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute -left-[25px] top-1.5 size-[9px] rounded-full outline outline-[3px] outline-background',
                        toneDot(tone)
                      )}
                    />
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-pretty font-medium">{label}</span>
                      <span className="shrink-0 text-caption tabular text-muted-foreground">
                        +{(offset / 1000).toFixed(1)}s
                      </span>
                    </div>
                    {detail.length > 0 && (
                      <ul className="mt-1 list-disc pl-4 text-small text-secondary-foreground">
                        {detail.map((d, j) => (
                          <li key={j} className="text-pretty">
                            {d}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          <p className="mt-6 text-pretty text-small text-secondary-foreground">
            Append-only. Entries are added, never edited or deleted, so this trail is evidence
            rather than a summary written after the fact.
          </p>

          <div className="mt-5 flex flex-wrap gap-2 max-md:flex-col">
            <Button asChild variant="secondary" className="flex-1">
              <Link to={`/pay/${txId}/status`}>Back to the result</Link>
            </Button>
            <Button asChild variant="secondary" className="flex-1">
              <Link to="/home">Your account</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
