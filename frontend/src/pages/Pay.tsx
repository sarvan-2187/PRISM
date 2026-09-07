/**
 * Payment composer — pick a payee, enter an amount, lock the intent.
 * OWNER: S2   STATUS: stub, M1 task
 *
 * Contract:
 *   api.payees()                       -> Payee[]  (knownPayee drives risk)
 *   api.initiate(payeeAccountId, minor) -> TransactionView
 * Amounts are MINOR UNITS (paise): ₹5,000 is 500000. Never send a float.
 * On success: navigate(`/pay/${tx.txId}`) — the review screen re-fetches
 * from the server rather than trusting anything carried across.
 */
export default function Pay() {
  return (
    <div className="card">
      <h1>Send a payment</h1>
      <p className="muted">Choose who you are paying and how much.</p>
      <div className="todo" style={{ marginTop: 16 }}>
        <strong>S2 — M1.</strong> Payee list from <code>api.payees()</code>, amount input in
        rupees converted to paise, then <code>api.initiate()</code> and navigate to
        <code> /pay/:txId</code>. See <code>Landing.tsx</code> for the error-handling pattern.
      </div>
    </div>
  );
}
