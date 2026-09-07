/**
 * Outcome — receipt, or the reason it stopped.
 *
 * Unknown failure codes fall back to a generic blocked state rather than
 * crashing. That matters beyond tidiness: a Future Card may introduce a new
 * code at midnight, and the UI has to degrade instead of breaking.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, TransactionView } from '../lib/api-client';

/** Plain English for each documented refusal, and what it stopped. */
const FAILURES: Record<string, { title: string; blurb: string }> = {
  TAMPER_BLOCKED: {
    title: 'Details were altered after approval',
    blurb:
      'The signed approval no longer matches the locked transaction. Someone changed the amount or the recipient after you approved.',
  },
  REPLAY_BLOCKED: {
    title: 'Already processed',
    blurb: 'This payment has been settled once. A captured request cannot be sent again.',
  },
  INTENT_EXPIRED: {
    title: 'Approval window closed',
    blurb: 'The transaction was not approved within its window. Nothing was charged.',
  },
  RISK_BLOCKED: {
    title: 'Blocked as high risk',
    blurb: 'The situation around this payment looked wrong. The reasons are listed below.',
  },
  STEP_UP_FAILED: {
    title: 'Verification failed',
    blurb:
      'The amount could not be confirmed. This payment is closed — start a new one if it was genuine.',
  },
  INSUFFICIENT_FUNDS: {
    title: 'Insufficient balance',
    blurb: 'Not an attack — an ordinary business rule.',
  },
  SIG_INVALID: {
    title: 'Signature did not verify',
    blurb: 'The approval was not produced by a passkey registered to this account.',
  },
  ORIGIN_MISMATCH: {
    title: 'Wrong origin',
    blurb: 'The request came from a domain this credential was not registered for.',
  },
};

export default function Status() {
  const { txId = '' } = useParams();
  const [tx, setTx] = useState<TransactionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.payment(txId).then(setTx, (err) =>
      setError(err instanceof ApiError ? err.message : String(err))
    );
  }, [txId]);

  if (error) return <div className="card"><div className="error">{error}</div></div>;
  if (!tx) return <div className="card"><p className="muted">Loading…</p></div>;

  const settled = tx.status === 'SETTLED';
  const failure = tx.failureCode
    ? (FAILURES[tx.failureCode] ?? {
        title: 'Payment stopped',
        blurb: 'This payment did not complete. No money moved.',
      })
    : null;

  return (
    <div className="card">
      {settled ? (
        <>
          <span className="badge ok">Settled</span>
          <h1 style={{ marginTop: 12 }}>{tx.amountFormatted} sent</h1>
          <p className="muted">
            to {tx.payeeName} · {tx.payeeHandle}
          </p>
        </>
      ) : (
        <>
          <span className="badge danger">{tx.failureCode ?? tx.status}</span>
          <h1 style={{ marginTop: 12 }}>{failure?.title ?? 'Payment stopped'}</h1>
          <p className="muted">{failure?.blurb}</p>
          <p className="muted" style={{ marginTop: 12 }}>
            <strong>No money moved.</strong> {tx.amountFormatted} to {tx.payeeName} was not sent.
          </p>
        </>
      )}

      {tx.riskReasons.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h2>Why{tx.riskScore !== null ? ` (risk ${tx.riskScore})` : ''}</h2>
          <ul className="reasons">
            {tx.riskReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="muted">
            Every decision states the conditions that produced it. Nothing here is a
            black-box score.
          </p>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <Link to={`/pay/${txId}/timeline`}>
          <button className="secondary">View security timeline</button>
        </Link>
        <Link to="/pay">
          <button className="secondary">New payment</button>
        </Link>
      </div>
    </div>
  );
}
