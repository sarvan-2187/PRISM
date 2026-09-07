/**
 * Outcome screen — receipt, or the reason it stopped.
 * OWNER: S2   STATUS: stub, M1 task
 *
 * Every failure code needs a plain-English screen; unknown codes must fall
 * back to a generic blocked state rather than crashing, so a Future Card can
 * introduce a new code without breaking the UI.
 */
export default function Status() {
  return (
    <div className="card">
      <h1>Payment status</h1>
      <div className="todo">
        <strong>S2 — M1.</strong> Receipt on APPROVED; otherwise the failure code, the risk
        reasons the server returned, and a link to the security timeline.
      </div>
    </div>
  );
}
