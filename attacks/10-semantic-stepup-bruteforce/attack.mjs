/**
 * Attack: Semantic step-up brute force (last-two-digits challenge)
 *
 * Protection under test: backend/src/modules/semantic/intentCheck.ts verify() —
 * single-use, 180s TTL, capped at policy.stepUp.maxAttempts = 3 wrong
 * answers before the challenge is destroyed, combined with the strict rate
 * limiter (backend/src/api/middleware/rateLimiter.ts) on
 * POST /payment/:id/step-up. Without the attempt cap, a two-digit answer
 * is guessable in at most 100 tries.
 *
 * Unlike every other script in this suite, reaching STEP_UP_REQUIRED
 * requires a REAL risk decision from backend/src/modules/risk/riskEngine.ts,
 * which only runs after a genuine WebAuthn signature verifies (authorize
 * pipeline step 5, before step 6-8). So this script drives its own virtual
 * authenticator (see ../lib/webauthn.mjs) to register, log in, and sign one
 * real payment approval to a never-paid payee for a large amount — the
 * combination PLAN.md §3.5 documents as reliably tripping STEP_UP
 * (NO_BASELINE + NEW_PAYEE, a fresh profile's two unavoidable signals).
 *
 * If the live risk engine instead scores APPROVE or BLOCK for the amount
 * chosen here, this script reports that honestly and exits without forcing
 * a result — thresholds are policy-owned (S2) and can legitimately differ
 * from what this script assumes.
 */
import * as wa from '../lib/webauthn.mjs';
import { post, get } from '../lib/api.mjs';
import { loadState } from '../lib/state.mjs';
import * as p from '../lib/print.mjs';

const AMOUNT = 4_800_000; // ₹48,000 — PLAN.md §2.7/§3.5's own worked "second profile" example
const WRONG_ANSWERS = ['00', '11', '22', '99'];

async function main() {
  const state = loadState();
  const strangerPayeeAccountId = state.strangerPayeeAccountId;
  if (!strangerPayeeAccountId) throw new Error('No never-paid payee in .state.json — rerun npm run setup');

  p.section('Semantic Step-Up Brute Force');
  p.target('POST', '/api/v1/payment/:id/step-up');

  console.log('[+] Driving a fresh passkey + one real signed payment to reach STEP_UP_REQUIRED...');
  const { context, page, close } = await wa.launch();
  let txId, decisionBody, cookie;
  try {
    await wa.registerPasskey(page, 'asha@prism.demo');
    await wa.login(page, 'asha@prism.demo');
    cookie = await wa.sessionCookie(context);

    const locked = await post(
      '/api/v1/payment/initiate',
      { payeeAccountId: strangerPayeeAccountId, amountMinor: AMOUNT },
      { cookie }
    );
    if (locked.status !== 201) throw new Error(`initiate failed: ${locked.status} ${JSON.stringify(locked.body)}`);
    txId = locked.body.txId;
    console.log(`[+] Locked ${txId} for ₹${AMOUNT / 100} to a never-paid payee`);

    const authResult = await wa.approvePayment(page, txId, 500); // fast approval also feeds HASTY_APPROVAL
    decisionBody = authResult.body;
    console.log(`[+] Real signed authorize -> ${authResult.status} ${JSON.stringify(decisionBody)}`);
  } finally {
    await close();
  }

  if (decisionBody?.failureCode === 'SIG_INVALID') {
    p.skipped(
      `The real signed assertion failed WebAuthn signature verification (SIG_INVALID) before the risk ` +
        `engine ever ran, so no STEP_UP_REQUIRED transaction was reached. This is a known, separately ` +
        `documented issue in the intent-hash-to-WebAuthn-challenge encoding used by the payment-approval ` +
        `path (backend/src/modules/identity/webauthn.ts paymentChallenge()/verifyPaymentAssertion()) — see ` +
        `"Known Limitations" in attack.md. It affects every real payment approval in the running app, not ` +
        `just this attack, and is out of scope for S3 (attacks/**) to fix. Not a failure of the semantic ` +
        `step-up control itself, which this script cannot yet reach to test.`
    );
    p.finish('SKIPPED');
    return;
  }

  if (decisionBody?.decision !== 'STEP_UP') {
    p.skipped(
      `Live risk decision was '${decisionBody?.decision ?? 'unknown'}', not STEP_UP, for this amount/payee ` +
        `combination on this run. This attack needs a STEP_UP_REQUIRED transaction to test the semantic ` +
        `challenge against — see backend/src/config/policy.ts risk thresholds and RULES. Not a failure of ` +
        `the control being tested; rerun once a live STEP_UP has been observed (see attack.md §7).`
    );
    p.finish('SKIPPED');
    return;
  }

  console.log(`[+] Reached STEP_UP_REQUIRED as intended. Reasons: ${decisionBody.reasons.join('; ')}`);
  console.log(`[+] Brute-forcing the last-two-digits challenge (cap is ${WRONG_ANSWERS.length - 1} allowed wrong tries)`);

  const results = [];
  for (const answer of WRONG_ANSWERS) {
    const res = await post(`/api/v1/payment/${txId}/step-up`, { answer }, { cookie });
    results.push({ answer, status: res.status, body: res.body });
    console.log(`    guess "${answer}" -> ${res.status} ${JSON.stringify(res.body)}`);
  }

  const exhausted = results.some((r) => r.body?.attemptsRemaining === 0);
  const anySucceeded = results.some((r) => r.status === 200);
  const tx = await get(`/api/v1/payment/${txId}`, { cookie });
  console.log(`[+] Final transaction status: ${tx.body.status}`);

  if (anySucceeded) {
    p.vulnerability('A brute-forced guess against the last-two-digits challenge succeeded.');
    p.finish('VULNERABILITY');
  } else if (exhausted && results.every((r) => r.status === 403 && r.body?.failureCode === 'STEP_UP_FAILED')) {
    p.pass(`all ${WRONG_ANSWERS.length} wrong guesses refused; attempts exhausted at the configured cap`);
    p.finish('PASS');
  } else {
    p.fail('Unexpected sequence of responses — see the guesses above.');
    p.finish('ERROR');
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exitCode = 2;
});
