/**
 * Intent review + approval — the security-critical screen.
 * OWNER: S2   STATUS: stub, M1 task
 *
 * NON-NEGOTIABLE: every value rendered here comes from api.payment(txId).
 * Nothing is read from a QR code, a URL parameter, or state carried from the
 * composer. That single rule is what defeats QR tampering, and a judge will
 * ask about it directly.
 *
 * Flow:
 *   1. api.payment(txId)      -> render payee, amount, countdown
 *   2. record the moment details appeared (for deliberationMs)
 *   3. api.challenge(txId)    -> options whose challenge IS the intent hash
 *   4. webauthn.approve(opts) -> assertion
 *   5. api.authorize(txId, assertion, deliberationMs)
 *        APPROVED -> /pay/:id/status
 *        STEP_UP  -> /pay/:id/verify
 *      ApiError   -> show failureCode (TAMPER_BLOCKED, INTENT_EXPIRED,
 *                    REPLAY_BLOCKED, RISK_BLOCKED, SIG_INVALID)
 */
export default function Review() {
  return (
    <div className="card">
      <h1>Review payment</h1>
      <div className="todo">
        <strong>S2 — M1.</strong> Server-authoritative details, live expiry countdown from
        <code> secondsRemaining</code>, then passkey approval. Render only what the server sent.
      </div>
    </div>
  );
}
