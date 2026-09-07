import { resolveSession } from '../deviceSession';
import { createSoftCredential } from '../../identity/softAuthenticator';
import { post } from '../httpClient';
import { getActiveCredentialId, getKnownPayee, getNeverPaidPayee } from '../demoData';
import { AttackFn } from '../types';

const AMOUNT = 15_000; // ₹150

export const forgedWebauthnAssertion: AttackFn = async (ctx, target) => {
  const session = await resolveSession(target.victimSessionCookie, target.payerUserId, target.payerEmail);
  await ctx.log(
    'LEGITIMATE',
    'IDENTITY',
    session.selfEstablished
      ? `Victim device authenticated as ${target.payerEmail} with a fresh real passkey (no captured session pasted)`
      : `Attacker device is using a real captured session cookie for ${target.payerEmail} — but not their passkey's private key`,
    {}
  );

  const realCredentialId = await getActiveCredentialId(target.payerUserId);
  if (!realCredentialId) throw new Error('Target user has no active registered credential to attack.');

  // ── Sub-attack A: forged signature claiming the victim's real credential id ──
  let txA = target.transactionId;
  if (txA) {
    await ctx.log('ATTACKER', null, `Real live transaction selected as the attack target: ${txA}`, { txId: txA });
  } else {
    const payee = (await getKnownPayee(target.payerUserId)) ?? (await getNeverPaidPayee(target.payerUserId));
    if (!payee) throw new Error('Target user has no payee available.');
    const lockedA = await post('/api/v1/payment/initiate', { payeeAccountId: payee.id, amountMinor: AMOUNT }, { cookie: session.cookie });
    if (lockedA.status !== 201) throw new Error(`initiate failed: ${lockedA.status}`);
    txA = lockedA.body.txId as string;
    await ctx.log('SYSTEM', null, 'No live transaction was selected — created a fallback transaction instead (not a live-transaction demonstration)', { txId: txA });
  }

  const challengeA = await post(`/api/v1/payment/${txA}/challenge`, {}, { cookie: session.cookie });
  if (challengeA.status !== 200) throw new Error(`challenge failed: ${challengeA.status} ${JSON.stringify(challengeA.body)}`);

  const attackerKey = createSoftCredential(target.payerUserId);
  const forged = attackerKey.sign(challengeA.body.challenge);
  // Id-substitution: claim the victim's real credential id while signing with a different key.
  forged.id = realCredentialId;
  forged.rawId = realCredentialId;
  await ctx.log('ATTACKER', null, "Attacker signs the assertion challenge with their OWN key, but labels it with the victim's real credential id", { txId: txA, claimedCredentialId: realCredentialId });

  const attackA = await post(`/api/v1/payment/${txA}/authorize`, { assertion: forged }, { cookie: session.cookie });
  await ctx.log('PRISM', 'IDENTITY', `Server response: ${attackA.status} ${attackA.body?.failureCode ?? ''}`.trim(), { response: attackA.body });

  const aBlocked = attackA.status === 403 && attackA.body?.failureCode === 'SIG_INVALID';
  if (aBlocked) {
    await ctx.log('PRISM', 'IDENTITY', 'verifyAuthenticationResponse checked the signature against the stored public key for that credential id — a different private key cannot produce a valid signature over it', {});
  }

  // ── Sub-attack B: the device keeps trying after the credential is revoked ──
  // Requires the engine's own credential (private key) to prove the "before"
  // state — impossible to demonstrate from a captured cookie alone, since
  // that never carries the private key. Honestly skipped when the session
  // came from a pasted cookie rather than a self-established login.
  if (!session.credential) {
    return {
      outcome: aBlocked ? 'BLOCKED' : 'SUCCEEDED',
      summary: aBlocked
        ? `The forged assertion failed cryptographic verification (SIG_INVALID). The second sub-attack (revoked-credential reuse) needs the engine to hold the victim's private key to demonstrate the "before" state, which a captured session cookie never provides — skipped honestly rather than faked.`
        : 'The forged assertion was not rejected.',
      targetTransactionId: txA,
    };
  }

  const revoke = await post(`/api/v1/credentials/${session.credential.credentialId}/revoke`, {}, { cookie: session.cookie });
  await ctx.log('LEGITIMATE', 'IDENTITY', 'Victim reports the device stolen — credential revoked via the real stolen-device response', { status: revoke.status });

  const payee2 = (await getKnownPayee(target.payerUserId)) ?? (await getNeverPaidPayee(target.payerUserId));
  const lockedB = payee2
    ? await post('/api/v1/payment/initiate', { payeeAccountId: payee2.id, amountMinor: AMOUNT }, { cookie: session.cookie })
    : null;
  const txB = lockedB?.body?.txId as string | undefined;
  const challengeB = txB ? await post(`/api/v1/payment/${txB}/challenge`, {}, { cookie: session.cookie }) : null;
  const legitAssertion = challengeB?.body?.challenge ? session.credential.sign(challengeB.body.challenge) : null;
  const attackB = legitAssertion
    ? await post(`/api/v1/payment/${txB}/authorize`, { assertion: legitAssertion }, { cookie: session.cookie })
    : { status: 0, body: {} };
  await ctx.log('ATTACKER', 'IDENTITY', 'The same physical device tries once more with its now-revoked real key', { txId: txB });
  await ctx.log('PRISM', 'IDENTITY', `Server response: ${attackB.status} ${(attackB.body as { failureCode?: string })?.failureCode ?? ''}`.trim(), { response: attackB.body });

  const bBlocked = attackB.status === 401 && (attackB.body as { failureCode?: string })?.failureCode === 'AUTH_FAILED';

  if (aBlocked && bBlocked) {
    return {
      outcome: 'BLOCKED',
      summary: 'The forged assertion failed cryptographic verification (SIG_INVALID), and the revoked credential was refused (AUTH_FAILED) on its very next use — both real WebAuthn checks held.',
      targetTransactionId: txA,
    };
  }
  if (aBlocked !== bBlocked) {
    return {
      outcome: 'PARTIALLY_MITIGATED',
      summary: `One of the two sub-attacks was blocked and the other was not (forged-signature blocked: ${aBlocked}, revoked-credential blocked: ${bBlocked}).`,
      targetTransactionId: txA,
    };
  }
  return {
    outcome: 'SUCCEEDED',
    summary: 'Neither the forged signature nor the revoked credential was rejected.',
    targetTransactionId: txA,
  };
};
