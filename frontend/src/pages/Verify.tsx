/**
 * Semantic step-up — "enter the last two digits of the amount".
 * OWNER: S2   STATUS: stub, M2 task
 *
 * This is the only screen that tests comprehension rather than identity, so
 * it must show the REAL payee name and amount prominently. Do not phrase it
 * as "confirm payment" — the wording is the defence.
 *
 * Flow: api.stepUp(txId, answer) -> { next: 'REAUTHORIZE' }, then repeat the
 * challenge/approve pair from Review. Passing the step-up does not authorize
 * anything on its own; a fresh transaction-bound assertion is still required.
 * On STEP_UP_FAILED, details.attemptsRemaining says how many are left (max 3).
 */
export default function Verify() {
  return (
    <div className="card">
      <h1>Additional verification</h1>
      <div className="todo">
        <strong>S2 — M2.</strong> Show payee + amount, take two digits, call
        <code> api.stepUp()</code>, then re-authorize.
      </div>
    </div>
  );
}
