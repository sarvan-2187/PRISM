/**
 * QR Code Overlay (Sticker-Swap) Fraud.
 *
 * The real-world attack needs no cryptography at all: a fraudster prints a
 * sticker carrying THEIR OWN QR code and pastes it over a shop's real one. A
 * static QR just encodes an account number, so the swap is invisible — the
 * customer scans, sees an ordinary payment screen, and pays the fraudster.
 *
 * PRISM's QR carries a signed reference and nothing else (dynamicQr.ts), so
 * this scenario reproduces the swap three ways and checks each one against
 * the real API:
 *   1. the attacker's own, honestly-signed request — no forgery needed —
 *      displayed in place of the merchant's
 *   2. the same "sticker", photographed and scanned again
 *   3. a hand-crafted, unsigned code — the low-effort version of the sticker
 */
import crypto from 'crypto';
import { resolveSession, establishDeviceSession } from '../deviceSession';
import { post } from '../httpClient';
import { getAnotherUser } from '../demoData';
import { AttackFn, AttackResult } from '../types';
import { RunOutcome } from '../runStore';

const AMOUNT_MINOR = 49_900; // ₹499.00 — a plausible in-store amount

export const qrOverlaySwap: AttackFn = async (ctx, target) => {
  // The customer: the person who will scan the (swapped) code.
  const customer = await resolveSession(target.victimSessionCookie, target.payerUserId, target.payerEmail);
  await ctx.log(
    'LEGITIMATE',
    'QR',
    customer.selfEstablished
      ? `Customer device authenticated as ${target.payerEmail} itself (no captured session pasted) — a genuine login for the account`
      : `Customer device is using a real captured session cookie for ${target.payerEmail}`,
    {}
  );

  // The overlay attacker: a second, fully independent real PRISM account —
  // exactly what a fraudster running this scam actually has: their own
  // account, not the shop's or the customer's.
  const attackerUser = await getAnotherUser(target.payerUserId);
  if (!attackerUser) throw new Error('No second real account available to play the overlay attacker.');
  const attackerCookie =
    target.attackerSessionCookie ?? (await establishDeviceSession(attackerUser.id, attackerUser.email)).cookie;
  await ctx.log(
    'ATTACKER',
    'QR',
    `Overlay attacker is ${attackerUser.display_name} (${attackerUser.email}) — a separate, fully real PRISM account with its own valid login, not a forged identity`,
    {}
  );

  // 1. The sticker: a REAL, honestly-signed QR request for the attacker's
  // own account. This is the whole point of the scam — no signature to
  // forge, because the sticker was never claiming to be anyone else's.
  const minted = await post('/api/v1/qr/request', { amountMinor: AMOUNT_MINOR }, { cookie: attackerCookie });
  if (minted.status !== 201) {
    throw new Error(`attacker qr/request failed: ${minted.status} ${JSON.stringify(minted.body)}`);
  }
  await ctx.log(
    'ATTACKER',
    'QR',
    `Minted a real, validly-signed QR request for ₹${(AMOUNT_MINOR / 100).toLocaleString('en-IN')} — this is the "sticker": the attacker's own genuine code, exactly what gets pasted over a shop's real one`,
    { tokenPreview: `${String(minted.body.token).slice(0, 24)}…` }
  );

  // 2. The customer scans what they believe is the merchant's code.
  const scan1 = await post('/api/v1/qr/scan', { token: minted.body.token }, { cookie: customer.cookie });
  await ctx.log(
    'PRISM',
    'QR',
    `Customer scans the overlaid code — server response: ${scan1.status} ${scan1.body?.failureCode ?? 'resolved'}`.trim(),
    { response: scan1.body }
  );

  const nameMatchesAttacker = scan1.status === 201 && scan1.body?.payeeName === attackerUser.display_name;
  if (scan1.status === 201) {
    await ctx.log(
      'PRISM',
      'QR',
      nameMatchesAttacker
        ? `dynamicQr.scan() resolved the payee from the database by account id, never from anything the code visually claims — the review screen a real customer would see next reads "Pay to ${scan1.body.payeeName} (${scan1.body.payeeHandle})", exposing the overlay attacker's true identity before anything is approved. A real transaction was locked (${scan1.body.txId}) but not yet authorized — no money has moved.`
        : "Unexpected: the resolved payee does not match the attacker's own account.",
      {
        resolvedPayeeName: scan1.body?.payeeName,
        resolvedPayeeHandle: scan1.body?.payeeHandle,
        attackerRealName: attackerUser.display_name,
      }
    );
  }

  // 3. Replay: the exact same "photographed" sticker, scanned a second time.
  const scan2 = await post('/api/v1/qr/scan', { token: minted.body.token }, { cookie: customer.cookie });
  await ctx.log(
    'ATTACKER',
    'QR',
    `Same code scanned again (a photographed or reprinted sticker) — server response: ${scan2.status} ${scan2.body?.failureCode ?? 'resolved'}`.trim(),
    { response: scan2.body }
  );
  const replayBlocked = scan2.status === 409 && scan2.body?.failureCode === 'QR_ALREADY_USED';

  // 4. A hand-crafted, unsigned code — the low-effort version of the same sticker.
  const forgedToken = `forged.${crypto.randomBytes(12).toString('base64url')}.sticker`;
  const scan3 = await post('/api/v1/qr/scan', { token: forgedToken }, { cookie: customer.cookie });
  await ctx.log(
    'ATTACKER',
    'QR',
    `Hand-crafted, unsigned code scanned — server response: ${scan3.status} ${scan3.body?.failureCode ?? 'resolved'}`.trim(),
    { response: scan3.body }
  );
  const forgeryBlocked = scan3.status === 403 && scan3.body?.failureCode === 'QR_INVALID_SIGNATURE';

  await ctx.log(
    'SYSTEM',
    'QR',
    `Summary — identity exposed rather than spoofed: ${nameMatchesAttacker}. Replay blocked: ${replayBlocked}. Forged signature blocked: ${forgeryBlocked}.`,
    {}
  );

  // The load-bearing check is nameMatchesAttacker — the actual claim under
  // test ("a swap cannot hide who gets paid"). The other two are real,
  // independent defences worth reporting, but a failure there does not
  // reverse the core finding the way a failure to expose identity would.
  const outcome: RunOutcome = !nameMatchesAttacker
    ? 'SUCCEEDED'
    : replayBlocked && forgeryBlocked
      ? 'DETECTED'
      : 'PARTIALLY_MITIGATED';

  const result: AttackResult = {
    outcome,
    summary:
      outcome === 'DETECTED'
        ? `The overlay code resolved successfully — no signature to forge — but to the attacker's own real name (${scan1.body?.payeeName}), which is exactly what a customer's review screen would show before approving. A photographed replay of the same code was refused (QR_ALREADY_USED), and a hand-crafted unsigned code was refused before any database lookup (QR_INVALID_SIGNATURE).`
        : outcome === 'SUCCEEDED'
          ? `The overlay code resolved to a spoofed identity rather than the attacker's real one — the swap would have been invisible to the customer. This is a real finding, not a display error.`
          : `The overlay code correctly exposed the attacker's real identity (${scan1.body?.payeeName}), but a secondary defence did not hold — replay blocked: ${replayBlocked}, forged signature blocked: ${forgeryBlocked}. See the log for the exact response.`,
    targetTransactionId: scan1.status === 201 ? scan1.body?.txId : undefined,
  };
  return result;
};
