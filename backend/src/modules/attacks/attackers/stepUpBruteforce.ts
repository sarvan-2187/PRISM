import { resolveSession } from '../deviceSession';
import { post, get } from '../httpClient';
import { getNeverPaidPayee, getTransaction } from '../demoData';
import { runLegitPayment } from '../legitPayment';
import { AttackContext, AttackFn } from '../types';

const AMOUNT = 4_800_000; // ₹48,000 — designed to trip NO_BASELINE + NEW_PAYEE into STEP_UP

/**
 * The real correct answer is the last two digits of the RUPEE amount (see
 * backend/src/modules/semantic/intentCheck.ts issue()): for ₹48,000 that is
 * "00". Guesses here are deliberately built to exclude the real answer, so
 * this brute-force run tests the attempt cap honestly rather than
 * accidentally guessing right on the first try.
 */
const CORRECT_ANSWER = String(Math.floor(AMOUNT / 100) % 100).padStart(2, '0');
const WRONG_ANSWERS = ['13', '47', '58', '91'].filter((a) => a !== CORRECT_ANSWER);

async function bruteForce(ctx: AttackContext, txId: string, cookie: string) {
  await ctx.log('ATTACKER', 'SEMANTIC', `Attacker brute-forces the last-two-digits challenge (cap is ${WRONG_ANSWERS.length - 1} allowed wrong tries)`, {});
  const results: Array<{ answer: string; status: number; body: unknown }> = [];
  for (const answer of WRONG_ANSWERS) {
    const res = await post(`/api/v1/payment/${txId}/step-up`, { answer }, { cookie });
    results.push({ answer, status: res.status, body: res.body });
    await ctx.log('PRISM', 'SEMANTIC', `Guess "${answer}" -> ${res.status} ${(res.body as { failureCode?: string })?.failureCode ?? ''}`.trim(), {
      response: res.body,
    });
  }
  const exhausted = results.some((r) => (r.body as { attemptsRemaining?: number })?.attemptsRemaining === 0);
  const anySucceeded = results.some((r) => r.status === 200);
  const tx = await get(`/api/v1/payment/${txId}`, { cookie });
  await ctx.log('SYSTEM', null, `Final transaction status: ${tx.body?.status}`, {});

  if (anySucceeded) {
    return { outcome: 'SUCCEEDED' as const, summary: 'A brute-forced guess against the two-digit challenge succeeded.' };
  }
  if (exhausted && results.every((r) => r.status === 403 && (r.body as { failureCode?: string })?.failureCode === 'STEP_UP_FAILED')) {
    return {
      outcome: 'BLOCKED' as const,
      summary: `All ${WRONG_ANSWERS.length} wrong guesses were refused and the transaction was blocked terminally once the ${WRONG_ANSWERS.length - 1}-attempt cap was reached.`,
    };
  }
  return { outcome: 'SIMULATED' as const, summary: 'Unexpected sequence of guess responses — see the event log.' };
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
      await ctx.log('SYSTEM', null, `Real live transaction already at STEP_UP_REQUIRED — brute-forcing it directly: ${liveTx.id}`, { txId: liveTx.id });
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
