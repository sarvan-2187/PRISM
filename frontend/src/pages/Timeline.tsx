/**
 * Security timeline — what PRISM did, and why.
 *
 * This is what makes the attack demos self-evidencing: after any blocked
 * attempt, open this and the refusal is already recorded, in order, with the
 * conditions that produced it. It is worth more in judging than any amount of
 * visual polish, which is why it is built before the polish.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, TimelineEvent, TransactionView } from '../lib/api-client';

/** Plain English per audit event, so the trail reads rather than decodes. */
const EVENTS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'plain' }> = {
  INTENT_LOCKED: { label: 'Transaction frozen and hashed', tone: 'plain' },
  CHALLENGE_ISSUED: { label: 'Challenge issued — the intent hash', tone: 'plain' },
  ASSERTION_VERIFIED: { label: 'Passkey signature verified against that hash', tone: 'ok' },
  CONTEXT_EVALUATED: { label: 'Device, network and history examined', tone: 'plain' },
  RISK_EVALUATED: { label: 'Risk scored', tone: 'plain' },
  STEP_UP_ISSUED: { label: 'Comprehension check issued', tone: 'warn' },
  STEP_UP_PASSED: { label: 'Comprehension check passed', tone: 'ok' },
  STEP_UP_FAILED: { label: 'Comprehension check failed', tone: 'danger' },
  QR_ISSUED: { label: 'Signed payment request created', tone: 'plain' },
  QR_REDEEMED: { label: 'Payment request scanned', tone: 'plain' },
  PAYMENT_SETTLED: { label: 'Money moved, exactly once', tone: 'ok' },
  PAYMENT_BLOCKED: { label: 'Payment refused', tone: 'danger' },
};

/** Fields worth surfacing; everything else stays folded away. */
function summarise(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (k: string, label: string) => {
    if (data[k] !== undefined && data[k] !== null) out.push(`${label}: ${String(data[k])}`);
  };
  push('failureCode', 'code');
  push('score', 'score');
  push('decision', 'decision');
  push('attemptsUsed', 'attempts used');
  if (Array.isArray(data.firedRuleIds) && data.firedRuleIds.length)
    out.push(`rules: ${(data.firedRuleIds as string[]).join(', ')}`);
  if (Array.isArray(data.reasons) && data.reasons.length)
    out.push(...(data.reasons as string[]));
  if (data.challengeIsIntentHash) out.push('challenge = intent hash');
  if (typeof data.deliberationMs === 'number')
    out.push(`considered for ${Math.round(data.deliberationMs / 100) / 10}s`);
  return out;
}

export default function Timeline() {
  const { txId = '' } = useParams();
  const [tx, setTx] = useState<TransactionView | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.timeline(txId).then(
      ({ transaction, events }) => {
        setTx(transaction);
        setEvents(events);
      },
      (err) => setError(err instanceof ApiError ? err.message : String(err))
    );
  }, [txId]);

  if (error) return <div className="card"><div className="error">{error}</div></div>;
  if (!tx) return <div className="card"><p className="muted">Loading…</p></div>;

  const started = events.length ? new Date(events[0].at).getTime() : 0;

  return (
    <div className="card">
      <h1>Security timeline</h1>
      <p className="muted">
        {tx.amountFormatted} to {tx.payeeName} · {tx.status}
        {tx.failureCode ? ` · ${tx.failureCode}` : ''}
      </p>

      <ol className="timeline">
        {events.map((e, i) => {
          const meta = EVENTS[e.event] ?? { label: e.event, tone: 'plain' as const };
          const detail = summarise(e.data);
          const offset = started ? new Date(e.at).getTime() - started : 0;
          return (
            <li key={i} className={`tone-${meta.tone}`}>
              <div className="tl-head">
                <span className="tl-label">{meta.label}</span>
                <span className="muted">+{(offset / 1000).toFixed(1)}s</span>
              </div>
              {detail.length > 0 && (
                <ul className="tl-detail">
                  {detail.map((d, j) => (
                    <li key={j}>{d}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      {events.length === 0 && <p className="muted">No events recorded yet.</p>}

      <p className="muted" style={{ marginTop: 16 }}>
        Append-only. Records are added, never edited or deleted.
      </p>

      <Link to={`/pay/${txId}/status`}>
        <button className="secondary">Back to result</button>
      </Link>
    </div>
  );
}
