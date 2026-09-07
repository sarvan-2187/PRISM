import { establishDeviceSession } from '../deviceSession';
import { get, post } from '../httpClient';
import { getAnotherUser, getMostRecentSettledTransaction, getTransaction } from '../demoData';
import { AttackFn } from '../types';

export const idorCrossUser: AttackFn = async (ctx, target) => {
  let victimTxId = target.transactionId;
  if (victimTxId) {
    await ctx.log('LEGITIMATE', null, `Real live transaction selected as the IDOR target: ${victimTxId}`, { txId: victimTxId });
  } else {
    const fallback = await getMostRecentSettledTransaction(target.payerUserId);
    if (!fallback) throw new Error('No live transaction selected and the target user has no settled transaction to fall back to.');
    victimTxId = fallback.id;
    await ctx.log('SYSTEM', null, `No live transaction selected — falling back to the target user's most recent settled transaction (not a live-transaction demonstration)`, { txId: victimTxId });
  }
  await getTransaction(victimTxId); // confirms it's a real row before proceeding

  let attackerCookie = target.attackerSessionCookie;
  if (attackerCookie) {
    await ctx.log('ATTACKER', 'IDENTITY', 'Attacker device is using a real captured session for a separate account it controls', {});
  } else {
    const attackerUser = await getAnotherUser(target.payerUserId);
    if (!attackerUser) throw new Error('Need a second real user in the database to act as the attacker device — seed data provides this.');
    const attackerSession = await establishDeviceSession(attackerUser.id, attackerUser.email);
    attackerCookie = attackerSession.cookie;
    await ctx.log(
      'ATTACKER',
      'IDENTITY',
      `No captured attacker session pasted — logged in as a separate real account (${attackerUser.email}) on the same local network as the victim's devices`,
      {}
    );
  }

  let allBlocked = true;
  const attempts: Array<{ label: string; status: number; failureCode?: string }> = [];

  const r1 = await get(`/api/v1/payment/${victimTxId}`, { cookie: attackerCookie });
  attempts.push({ label: 'GET /payment/:id', status: r1.status, failureCode: r1.body?.failureCode });
  await ctx.log('ATTACKER', null, `Attacker requests GET /payment/${victimTxId} using only their own session`, { response: r1.body, status: r1.status });
  if (!(r1.status === 404 && r1.body?.failureCode === 'NOT_FOUND')) allBlocked = false;

  const r2 = await get(`/api/v1/transactions/${victimTxId}/timeline`, { cookie: attackerCookie });
  attempts.push({ label: 'GET /transactions/:id/timeline', status: r2.status, failureCode: r2.body?.failureCode });
  await ctx.log('ATTACKER', null, "Attacker requests the target transaction's audit timeline", { response: r2.body, status: r2.status });
  if (!(r2.status === 404 && r2.body?.failureCode === 'NOT_FOUND')) allBlocked = false;

  const r3 = await post(`/api/v1/payment/${victimTxId}/authorize`, {}, { cookie: attackerCookie });
  attempts.push({ label: 'POST /payment/:id/authorize', status: r3.status, failureCode: r3.body?.failureCode });
  await ctx.log('ATTACKER', null, "Attacker attempts to authorize the target transaction using their own session", { response: r3.body, status: r3.status });
  if (!(r3.status === 404 && r3.body?.failureCode === 'NOT_FOUND')) allBlocked = false;

  for (const a of attempts) {
    await ctx.log('PRISM', 'AUTHORIZATION', `${a.label} -> ${a.status} ${a.failureCode ?? ''}`.trim(), {});
  }

  await ctx.log(
    'SYSTEM',
    'NETWORK',
    "Note: PRISM's network micro-fingerprint check treats same-subnet devices as unchanged by design (see backend/src/modules/context/network.ts networkChanged) — it did NOT contribute to this block. Detection here came entirely from the ownership/authorization check on each route.",
    {}
  );

  if (allBlocked) {
    return {
      outcome: 'BLOCKED',
      summary: `All ${attempts.length} cross-user attempts against the real target transaction returned NOT_FOUND. Every query is scoped to the caller's own session (req.userId), so a same-network attacker with a valid login of their own cannot reach another account's data by id alone.`,
      targetTransactionId: victimTxId,
    };
  }

  return {
    outcome: 'SUCCEEDED',
    summary: 'At least one cross-user access attempt succeeded — see the event log for which one.',
    targetTransactionId: victimTxId,
  };
};
