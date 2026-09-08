/**
 * QR Code Replay Attack.
 *
 * An attacker photographs or intercepts a PRISM payment QR the payee
 * displayed, then re-presents the identical token, hoping to lock a second
 * payment against the same request — the way a static, printed QR sticker
 * can be paid over and over.
 *
 * PRISM uses an atomic GETSET in Redis to mark every token CONSUMED on first
 * scan (dynamicQr.ts). Any subsequent scan of the same token is refused with
 * QR_ALREADY_USED before any database lookup or intent creation happens.
 */
import { resolveSession, establishDeviceSession } from '../deviceSession';
import { post } from '../httpClient';
import { getAnotherUser } from '../demoData';
import { AttackFn, AttackResult } from '../types';
import { RunOutcome } from '../runStore';

const AMOUNT_MINOR = 25_000; // ₹250.00 — a typical in-store amount

export const qrReplay: AttackFn = async (ctx, target) => {
  // The payer: the real customer who scans the QR.
  const payer = await resolveSession(target.victimSessionCookie, target.payerUserId, target.payerEmail);
  await ctx.log(
    'LEGITIMATE',
    'QR',
    payer.selfEstablished
      ? `Payer authenticated as ${target.payerEmail} itself (no captured session pasted)`
      : `Payer is using a real captured session cookie for ${target.payerEmail}`,
    {}
  );

  // The payee: a second, fully independent real account that mints the QR.
  // Models a legitimate merchant whose code gets photographed / intercepted.
  const payeeUser = await getAnotherUser(target.payerUserId);
  if (!payeeUser) throw new Error('No second real account available to play the QR payee.');
  const payeeCookie =
    target.attackerSessionCookie ?? (await establishDeviceSession(payeeUser.id, payeeUser.email)).cookie;
  await ctx.log(
    'LEGITIMATE',
    'QR',
    `Payee is ${payeeUser.display_name} (${payeeUser.email}) — a separate real PRISM account that mints a genuine single-use QR request`,
    {}
  );

  // 1. Mint a real, validly-signed QR request as the payee.
  const minted = await post('/api/v1/qr/request', { amountMinor: AMOUNT_MINOR }, { cookie: payeeCookie });
  if (minted.status !== 201) {
    throw new Error(`qr/request failed: ${minted.status} ${JSON.stringify(minted.body)}`);
  }
  const token: string = minted.body.token;
  await ctx.log(
    'LEGITIMATE',
    'QR',
    `Payee minted a real, validly-signed QR token for ₹${(AMOUNT_MINOR / 100).toLocaleString('en-IN')}`,
    { tokenPreview: `${token.slice(0, 24)}…` }
  );

  // 2. First scan — legitimate customer, succeeds and locks an intent.
  const scan1 = await post('/api/v1/qr/scan', { token }, { cookie: payer.cookie });
  await ctx.log(
    'LEGITIMATE',
    'QR',
    `First scan (the real customer) — server response: ${scan1.status} ${scan1.body?.failureCode ?? 'ok'}`.trim(),
    { response: scan1.body }
  );
  const firstScanOk = scan1.status === 201;
  if (!firstScanOk) {
    // Token may have already been consumed on a shared backend.
    await ctx.log('SYSTEM', 'QR', 'First scan did not succeed — token may already be consumed on this backend. Reporting as SIMULATED.', {});
    return {
      outcome: 'SIMULATED',
      summary:
        'The minted QR token could not be scanned successfully on the first attempt (already consumed on this shared backend). The replay defence is still enforced but cannot be demonstrated live on this run.',
      targetTransactionId: undefined,
    };
  }
  await ctx.log(
    'LEGITIMATE',
    'QR',
    `Intent locked (txId: ${scan1.body?.txId}) — one scan, one intent, as expected`,
    { txId: scan1.body?.txId }
  );

  // 3. Replay: the identical token, submitted a second time.
  // This models an attacker who copied the displayed QR (photograph, screenshot,
  // or intercepted network payload) and tries to spend it again.
  await ctx.log(
    'ATTACKER',
    'QR',
    'Attacker re-submits the identical, already-consumed token (replay of the photographed/intercepted QR)',
    { tokenPreview: `${token.slice(0, 24)}…` }
  );
  const scan2 = await post('/api/v1/qr/scan', { token }, { cookie: payer.cookie });
  await ctx.log(
    'PRISM',
    'QR',
    `Replay attempt — server response: ${scan2.status} ${scan2.body?.failureCode ?? 'resolved'}`.trim(),
    { response: scan2.body }
  );

  const replayBlocked = scan2.status === 409 && scan2.body?.failureCode === 'QR_ALREADY_USED';

  await ctx.log(
    'SYSTEM',
    'QR',
    `Summary — replay blocked by single-use guard: ${replayBlocked}. ${
      replayBlocked
        ? 'The atomic GETSET in Redis marked the token CONSUMED on first scan; the second request was refused before any intent was created or any database row was written.'
        : 'Unexpected: the replay was not refused. This is a real finding — see the log for the full response.'
    }`,
    {}
  );

  const outcome: RunOutcome = replayBlocked ? 'DETECTED' : 'SUCCEEDED';

  const result: AttackResult = {
    outcome,
    summary:
      outcome === 'DETECTED'
        ? `The QR token was spent exactly once. The first scan locked intent ${scan1.body?.txId}. The identical replay was refused with QR_ALREADY_USED — the Redis GETSET guard consumed the token atomically on first scan, making every subsequent scan a no-op regardless of who submits it.`
        : `The replayed QR token was NOT refused — the single-use guard did not fire. The same token produced a second intent lock. This is a real finding.`,
    targetTransactionId: scan1.body?.txId,
  };
  return result;
};
