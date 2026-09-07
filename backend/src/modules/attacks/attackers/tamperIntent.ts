import { resolveSession } from '../deviceSession';
import { post } from '../httpClient';
import { getKnownPayee, getNeverPaidPayee, getTransaction } from '../demoData';
import { AttackFn } from '../types';

const AMOUNT_CHEAP = 500; // ₹5.00

export const tamperIntent: AttackFn = async (ctx, target) => {
  const session = await resolveSession(target.victimSessionCookie, target.payerUserId, target.payerEmail);
  await ctx.log(
    'ATTACKER',
    'IDENTITY',
    session.selfEstablished
      ? `Attacker device authenticated as ${target.payerEmail} itself (no captured session pasted) — this is a genuine additional login for the account, not a stolen-cookie demonstration`
      : `Attacker device is using a real captured session cookie for ${target.payerEmail}`,
    {}
  );

  // The decoy is always a fresh, cheap transaction under the same account —
  // this is inherent to the attack's mechanism (a captured hash from
  // elsewhere), not something that can be a pre-existing live transaction.
  const payee = (await getKnownPayee(target.payerUserId)) ?? (await getNeverPaidPayee(target.payerUserId));
  if (!payee) throw new Error('Target user has no payee available for the decoy transaction.');
  const cheap = await post('/api/v1/payment/initiate', { payeeAccountId: payee.id, amountMinor: AMOUNT_CHEAP }, { cookie: session.cookie });
  if (cheap.status !== 201) throw new Error(`decoy initiate failed: ${cheap.status} ${JSON.stringify(cheap.body)}`);
  await ctx.log('ATTACKER', 'INTENT', `Locked a decoy cheap transaction (${cheap.body.amountFormatted}) — hash ${cheap.body.intentHash.slice(0, 16)}...`, {
    txId: cheap.body.txId,
  });

  let targetTxId = target.transactionId;
  let targetAmountLabel = 'the target transaction';
  if (targetTxId) {
    const liveTx = await getTransaction(targetTxId);
    targetAmountLabel = `the live transaction (₹${(parseInt(liveTx.amount_minor, 10) / 100).toLocaleString('en-IN')})`;
    await ctx.log('ATTACKER', null, `Real live transaction selected as the attack target: ${targetTxId}`, { txId: targetTxId });
  } else {
    const AMOUNT_EXPENSIVE = 5_000_000; // ₹50,000.00 — self-contained fallback
    const expensive = await post('/api/v1/payment/initiate', { payeeAccountId: payee.id, amountMinor: AMOUNT_EXPENSIVE }, { cookie: session.cookie });
    if (expensive.status !== 201) throw new Error(`fallback target initiate failed: ${expensive.status}`);
    targetTxId = expensive.body.txId;
    targetAmountLabel = `the freshly-created fallback transaction (${expensive.body.amountFormatted})`;
    await ctx.log('ATTACKER', 'INTENT', `No live transaction was selected — created a fallback target transaction instead (not a live-transaction demonstration)`, { txId: targetTxId });
  }

  await ctx.log(
    'ATTACKER',
    null,
    `Request generated: authorize ${targetAmountLabel} while claiming it should verify against the decoy transaction's hash`,
    { targetTxId, claimedHash: cheap.body.intentHash }
  );

  const attack = await post(`/api/v1/payment/${targetTxId}/authorize`, { intentHash: cheap.body.intentHash }, { cookie: session.cookie });

  await ctx.log('PRISM', 'INTENT', `Server response: ${attack.status} ${attack.body?.failureCode ?? attack.body?.decision ?? ''}`.trim(), {
    response: attack.body,
  });

  if (attack.status === 403 && attack.body?.failureCode === 'TAMPER_BLOCKED') {
    await ctx.log(
      'PRISM',
      'INTENT',
      'intentLock.verifyHash recomputed the hash from the locked DB record; the claimed hash did not match — request rejected before any signature was even checked',
      {}
    );
    return {
      outcome: 'BLOCKED',
      summary: `${targetAmountLabel[0].toUpperCase()}${targetAmountLabel.slice(1)} was rejected (TAMPER_BLOCKED) — the server trusts only its own recomputed intent hash, never a client-supplied one.`,
      targetTransactionId: targetTxId,
    };
  }

  if (attack.status === 409 && attack.body?.failureCode === 'REPLAY_BLOCKED') {
    return {
      outcome: 'BLOCKED',
      summary: 'The selected live transaction had already settled, so this attempt was rejected as a replay (REPLAY_BLOCKED) before the tamper check ran — still a real, correct refusal, just via a different check.',
      targetTransactionId: targetTxId,
    };
  }

  if (attack.status === 200 || attack.status === 202) {
    return {
      outcome: 'SUCCEEDED',
      summary: `${targetAmountLabel[0].toUpperCase()}${targetAmountLabel.slice(1)} was accepted using a hash captured from a different, cheaper transaction. The server trusted a client-supplied intent hash.`,
      targetTransactionId: targetTxId,
    };
  }

  return {
    outcome: 'SIMULATED',
    summary: `Unexpected response (${attack.status} ${JSON.stringify(attack.body)}) — could not classify a clear block or success.`,
    targetTransactionId: targetTxId,
  };
};
