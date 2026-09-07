/**
 * Payment composer — pick a payee, enter an amount, lock the intent.
 *
 * Amounts are entered in rupees and sent in paise. The conversion happens
 * once, here, and rounds rather than truncates. Nothing downstream ever sees
 * a decimal: the amount is hashed into the intent, and a value that can be
 * formatted two ways can be hashed two ways.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, Payee } from '../lib/api-client';

/**
 * Demo presets.
 *
 * The risk engine grades an amount against the payer's LARGEST settled
 * payment (seeded at Rs 1,981), and a never-paid recipient is its strongest
 * single signal. These three combinations therefore reach three different
 * decisions from the same browser, with no profile switching:
 *
 *   known payee, ordinary        ->  score 0    APPROVE
 *   stranger, 3x-50x usual       ->  score 60   STEP_UP
 *   stranger, over 50x usual     ->  score 85   BLOCK
 *
 * Nothing here is faked: the engine is the real one and these merely fill the
 * form. Run `npm run db:reset && npm run db:seed` between full rehearsals —
 * once a large payment settles it becomes the new normal and the bands move.
 */
const PRESETS = [
  { label: 'Everyday payment', match: 'Priya', rupees: 2000, expect: 'approve', hint: 'known recipient, ordinary amount' },
  { label: 'Large, to a stranger', match: 'RAJESH', rupees: 25000, expect: 'step up', hint: 'never paid before, well above your usual' },
  { label: 'Huge, to a stranger', match: 'SafeAccount', rupees: 115000, expect: 'block', hint: 'never paid before, far beyond anything you have sent' },
] as const;

export default function Pay() {
  const navigate = useNavigate();
  const [payees, setPayees] = useState<Payee[]>([]);
  const [payeeId, setPayeeId] = useState('');
  const [rupees, setRupees] = useState('5000');
  const [balance, setBalance] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.me().then(
      (me) => setBalance(me.balanceFormatted),
      () => navigate('/', { replace: true })
    );
    api.payees().then((list) => {
      setPayees(list);
      if (list.length) setPayeeId(list[0].accountId);
    }, () => setError('Could not load recipients.'));
  }, [navigate]);

  const amountMinor = Math.round(Number(rupees) * 100);
  const valid = payeeId !== '' && Number.isInteger(amountMinor) && amountMinor > 0;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const tx = await api.initiate(payeeId, amountMinor);
      // Nothing is carried across. The review screen re-fetches from the
      // server, which is what makes tampering pointless.
      navigate(`/pay/${tx.txId}`);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.failureCode}: ${err.message}` : String(err));
      setBusy(false);
    }
  }

  const selected = payees.find((p) => p.accountId === payeeId);

  function applyPreset(match: string, amount: number) {
    const target = payees.find((p) => p.displayName.includes(match));
    if (target) setPayeeId(target.accountId);
    setRupees(String(amount));
    setError(null);
  }

  return (
    <div className="card">
      <h1>Send a payment</h1>
      <p className="muted">
        {balance ? `Balance ${balance}` : 'Loading…'}
      </p>

      <div className="field" style={{ marginTop: 20 }}>
        <label htmlFor="payee">Recipient</label>
        <select id="payee" value={payeeId} onChange={(e) => setPayeeId(e.target.value)}>
          {payees.map((p) => (
            <option key={p.accountId} value={p.accountId}>
              {p.displayName} · {p.handle}
              {p.knownPayee ? '' : '  (never paid before)'}
            </option>
          ))}
        </select>
        {selected && !selected.knownPayee && (
          <p className="muted" style={{ marginTop: 6 }}>
            You have not paid this recipient before — PRISM will weigh that.
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor="amount">Amount (₹)</label>
        <input
          id="amount"
          type="number"
          min="1"
          step="1"
          value={rupees}
          onChange={(e) => setRupees(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && valid && !busy && submit()}
        />
        <p className="muted" style={{ marginTop: 6 }}>
          Sent as {amountMinor.toLocaleString('en-IN')} paise.
        </p>
      </div>

      <button onClick={submit} disabled={!valid || busy}>
        {busy ? 'Locking intent…' : 'Continue'}
      </button>

      {error && <div className="error">{error}</div>}

      <div className="presets">
        <h2>Demo scenarios</h2>
        <p className="muted">
          Each fills the form so the real risk engine reaches a different decision.
        </p>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className="secondary preset"
            onClick={() => applyPreset(p.match, p.rupees)}
          >
            <span>
              <strong>{p.label}</strong>
              <span className="muted"> — {p.hint}</span>
            </span>
            <span className={`badge ${p.expect === 'approve' ? 'ok' : p.expect === 'step up' ? 'warn' : 'danger'}`}>
              {p.expect}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
