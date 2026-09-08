import { resolveSession } from '../deviceSession';
import { post, get } from '../httpClient';
import { getNeverPaidPayee, getTransaction } from '../demoData';
import { runLegitPayment } from '../legitPayment';
import { policy } from '../../../config/policy';
import { AttackContext, AttackFn } from '../types';

const AMOUNT = 4_800_000; // ₹48,000 — designed to trip NO_BASELINE + NEW_PAYEE into STEP_UP

/**
 * Guesses for the SEMANTIC challenge — the last two digits of the RUPEE
 * amount (see backend/src/modules/semantic/intentCheck.ts issue()): for
 * ₹48,000 that is "00". The real answer is excluded so the run tests the
 * attempt cap honestly rather than accidentally guessing right.
 */
const CORRECT_ANSWER = String(Math.floor(AMOUNT / 100) % 100).padStart(2, '0');
const SEMANTIC_GUESSES = ['13', '47', '58', '91'].filter((a) => a !== CORRECT_ANSWER);

/**
 * Guesses for the AUTHENTICATOR challenge — the six digits every paired
 * account now uses. Unlike the two-digit quiz there is no answer to exclude:
 * the code is HMAC(device secret, intent hash), the attacker does not hold
 * the secret, and one guess in a million landing is not something a demo has
 * to design around. If one ever did, the run reports SUCCEEDED and that would
 * be a genuine finding rather than a lucky roll.
 */
const CODE_GUESSES = ['000000', '123456', '111111', '999999'];

interface GuessOutcome {
  outcome: 'SUCCEEDED' | 'BLOCKED' | 'SIMULATED';
  summary: string;
}

/**
 * The attempt cap is what this scenario actually tests, so the guess list is
 * built to exceed it by exactly one: enough to prove the cap closes the
 * transaction, and to prove the guess AFTER the cap is refused too.
 */
function guessesFor(mode: string): string[] {
  const pool = mode === 'AUTHENTICATOR' ? CODE_GUESSES : SEMANTIC_GUESSES;
  return pool.slice(0, policy.stepUp.maxAttempts + 1);
}

async function bruteForce(ctx: AttackContext, txId: string, cookie: string): Promise<GuessOutcome> {
  /*
   * Read the mode off the transaction rather than assuming it.
   *
   * This is what an earlier version got wrong: it always guessed two digits.
   * Against a paired account — which is every realistic demo account — the
   * step-up is the six-digit code, so those guesses died at the closed
   * acceptance window before the cap was ever touched, no attemptsRemaining
   * came back, and the run reported SIMULATED with "unexpected sequence of
   * guess responses" while the control was in fact working perfectly.
   */
  const tx = await getTransaction(txId);
  const mode = tx.step_up_mode ?? 'SEMANTIC';
  const guesses = guessesFor(mode);
  const label = mode === 'AUTHENTICATOR' ? 'six-digit transaction code' : 'last-two-digits challenge';

  /*
   * The six-digit path needs the 60-second acceptance window OPEN, and the
   * attacker can open it: they hold the session, and asking the portal for a
   * code window is something the real payer's browser does. What they cannot
   * do is produce the code, because that needs the phone. Opening it here is
   * what makes the run a test of the CODE rather than a test of the window.
   */
  if (mode === 'AUTHENTICATOR') {
    const opened = await get(`/api/v1/payment/${txId}/step-up/token`, { cookie });
    // Layer stays SEMANTIC for both modes: the attempt cap, the audit events
    // and the pass flag all live in that module, whichever challenge answered.
    await ctx.log(
      'ATTACKER',
      'SEMANTIC',
      opened.status === 200
        ? 'Attacker opens the 60s acceptance window with the stolen session — allowed, and useless without the phone'
        : `Could not open the acceptance window (${opened.status}) — guessing against a closed window`,
      { response: opened.body }
    );
  }

  await ctx.log(
    'ATTACKER',
    'SEMANTIC',
    `Attacker brute-forces the ${label} (cap is ${policy.stepUp.maxAttempts} allowed wrong tries)`,
    {}
  );

  const results: Array<{ answer: string; status: number; body: unknown }> = [];
  for (const answer of guesses) {
    const res = await post(`/api/v1/payment/${txId}/step-up`, { answer }, { cookie });
    results.push({ answer, status: res.status, body: res.body });
    const remaining = (res.body as { attemptsRemaining?: number })?.attemptsRemaining;
    await ctx.log(
      'PRISM',
      'SEMANTIC',
      `Guess "${answer}" -> ${res.status} ${(res.body as { failureCode?: string })?.failureCode ?? ''}${
        typeof remaining === 'number' ? ` (${remaining} attempts left)` : ''
      }`.trim(),
      { response: res.body }
    );
  }

  const anySucceeded = results.some((r) => r.status === 200);
  const exhausted = results.some(
    (r) => (r.body as { attemptsRemaining?: number })?.attemptsRemaining === 0
  );
  const allRefused = results.every(
    (r) => r.status === 403 && (r.body as { failureCode?: string })?.failureCode === 'STEP_UP_FAILED'
  );

  const finalTx = await getTransaction(txId);
  await ctx.log('SYSTEM', null, `Final transaction status: ${finalTx.status}`, {});

  if (anySucceeded) {
    return {
      outcome: 'SUCCEEDED',
      summary: `A brute-forced guess against the ${label} succeeded.`,
    };
  }
  if (exhausted && allRefused && finalTx.status === 'BLOCKED') {
    return {
      outcome: 'BLOCKED',
      summary:
        `All ${guesses.length} wrong guesses were refused and the transaction was blocked ` +
        `terminally once the ${policy.stepUp.maxAttempts}-attempt cap was reached. The cap is ` +
        `counted per transaction, so there is no reset path: a ${
          mode === 'AUTHENTICATOR' ? 'million-code' : 'hundred-answer'
        } keyspace never gets a fourth try.`,
    };
  }

  /*
   * Below here the control did not misbehave — the run just could not
   * exercise it cleanly. Say WHICH condition was missing rather than
   * "unexpected sequence", which sent a reader hunting through the log.
   */
  const missing: string[] = [];
  if (!allRefused) missing.push('not every guess came back 403 STEP_UP_FAILED');
  if (!exhausted) missing.push('no response reported attemptsRemaining: 0');
  if (finalTx.status !== 'BLOCKED') missing.push(`final status was ${finalTx.status}, not BLOCKED`);
  return {
    outcome: 'SIMULATED',
    summary: `The brute-force path could not be exercised cleanly on this run: ${missing.join('; ')}. See the event log.`,
  };
}

export const stepUpBruteforce: AttackFn = async (ctx, target) => {
  if (target.transactionId) {
    const liveTx = await getTransaction(target.transactionId);
    if (liveTx.status === 'STEP_UP_REQUIRED') {
      const session = await resolveSession(target.victimSessionCookie, target.payerUserId, target.payerEmail);
      await ctx.log(
        'ATTACKER',
        'IDENTITY',
        session.selfEstablished
          ? `Attacker authenticated as ${target.payerEmail} itself (no captured session pasted)`
          : `Attacker device is using a real captured session cookie for ${target.payerEmail}`,
        {}
      );
      await ctx.log(
        'SYSTEM',
        null,
        `Real live transaction already at STEP_UP_REQUIRED (mode: ${liveTx.step_up_mode ?? 'SEMANTIC'}) — brute-forcing it directly: ${liveTx.id}`,
        { txId: liveTx.id }
      );
      const result = await bruteForce(ctx, liveTx.id, session.cookie);
      return { ...result, targetTransactionId: liveTx.id };
    }
    await ctx.log('SYSTEM', null, `Selected live transaction ${liveTx.id} is not at STEP_UP_REQUIRED (status: ${liveTx.status}) — creating a fresh one to reach that state instead`, {});
  }

  const payee = await getNeverPaidPayee(target.payerUserId);
  if (!payee) throw new Error('No never-paid payee available for this user — cannot reliably reach STEP_UP.');

  const { txId, session, authorize } = await runLegitPayment(ctx, {
    userId: target.payerUserId,
    email: target.payerEmail,
    payeeAccountId: payee.id,
    amountMinor: AMOUNT,
    deliberationMs: 500,
  });

  if (authorize.body?.failureCode === 'SIG_INVALID') {
    return {
      outcome: 'SIMULATED',
      summary: 'The signed approval failed WebAuthn verification before the risk engine ran, so STEP_UP_REQUIRED was never reached on this run.',
      targetTransactionId: txId,
    };
  }
  if (authorize.body?.decision !== 'STEP_UP') {
    return {
      outcome: 'SIMULATED',
      summary: `The live risk decision was '${authorize.body?.decision ?? authorize.body?.failureCode ?? 'unknown'}', not STEP_UP, for this run — thresholds are policy-owned (backend/src/config/policy.ts) and can legitimately produce a different decision. Not a failure of the control; the brute-force path could not be exercised this time.`,
      targetTransactionId: txId,
    };
  }

  await ctx.log('PRISM', 'RISK', `Reached STEP_UP_REQUIRED — reasons: ${authorize.body.reasons.join('; ')}`, { score: authorize.body.score });
  const result = await bruteForce(ctx, txId, session.cookie);
  return { ...result, targetTransactionId: txId };
};
