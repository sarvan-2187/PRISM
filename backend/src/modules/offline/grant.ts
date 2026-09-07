/**
 * Offline Authorization Grant — BLACKOUT (FC-01-A).
 *
 * The device goes fully offline mid-payment: no network, no server, no live
 * check against anything. Every PRISM control today is server-mediated, so
 * this module's job is to pre-position the server's authority on the device
 * BEFORE the blackout, as something the device can spend without asking.
 *
 * A grant is not a blank cheque. It is capped, payee-restricted, and carries
 * a small fixed number of single-use slots — every field MAC'd, so the
 * device cannot widen any of them without breaking a key it does not hold.
 * Blast radius of a fully compromised offline device is therefore bounded
 * and statable up front: slots * maxAmountMinor, to already-known payees
 * only, inside one window. See config/policy.ts `offline` for the numbers.
 *
 * Deliberately NOT a copy of the risk engine running on the client: a
 * client-side risk verdict is worth nothing on a device an attacker may be
 * holding. Instead this module computes the envelope once, while online and
 * trustworthy, and seals it — offline/redeem.ts re-runs the real risk engine
 * and policy firewall live, when the payment actually settles.
 */
import crypto from 'crypto';
import { query } from '../../db/pool';
import { keyManager } from '../keys/keyManager';
import { canonicalJson } from '../../utils/attestationCanonical';
import { identity } from '../identity/webauthn';
import { generateNonce } from '../../utils/crypto';
import { policy } from '../../config/policy';
import { fail } from '../../api/errors';
import { audit } from '../audit/logger';

export interface AllowedPayee {
  accountId: string;
  displayName: string;
  handle: string;
}

export interface OfflineSlot {
  txId: string;
  nonce: string;
}

export interface GrantBody {
  typ: 'prism.offline.grant.v1';
  grantId: string;
  payerUserId: string;
  payerAccountId: string;
  /** Non-duress credentials only — see issue(). Device binding: a signature from any other credential is refused at redemption. */
  credentialIds: string[];
  currency: string;
  maxAmountMinor: number;
  allowedPayees: AllowedPayee[];
  slots: OfflineSlot[];
  issuedAt: number;
  notAfter: number;
}

export interface SignedGrant {
  grant: GrantBody;
  token: string;
}

export class OfflineGrantModule {
  /**
   * Arm the device. Called while online, typically right after sign-in — the
   * one moment PRISM can still ask the server anything.
   *
   * Payees are restricted to accounts the payer has already settled with:
   * this deletes the entire NEW_PAYEE attack class from the offline surface
   * without needing a client-side copy of the risk engine to reason about it.
   *
   * Duress credentials are excluded from credentialIds on purpose. Offline
   * redemption re-runs risk and policy live but has no interactive step-up
   * round trip, so there is nowhere for a DURESS_HOLD outcome to go — the
   * simplest correct answer is that a duress passkey cannot arm or spend an
   * offline grant at all.
   */
  async issue(userId: string, payerAccountId: string): Promise<SignedGrant> {
    const creds = (await identity.credentialsFor(userId)).filter((c) => !c.is_duress);
    if (creds.length === 0) {
      fail('AUTH_FAILED', { reason: 'no passkey registered — cannot arm offline mode' });
    }

    const { rows: payeeRows } = await query<{ id: string; display_name: string; handle: string }>(
      `SELECT a.id, a.display_name, a.handle
         FROM accounts a
        WHERE a.user_id IS DISTINCT FROM $1
          AND EXISTS (
            SELECT 1 FROM transactions t
             WHERE t.payer_user_id = $1 AND t.payee_account_id = a.id AND t.status = 'SETTLED'
          )
        ORDER BY a.display_name`,
      [userId]
    );

    const issuedAt = Math.floor(Date.now() / 1000);
    const notAfter = issuedAt + policy.offline.windowSeconds;
    const slots: OfflineSlot[] = Array.from({ length: policy.offline.slots }, () => ({
      txId: crypto.randomUUID(),
      nonce: generateNonce(),
    }));

    const grant: GrantBody = {
      typ: 'prism.offline.grant.v1',
      grantId: crypto.randomUUID(),
      payerUserId: userId,
      payerAccountId,
      credentialIds: creds.map((c) => c.id),
      currency: policy.currency,
      maxAmountMinor: policy.offline.maxAmountMinor,
      allowedPayees: payeeRows.map((p) => ({
        accountId: p.id,
        displayName: p.display_name,
        handle: p.handle,
      })),
      slots,
      issuedAt,
      notAfter,
    };

    const body = canonicalJson(grant);
    const mac = keyManager.macGrant(body);
    const token = `${Buffer.from(body, 'utf8').toString('base64url')}.${mac}`;

    await query(
      `INSERT INTO offline_grants (id, user_id, envelope, slots, issued_at, not_after)
       VALUES ($1,$2,$3,$4, to_timestamp($5), to_timestamp($6))`,
      [grant.grantId, userId, JSON.stringify(grant), JSON.stringify(slots), issuedAt, notAfter]
    );

    await audit.log('OFFLINE_GRANT_ISSUED', {
      userId,
      data: {
        grantId: grant.grantId,
        slots: slots.length,
        maxAmountMinor: grant.maxAmountMinor,
        allowedPayeeCount: grant.allowedPayees.length,
        notAfter,
      },
    });

    return { grant, token };
  }

  /**
   * Verify a grant token's MAC and shape. Pure crypto — no database, so a
   * forged or edited token is rejected before anything else runs.
   */
  verify(token: string): GrantBody {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      fail('GRANT_INVALID', { reason: 'malformed token' });
    }
    const [bodyB64, mac] = parts;
    const json = Buffer.from(bodyB64, 'base64url').toString('utf8');
    if (!keyManager.macMatches(keyManager.macGrant(json), mac)) {
      fail('GRANT_INVALID', { reason: 'MAC does not verify — grant was edited or forged' });
    }
    let grant: GrantBody;
    try {
      grant = JSON.parse(json);
    } catch {
      fail('GRANT_INVALID', { reason: 'body is not valid JSON' });
      throw new Error('unreachable'); // fail() never returns; satisfies the compiler
    }
    if (grant.typ !== 'prism.offline.grant.v1') fail('GRANT_INVALID', { reason: 'wrong token type' });
    return grant;
  }

  /**
   * DB-side freshness/revocation check, run alongside verify() at redemption.
   * Separate from verify() because this needs the database and verify() must
   * not — a forged token should fail before a query is even issued.
   */
  async assertLive(grant: GrantBody): Promise<void> {
    if (Math.floor(Date.now() / 1000) > grant.notAfter) {
      fail('GRANT_EXPIRED', { reason: 'offline window has closed' });
    }
    const { rows } = await query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM offline_grants WHERE id = $1`,
      [grant.grantId]
    );
    if (!rows[0]) fail('GRANT_INVALID', { reason: 'unknown grant' });
    if (rows[0].revoked_at) fail('GRANT_EXPIRED', { reason: 'grant revoked' });
  }

  /** For the /offline/grant status endpoint — what the client renders while armed. */
  async current(userId: string): Promise<{ grantId: string; notAfter: string; slots: number } | null> {
    const { rows } = await query<{ id: string; not_after: Date; slots: unknown[] }>(
      `SELECT id, not_after, slots FROM offline_grants
        WHERE user_id = $1 AND revoked_at IS NULL AND not_after > NOW()
        ORDER BY issued_at DESC LIMIT 1`,
      [userId]
    );
    if (!rows[0]) return null;
    return {
      grantId: rows[0].id,
      notAfter: rows[0].not_after.toISOString(),
      slots: rows[0].slots.length,
    };
  }
}

export const offlineGrant = new OfflineGrantModule();
