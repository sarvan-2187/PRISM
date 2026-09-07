/**
 * Security timeline — what PRISM did, and why.
 * OWNER: S4   STATUS: stub, M1 task
 *
 * api.timeline(txId) returns the append-only audit trail for one transaction:
 * INTENT_LOCKED, CHALLENGE_ISSUED, ASSERTION_VERIFIED, CONTEXT_EVALUATED,
 * RISK_EVALUATED, STEP_UP_*, PAYMENT_SETTLED | PAYMENT_BLOCKED.
 *
 * This screen is what makes the attack demos self-evidencing: after each
 * blocked attempt, open it and the refusal is already recorded. Build it
 * early — it is worth more in judging than any amount of visual polish.
 */
export default function Timeline() {
  return (
    <div className="card">
      <h1>Security timeline</h1>
      <div className="todo">
        <strong>S4 — M1.</strong> Vertical list of audit events with timestamps and the risk
        reasons expanded. Render <code>data</code> as readable rows, not raw JSON.
      </div>
    </div>
  );
}
