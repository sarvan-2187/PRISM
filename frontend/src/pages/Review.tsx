/**
 * Intent review and approval — the security-critical screen.
 *
 * NON-NEGOTIABLE: every value rendered here comes from api.payment(txId).
 * Nothing is read from a QR code, a URL parameter, or state carried from the
 * composer. That single rule is what defeats QR tampering: a swapped sticker
 * can point somewhere, but the screen shows what the server's locked record
 * actually says.
 *
 * The countdown is the intent lock made visible. When it reaches zero the
 * approval window has closed and the transaction is dead — a new payment
 * means a new id, a new nonce and a new hash.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, ApiError, TransactionView } from '../lib/api-client';
import { webauthn, describeWebAuthnError } from '../lib/webauthn-client';

export default function Review() {
  const { txId = '' } = useParams();
  const navigate = useNavigate();
  const [tx, setTx] = useState<TransactionView | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const shownAt = useRef<number>(Date.now());

  const load = useCallback(async () => {
    try {
      const fresh = await api.payment(txId);
      setTx(fresh);
      setRemaining(fresh.secondsRemaining);
      shownAt.current = Date.now();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? { code: err.failureCode, message: err.message }
          : { code: 'UNKNOWN', message: String(err) }
      );
    }
  }, [txId]);

  useEffect(() => {
    load();
  }, [load]);

  // Local countdown off the server's own secondsRemaining. The server decides
  // expiry; this only shows it.
  useEffect(() => {
    if (remaining <= 0) return;
    const t = setInterval(() => setRemaining((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [remaining]);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      // The challenge returned here IS the intent hash. The device signs that
      // exact value, so the signature is void for any other transaction.
      const options = await api.challenge(txId);
      const assertion = await webauthn.approve(options);
      const result = await api.authorize(txId, assertion);

      if (result.decision === 'STEP_UP') {
        navigate(`/pay/${txId}/verify`);
        return;
      }
      navigate(`/pay/${txId}/status`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError({ code: err.failureCode, message: err.message });
        // Terminal refusals belong on the status screen with the full reasons.
        if (['RISK_BLOCKED', 'REPLAY_BLOCKED', 'TAMPER_BLOCKED', 'INTENT_EXPIRED'].includes(err.failureCode)) {
          navigate(`/pay/${txId}/status`);
          return;
        }
      } else {
        setError({ code: 'PASSKEY', message: describeWebAuthnError(err) });
      }
      setBusy(false);
    }
  }

  if (error && !tx) return <div className="card"><h1>Cannot load payment</h1><div className="error">{error.code}: {error.message}</div></div>;
  if (!tx) return <div className="card"><p className="muted">Loading…</p></div>;

  const expired = remaining <= 0;

  return (
    <div className="card">
      <h1>Review payment</h1>
      <p className="muted">These details come from the server, not from this page.</p>

      <dl className="detail" style={{ marginTop: 20 }}>
        <dt>To</dt>
        <dd>
          <strong>{tx.payeeName}</strong>
          <span className="muted"> · {tx.payeeHandle}</span>
        </dd>
        <dt>Amount</dt>
        <dd className="amount">{tx.amountFormatted}</dd>
        <dt>Approval window</dt>
        <dd>
          {expired ? (
            <span className="badge danger">expired</span>
          ) : (
            <span className={remaining <= 20 ? 'badge warn' : 'badge ok'}>
              {remaining}s remaining
            </span>
          )}
        </dd>
      </dl>

      <p className="muted" style={{ marginTop: 16 }}>
        Your passkey will sign this transaction&rsquo;s fingerprint, not a random
        number. Change one rupee and the signature stops verifying.
      </p>
      <p className="hash" title="base64url SHA-256 of the locked intent">
        intent {tx.intentHash.slice(0, 24)}…
      </p>

      {expired ? (
        <Link to="/pay"><button className="secondary">Start a new payment</button></Link>
      ) : (
        <button onClick={approve} disabled={busy}>
          {busy ? 'Waiting for passkey…' : `Approve ${tx.amountFormatted}`}
        </button>
      )}
      <Link to="/pay"><button className="secondary">Cancel</button></Link>

      {error && (
        <div className="error">
          <strong>{error.code}</strong> — {error.message}
        </div>
      )}
    </div>
  );
}
