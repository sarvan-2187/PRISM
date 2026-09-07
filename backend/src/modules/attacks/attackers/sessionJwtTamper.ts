import { resolveSession } from '../deviceSession';
import { get } from '../httpClient';
import { getAnotherUser } from '../demoData';
import { AttackFn } from '../types';

function decodeJwt(token: string) {
  const [h, payload, sig] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
    sig,
  };
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export const sessionJwtTamper: AttackFn = async (ctx, target) => {
  const session = await resolveSession(target.victimSessionCookie, target.payerUserId, target.payerEmail);
  await ctx.log(
    'LEGITIMATE',
    'IDENTITY',
    session.selfEstablished
      ? `Victim device authenticated as ${target.payerEmail} itself (no captured session pasted)`
      : `Attacker device is using a real captured session cookie for ${target.payerEmail} as raw material to forge from`,
    {}
  );
  if (target.transactionId) {
    await ctx.log('SYSTEM', null, `This attack targets the session layer, not a specific transaction — real live transaction ${target.transactionId} is the context for this run`, {
      txId: target.transactionId,
    });
  }

  const otherUser = await getAnotherUser(target.payerUserId);

  const realToken = session.cookie.split('=')[1];
  const { header, payload, sig } = decodeJwt(realToken);
  await ctx.log('LEGITIMATE', 'IDENTITY', `Decoded a real, genuinely-issued session token (sub=${payload.sub})`, { header });

  let allBlocked = true;

  // (a) alg:none
  const noneToken = `${b64url({ ...header, alg: 'none' })}.${b64url(payload)}.`;
  await ctx.log('ATTACKER', null, 'Attacker forges an alg:none token — same claims, no signature', {});
  const attackA = await get('/api/v1/me', { cookie: `prism_session=${noneToken}` });
  await ctx.log('PRISM', 'IDENTITY', `Server response: ${attackA.status} ${attackA.body?.failureCode ?? ''}`.trim(), { response: attackA.body });
  if (!(attackA.status === 401 && attackA.body?.failureCode === 'AUTH_FAILED')) allBlocked = false;

  // (b) payload tamper, original signature kept
  let attackB: Awaited<ReturnType<typeof get>> | null = null;
  if (otherUser) {
    const tamperedToken = `${b64url(header)}.${b64url({ ...payload, sub: otherUser.id })}.${sig}`;
    await ctx.log('ATTACKER', null, `Attacker swaps sub -> ${otherUser.id} while keeping the original (now-invalid) signature`, {});
    attackB = await get('/api/v1/me', { cookie: `prism_session=${tamperedToken}` });
    await ctx.log('PRISM', 'IDENTITY', `Server response: ${attackB.status} ${attackB.body?.failureCode ?? ''}`.trim(), { response: attackB.body });
    if (!(attackB.status === 401 && attackB.body?.failureCode === 'AUTH_FAILED')) allBlocked = false;
  }

  const control = await get('/api/v1/me', { cookie: session.cookie });
  await ctx.log('SYSTEM', null, `Control check: the genuine, unmodified cookie still authenticates -> ${control.status}`, {});

  if (allBlocked && control.status === 200) {
    await ctx.log('PRISM', 'IDENTITY', 'verifySession enforces an explicit HS256-only algorithm allowlist, so alg:none and a stale signature are both rejected before req.userId is ever set', {});
    return {
      outcome: 'BLOCKED',
      summary: 'Both forged session tokens were rejected with AUTH_FAILED, and the genuine cookie continued to work normally.',
      targetTransactionId: target.transactionId,
    };
  }
  if (!allBlocked) {
    return { outcome: 'SUCCEEDED', summary: 'At least one forged session token was accepted.', targetTransactionId: target.transactionId };
  }
  return {
    outcome: 'SIMULATED',
    summary: 'The genuine cookie stopped working during this run — investigate before trusting a BLOCKED verdict.',
    targetTransactionId: target.transactionId,
  };
};
