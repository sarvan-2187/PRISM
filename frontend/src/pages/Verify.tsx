/**
 * Semantic step-up — "enter the last two digits of the amount".
 *
 * This is the only screen in PRISM that tests comprehension rather than
 * identity, so the wording is the defence. It deliberately does not say
 * "confirm payment": a person being talked through a transfer by a scammer
 * will confirm anything. Reading the recipient's real name and typing the
 * real number is a conscious act, not a reflex.
 *
 * Passing does not authorize. It returns to the challenge/approve pair for a
 * fresh transaction-bound assertion.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, TransactionView } from '../lib/api-client';
import { webauthn, describeWebAuthnError } from '../lib/webauthn-client';

export default function Verify() {
  const { txId = '' } = useParams();
  const navigate = useNavigate();
  const [tx, setTx] = useState<TransactionView | null>(null);
  const [answer, setAnswer] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.payment(txId).then(setTx, () => setError('Could not load this payment.'));
  }, [txId]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.stepUp(txId, answer);
      // Verified understanding, not identity — now prove identity again,
      // bound to this exact transaction.
      const options = await api.challenge(txId);
      const assertion = await webauthn.approve(options);
      await api.authorize(txId, assertion);
      navigate(`/pay/${txId}/status`);
    } catch (err) {
      if (err instanceof ApiError) {
        const left = (err.details as { attemptsRemaining?: number })?.attemptsRemaining;
        setRemaining(left ?? null);
        if (left === 0 || err.failureCode !== 'STEP_UP_FAILED') {
          navigate(`/pay/${txId}/status`);
          return;
        }
        setError(`That is not the right number. ${left} attempt${left === 1 ? '' : 's'} left.`);
        setAnswer('');
      } else {
        setError(describeWebAuthnError(err));
      }
      setBusy(false);
    }
  }, [answer, navigate, txId]);

  if (!tx) return <div className="card"><p className="muted">{error ?? 'Loading…'}</p></div>;

  return (
    <div className="card">
      <span className="badge warn">Additional verification</span>
      <h1 style={{ marginTop: 12 }}>Check this payment</h1>

      <p className="callout">
        You are sending <strong>{tx.amountFormatted}</strong> to{' '}
        <strong>{tx.payeeName}</strong>.
      </p>

      {tx.riskReasons.length > 0 && (
        <ul className="reasons">
          {tx.riskReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      <p className="muted">
        PRISM will never call you and ask you to move money. Banks will never ask
        you to transfer funds to a &ldquo;safe account&rdquo;.
      </p>

      <div className="field" style={{ marginTop: 20 }}>
        <label htmlFor="answer">Enter the last two digits of the amount you intend to send</label>
        <input
          id="answer"
          inputMode="numeric"
          maxLength={2}
          value={answer}
          autoComplete="off"
          onChange={(e) => setAnswer(e.target.value.replace(/\D/g, '').slice(0, 2))}
          onKeyDown={(e) => e.key === 'Enter' && answer.length === 2 && !busy && submit()}
          style={{ fontSize: 24, letterSpacing: '0.4em', textAlign: 'center' }}
        />
      </div>

      <button onClick={submit} disabled={answer.length !== 2 || busy}>
        {busy ? 'Verifying…' : 'Confirm and approve'}
      </button>

      {error && (
        <div className="error">
          {error}
          {remaining === 1 && (
            <>
              <br />
              <strong>Last attempt.</strong> After this the payment is closed and you will need
              to start a new one.
            </>
          )}
        </div>
      )}
    </div>
  );
}
