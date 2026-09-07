/**
 * Dynamic QR Module — signed payment requests.
 *
 * A static QR is a bearer instrument printed on paper: whoever prints it
 * controls it, and a sticker over a shop's real code redirects the money.
 * PRISM demotes the QR from a source of truth to an authenticated pointer.
 *
 * ── The direction matters ─────────────────────────────────────────────────
 * The payee generates a request; the payer scans it. An earlier version had
 * the payer generating a QR for their own already-locked transaction, which
 * is backwards from the fraud being defended against — Asha scans the shop's
 * code, not her own — and it leaked: redeeming a token returned another
 * user's payee and amount to anyone signed in.
 *
 * ── What the token carries ────────────────────────────────────────────────
 * A signed reference and nothing else:  { v, req }
 *
 * No payee, no amount, no name. Those live in a server-side request record
 * and are read from `accounts` by id at scan time. So the claim in novelty N3
 * is literally true rather than nearly true: a forged token cannot lie about
 * who it points at, because it does not carry that information at all. It can
 * only point somewhere, and the server decides what "somewhere" means.
 *
 * Consequences, which are the whole QR-swap defence:
 *   - an unsigned printed sticker fails Ed25519 verification instantly
 *   - a screenshot expires within 60 seconds
 *   - a valid request for the attacker's own account still displays the
 *     attacker's real name from the database, so the payer sees who they
 *     are actually about to pay
 */
import crypto from 'crypto';
import redis from '../../utils/redis';
import { query } from '../../db/pool';
import { keyManager } from '../keys/keyManager';
import { policy, isDisabled } from '../../config/policy';
import { audit } from '../audit/logger';
import { fail } from '../../api/errors';
import { AccountRow } from '../../db/types';

const requestKey = (id: string) => `qrreq:${id}`;

/** Everything the QR image encodes. Deliberately two fields. */
export interface QrToken {
  v: number;
  req: string;
}

/** The server-side record the reference points at. Never leaves the server. */
interface QrRequest {
  payeeAccountId: string;
  amountMinor: number;
}

export interface ScannedRequest {
  payeeAccountId: string;
  payeeName: string;
  payeeHandle: string;
  amountMinor: number;
}

export class DynamicQrModule {
  /**
   * Payee side: mint a signed, single-use, short-lived payment request.
   * The amount is stored server-side and never encoded into the token.
   */
  async createRequest(
    payeeAccountId: string,
    amountMinor: number
  ): Promise<{ token: string; expiresInSeconds: number }> {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      fail('INVALID_AMOUNT', { reason: 'amount must be a positive integer in paise' });
    }

    const id = crypto.randomUUID();
    const record: QrRequest = { payeeAccountId, amountMinor };
    await redis.set(requestKey(id), JSON.stringify(record), 'EX', policy.qrTtlSeconds);

    const token = await keyManager.signQrToken(
      { v: 1, req: id } satisfies QrToken,
      policy.qrTtlSeconds
    );

    await audit.log('QR_ISSUED', { data: { requestId: id, payeeAccountId, amountMinor } });
    return { token, expiresInSeconds: policy.qrTtlSeconds };
  }

  /**
   * Payer side: verify the token and resolve what it points at.
   *
   * Returns the payee and amount read from the server's own records. The
   * caller then locks an intent from these values — never from anything the
   * scanned code claimed.
   */
  async scan(token: string): Promise<ScannedRequest> {
    const { req } = await this.verifyToken(token);

    // Single use, claimed atomically: GETSET returns the previous value and
    // installs CONSUMED in one round trip, so two simultaneous scans cannot
    // both see a live request.
    const previous = await redis.getset(requestKey(req), 'CONSUMED');
    await redis.expire(requestKey(req), policy.qrTtlSeconds);

    if (previous === null) fail('QR_EXPIRED', { reason: 'request unknown or expired' });
    if (previous === 'CONSUMED') fail('QR_ALREADY_USED', { reason: 'request already scanned' });

    const record = JSON.parse(previous) as QrRequest;

    // Authoritative details come from the database, by id. This is the line
    // that makes a swapped sticker harmless: it can point at the attacker,
    // but it cannot make the attacker look like the shop.
    const { rows } = await query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [
      record.payeeAccountId,
    ]);
    const payee = rows[0];
    if (!payee) fail('QR_INVALID_SIGNATURE', { reason: 'request points at no known account' });

    await audit.log('QR_REDEEMED', {
      data: { requestId: req, payeeAccountId: payee.id, amountMinor: record.amountMinor },
    });

    return {
      payeeAccountId: payee.id,
      payeeName: payee.display_name,
      payeeHandle: payee.handle,
      amountMinor: record.amountMinor,
    };
  }

  /** Signature and expiry, translated into the failure catalogue. */
  private async verifyToken(token: string): Promise<QrToken> {
    if (isDisabled('qrSignature')) {
      // Demo-only: decode without verifying, to show what an unsigned sticker
      // does to a system that trusts its QR codes. Refused in production.
      const body = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
      return body as QrToken;
    }

    let payload;
    try {
      payload = await keyManager.verifyQrToken(token);
    } catch (err) {
      // Classify on jose's error code, not its message. Message text is not
      // API and changes between versions; getting this wrong would report a
      // forged signature as a merely expired one.
      const code = (err as { code?: string }).code;
      const message = (err as Error).message;
      if (code === 'ERR_JWT_EXPIRED') fail('QR_EXPIRED', { reason: message });
      fail('QR_INVALID_SIGNATURE', { reason: message });
    }

    const { v, req } = payload as unknown as QrToken;
    if (v !== 1 || typeof req !== 'string' || !req) {
      fail('QR_INVALID_SIGNATURE', { reason: 'malformed payload' });
    }
    return { v, req };
  }
}

export const dynamicQr = new DynamicQrModule();
