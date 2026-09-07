/**
 * Dynamic QR Module — sign + verify.
 *
 * A static QR is a bearer instrument printed on paper: whoever prints it
 * controls it. PRISM demotes the QR from a source of truth to an authenticated
 * pointer. The token carries a transaction reference and nothing else — no
 * amount, no payee — so even a perfectly valid QR cannot lie about the money.
 * The client fetches the real details from the server using the reference.
 *
 * Consequences, which are the whole QR-swap defence:
 *   - an unsigned printed sticker fails signature verification instantly
 *   - a screenshot expires within 60 seconds
 *   - a valid QR for someone else's transaction still displays that
 *     transaction's real payee, so the user sees who they are actually paying
 */
import crypto from 'crypto';
import redis from '../../utils/redis';
import { keyManager } from '../keys/keyManager';
import { policy, isDisabled } from '../../config/policy';
import { audit } from '../audit/logger';
import { fail } from '../../api/errors';

const jtiKey = (jti: string) => `qr:${jti}`;

export interface QrPayload {
  /** Payload version, so the format can change without breaking verifiers. */
  v: number;
  /** Transaction reference — the only thing the QR actually carries. */
  tx: string;
  /** Intent hash, so a tampered pointer is detectable before any fetch. */
  ih: string;
  jti: string;
}

export class DynamicQrModule {
  async issue(txId: string, intentHash: string): Promise<{ token: string; expiresInSeconds: number }> {
    const jti = crypto.randomBytes(16).toString('base64url');
    const token = await keyManager.signQrToken(
      { v: 1, tx: txId, ih: intentHash, jti } satisfies QrPayload,
      policy.qrTtlSeconds
    );
    await redis.set(jtiKey(jti), 'ISSUED', 'EX', policy.qrTtlSeconds);
    await audit.log('QR_ISSUED', { transactionId: txId, data: { jti } });
    return { token, expiresInSeconds: policy.qrTtlSeconds };
  }

  /**
   * Verify a scanned token: real signature, not expired, not already used.
   * jose's errors are translated into the failure catalogue so the client and
   * the attack scripts see a documented code rather than a library message.
   */
  async redeem(token: string): Promise<QrPayload> {
    if (isDisabled('qrSignature')) {
      // Demo-only: decode without verifying, to show what an unsigned sticker
      // would do to a system that trusts its QR codes.
      const body = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
      return body as QrPayload;
    }

    let payload;
    try {
      payload = await keyManager.verifyQrToken(token);
    } catch (err) {
      const message = (err as Error).message;
      if (/exp|expired/i.test(message)) fail('QR_EXPIRED', { reason: message });
      fail('QR_INVALID_SIGNATURE', { reason: message });
    }

    const { v, tx, ih, jti } = payload as unknown as QrPayload;
    if (v !== 1 || !tx || !ih || !jti) fail('QR_INVALID_SIGNATURE', { reason: 'malformed payload' });

    // Single use, claimed atomically: GETSET returns the previous value and
    // installs CONSUMED in one round trip, so two simultaneous scans cannot
    // both see ISSUED.
    const previous = await redis.getset(jtiKey(jti), 'CONSUMED');
    await redis.expire(jtiKey(jti), policy.qrTtlSeconds);
    if (previous === null) fail('QR_EXPIRED', { reason: 'token unknown or expired' });
    if (previous === 'CONSUMED') fail('QR_ALREADY_USED', { reason: 'token already redeemed' });

    await audit.log('QR_REDEEMED', { transactionId: tx, data: { jti } });
    return { v, tx, ih, jti };
  }
}

export const dynamicQr = new DynamicQrModule();
