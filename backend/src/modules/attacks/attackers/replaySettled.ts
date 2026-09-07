import { resolveSession } from '../deviceSession';
import { post } from '../httpClient';
import { getKnownPayee, getTransaction } from '../demoData';
import { runLegitPayment } from '../legitPayment';
import { AttackFn } from '../types';

const AMOUNT = 20_000; // ₹200 — modest, near the seeded baseline so it settles cleanly

export const replaySettled: AttackFn = async (ctx, target) => {
  // Primary path: a real, already-settled LIVE transaction was selected. A
  // genuine byte-for-byte replay would need the original signed assertion,
  // which only the device that produced it ever holds — but the nonce/ledger
  // guard does not need that: it rejects ANY re-authorize attempt on an
  // already-consumed transaction before a signature is even checked (step 3
  // of routes.ts runs before step 5). So an attacker holding only a captured
  // session cookie — no private key — can still be meaningfully demonstrated
  // against a real live settled transaction.
  if (target.transactionId) {
    const liveTx = await getTransaction(target.transactionId);
    if (liveTx.status === 'SETTLED') {
      const session = await resolveSession(target.victimSessionCookie, target.payerUserId, target.payerEmail);
      await ctx.log(
        'ATTACKER',
        'IDENTITY',
        session.selfEstablished
          ? `Attacker device authenticated as ${target.payerEmail} itself (no captured session pasted)`
          : `Attacker device is using a real captured session cookie for ${target.payerEmail}`,
        {}
      );
      await ctx.log('ATTACKER', null, `Attacker resubmits an authorize request against the already-settled live transaction ${liveTx.id}`, {
        txId: liveTx.id,
      });
      const replay = await post(`/api/v1/payment/${liveTx.id}/authorize`, {}, { cookie: session.cookie });
      await ctx.log('PRISM', 'LEDGER', `Server response: ${replay.status} ${replay.body?.failureCode ?? ''}`.trim(), { response: replay.body });

      if (replay.status === 409 && replay.body?.failureCode === 'REPLAY_BLOCKED') {
        await ctx.log('PRISM', 'LEDGER', 'The nonce for this transaction is already CONSUMED — no signature was even required to reach this refusal', {});
        return {
          outcome: 'BLOCKED',
          summary: `A resubmitted authorize request against the already-settled live transaction was rejected (REPLAY_BLOCKED).`,
          targetTransactionId: liveTx.id,
        };
      }
      if (replay.status === 200) {
        return { outcome: 'SUCCEEDED', summary: 'The resubmitted request was accepted against an already-settled transaction.', targetTransactionId: liveTx.id };
      }
      return {
        outcome: 'SIMULATED',
        summary: `Unexpected response (${replay.status} ${JSON.stringify(replay.body)}) resubmitting against the settled live transaction.`,
        targetTransactionId: liveTx.id,
      };
    }
    await ctx.log(
      'SYSTEM',
      null,
      `Selected live transaction ${liveTx.id} is not yet settled (status: ${liveTx.status}) — a replay needs a completed payment, so this run creates and settles its own instead`,
      {}
    );
  }

  // Fallback: no settled live transaction was available, so the engine
  // completes one real payment itself (this requires signing, so it always
  // self-establishes its own credential regardless of any pasted cookie) and
  // replays the exact request it just sent.
  const payee = await getKnownPayee(target.payerUserId);
  if (!payee) {
    throw new Error('Target user has no known/previously-paid payee — needed so this run reaches SETTLED, not STEP_UP.');
  }

  const { txId, session, authorize, authorizeRequestBody } = await runLegitPayment(ctx, {
    userId: target.payerUserId,
    email: target.payerEmail,
    payeeAccountId: payee.id,
    amountMinor: AMOUNT,
    deliberationMs: 3000,
  });

  if (authorize.body?.decision !== 'APPROVED') {
    return {
      outcome: 'SIMULATED',
      summary: `The setup payment did not reach SETTLED on this run (decision: ${authorize.body?.decision ?? authorize.body?.failureCode}) — the replay attempt needs a real settled transaction to be meaningful, so this run stopped here honestly rather than forcing a result.`,
      targetTransactionId: txId,
    };
  }

  await ctx.log('ATTACKER', null, 'Attacker device replays the exact same, already-used authorize request byte-for-byte', { txId });

  const replay = await post(`/api/v1/payment/${txId}/authorize`, authorizeRequestBody, { cookie: session.cookie });

  await ctx.log('PRISM', 'LEDGER', `Server response to replay: ${replay.status} ${replay.body?.failureCode ?? ''}`.trim(), {
    response: replay.body,
  });

  if (replay.status === 409 && replay.body?.failureCode === 'REPLAY_BLOCKED') {
    await ctx.log(
      'PRISM',
      'LEDGER',
      'Nonce state was already CONSUMED and the ledger enforces UNIQUE(transaction_id, direction) — a second settlement is structurally impossible, not just refused by one check',
      {}
    );
    return {
      outcome: 'BLOCKED',
      summary: 'No live settled transaction was available, so this run settled its own payment first, then replayed it — the replay was rejected (REPLAY_BLOCKED). The original payment settled exactly once.',
      targetTransactionId: txId,
    };
  }

  if (replay.status === 200) {
    return {
      outcome: 'SUCCEEDED',
      summary: 'The replayed request was accepted a second time — the payment may have settled twice.',
      targetTransactionId: txId,
    };
  }

  return {
    outcome: 'SIMULATED',
    summary: `Unexpected replay response (${replay.status} ${JSON.stringify(replay.body)}).`,
    targetTransactionId: txId,
  };
};
