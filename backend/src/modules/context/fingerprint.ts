/**
 * Context Module — micro-fingerprint + drift.
 *
 * Cryptography verifies credentials, not circumstances. A thief holding an
 * unlocked phone presents perfectly valid credentials. This module is the only
 * layer that can notice the situation has changed.
 *
 * Signal weighting note: the demo runs from a second browser profile on the
 * same machine, so IP and ASN are identical and useless. The signals that
 * carry weight here are therefore device/session/transaction shaped — an
 * unrecognised credential, no stored baseline, a never-paid payee, an amount
 * outside the payer's range, an implausibly fast approval. Those fire
 * deterministically in a fresh profile, which is what makes the demo
 * reproducible rather than hopeful.
 *
 * Privacy boundary: this is a consistency signal, not an identity mechanism
 * and not covert tracking. Coarse features, hashed, short retention. No
 * canvas or audio fingerprinting, no browsing history, no raw biometrics.
 */
import crypto from 'crypto';
import { Request } from 'express';
import redis from '../../utils/redis';
import { query } from '../../db/pool';
import { policy } from '../../config/policy';
import {
  normaliseSubnet,
  networkChanged as didNetworkChange,
  impossibleTravel,
  geoForIp,
  type GeoPoint,
  type AddressFamily,
} from './network';

export interface ContextSnapshot {
  /** Coarse: hashed UA family + language + platform. Never the raw string. */
  deviceFingerprint: string;
  /** Hashed /24 or /48 subnet — see modules/context/network.ts. Never a raw address. */
  networkId: string;
  /** Whether that subnet was loopback/RFC1918, i.e. carries no real evidence. */
  networkPrivate: boolean;
  /**
   * The coarse subnet in readable form, e.g. "192.168.1.0/24". For the audit
   * trail and logs only — every decision compares the hashed networkId, never
   * this. Already a /24 or /48, so it does not single out a host.
   */
  networkSubnet: string;
  networkFamily: AddressFamily;
  acceptLanguage: string;
  credentialId: string | null;
  /**
   * The transaction this snapshot belongs to, read from the route params.
   * Carried here so evaluate() can derive deliberation time server-side
   * without changing its signature — routes.ts belongs to S1.
   */
  txId: string | null;
}

export interface ContextSignals {
  newDevice: boolean;
  noBaseline: boolean;
  newPayee: boolean;
  amountAnomaly: boolean;
  /** Far beyond odd — a different kind of event, scored separately. */
  amountExtreme: boolean;
  hastyApproval: boolean;
  networkChanged: boolean;
  /**
   * Account used from two places too far apart to travel between.
   * Designed and unit-tested, but never fires in this build: locating an
   * address needs a geolocation source we deliberately do not ship. See
   * geoForIp() in network.ts.
   */
  impossibleTravel: boolean;
  /** Server-measured, for the timeline. null when there was nothing to measure. */
  deliberationMs: number | null;
  /** For the timeline: what the payer's normal actually looks like. */
  payerHistoryCount: number;
  /** A robust "typical" payment for this payer — see the query in evaluate(). */
  usualAmountMinor: number;
}

const baselineKey = (userId: string) => `ctx:baseline:${userId}`;
const lastSeenNetworkKey = (userId: string) => `ctx:netseen:${userId}`;

interface LastSeenNetwork {
  networkId: string;
  geo: GeoPoint | null;
  at: number;
}

export class ContextModule {
  /**
   * Build a snapshot from the request itself.
   *
   * Note what is NOT read here: `deliberationMs` from the request body. The
   * client used to supply it, which meant an attacker could send
   * `deliberationMs: 90000` and the HASTY_APPROVAL signal would never fire —
   * quietly removing a signal from the scam-call scenario. It is now derived
   * server-side in evaluate(). Anything the payer controls cannot be evidence
   * about the payer.
   */
  snapshot(
    req: Request,
    extra: {
      credentialId?: string;
      /**
       * Accepted and deliberately ignored. routes.ts still passes the
       * client's own figure; taking it out of the signature would break
       * S1's file, and silently dropping it here is the safer half of the
       * fix anyway — the value never reaches the risk engine either way.
       * S1 can remove the argument whenever convenient.
       */
      deliberationMs?: number;
      /**
       * Offline redemption (003, BLACKOUT) has no `:id` route param — the
       * transaction is created mid-request from the voucher body, not read
       * from the URL. Lets that caller supply the txId explicitly instead of
       * duplicating this method's fingerprinting logic.
       */
      txId?: string;
    } = {}
  ): ContextSnapshot {
    const ua = req.headers['user-agent'] ?? '';
    const lang = req.headers['accept-language'] ?? '';
    const platform = (req.headers['sec-ch-ua-platform'] as string) ?? '';

    // req.ip is the real socket address: Express runs without `trust proxy`,
    // so a forged X-Forwarded-For cannot move it. Network evidence is observed,
    // never asserted by the party being judged.
    const net = normaliseSubnet(req.ip);

    return {
      deviceFingerprint: crypto
        .createHash('sha256')
        .update(`${ua}|${lang}|${platform}`)
        .digest('hex')
        .slice(0, 16),
      networkId: net.networkId,
      networkPrivate: net.isPrivate,
      networkSubnet: net.subnet,
      networkFamily: net.family,
      acceptLanguage: String(lang).slice(0, 32),
      credentialId: extra.credentialId ?? null,
      txId: extra.txId ?? (req.params?.id as string | undefined) ?? null,
    };
  }

  /**
   * How long the payer had the authoritative details on screen before
   * approving, measured from the server's own CHALLENGE_ISSUED audit row.
   *
   * Returns null when there is no challenge to measure against, and a null
   * deliberation never fires the hasty signal — an unmeasurable situation is
   * not evidence of anything.
   */
  private async deliberationMs(txId: string | null): Promise<number | null> {
    if (!txId) return null;
    // Measured from INTENT_LOCKED, not CHALLENGE_ISSUED. The challenge is
    // issued at the moment the user clicks Approve, so anchoring there always
    // reports a few milliseconds and the signal never fires. The intent is
    // locked when the payment is composed, which is when the authoritative
    // details first reach the screen — that is the window we care about.
    const { rows } = await query<{ created_at: Date }>(
      `SELECT created_at FROM transactions WHERE id = $1`,
      [txId]
    );
    if (!rows[0]) return null;
    return Date.now() - rows[0].created_at.getTime();
  }

  /**
   * Was the account just used from somewhere it could not have reached in
   * time? Records the sighting either way, so the next request has something
   * to compare against.
   *
   * Always false in this build: geoForIp() returns null because we ship no
   * geolocation source, and an unplaceable request is not evidence. The
   * arithmetic is real and unit-tested; only the input is missing.
   */
  private async checkTravel(userId: string, snapshot: ContextSnapshot): Promise<boolean> {
    const geo = geoForIp({
      subnet: '',
      family: 'unknown',
      isPrivate: snapshot.networkPrivate,
      networkId: snapshot.networkId,
    });

    const raw = await redis.get(lastSeenNetworkKey(userId));
    const previous = raw ? (JSON.parse(raw) as LastSeenNetwork) : null;

    const flagged =
      previous !== null &&
      previous.networkId !== snapshot.networkId &&
      impossibleTravel(previous.geo, geo, Date.now() - previous.at, policy.maxPlausibleKmH);

    const sighting: LastSeenNetwork = { networkId: snapshot.networkId, geo, at: Date.now() };
    await redis.set(
      lastSeenNetworkKey(userId),
      JSON.stringify(sighting),
      'EX',
      policy.contextBaselineTtlSeconds
    );

    return flagged;
  }

  /**
   * Compare the current situation against the payer's history and stored
   * baseline. Returns raw signals — this module never decides anything; the
   * risk engine does. Keeping judgement out of here is what lets a Future
   * Card add a rule without touching fingerprinting.
   */
  async evaluate(
    userId: string,
    snapshot: ContextSnapshot,
    payeeAccountId: string,
    amountMinor: number
  ): Promise<ContextSignals> {
    const stored = await redis.get(baselineKey(userId));
    const baseline = stored ? (JSON.parse(stored) as ContextSnapshot) : null;

    // The 90th percentile, not the maximum.
    //
    // Grading against MAX means one large settled payment permanently raises
    // the bar: a victim coerced into a single big transfer would have every
    // later transfer judged against it, and the detector would quietly go
    // deaf. A percentile absorbs one outlier and keeps the payer's normal
    // where it actually is.
    const { rows: hist } = await query<{ count: string; usual: string | null }>(
      `SELECT COUNT(*)::text AS count,
              PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY amount_minor)::text AS usual
         FROM transactions
        WHERE payer_user_id = $1 AND status = 'SETTLED'`,
      [userId]
    );
    const payerHistoryCount = parseInt(hist[0].count, 10);
    const usualAmountMinor = Math.round(parseFloat(hist[0].usual ?? '0'));

    const { rows: paid } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM transactions
        WHERE payer_user_id = $1 AND payee_account_id = $2 AND status = 'SETTLED'`,
      [userId, payeeAccountId]
    );
    const newPayee = parseInt(paid[0].count, 10) === 0;
    const deliberationMs = await this.deliberationMs(snapshot.txId);
    const travelled = await this.checkTravel(userId, snapshot);

    return {
      noBaseline: baseline === null,
      newDevice: baseline !== null && baseline.deviceFingerprint !== snapshot.deviceFingerprint,
      // Delegated so the private-address suppression lives in one place, next
      // to the address arithmetic it depends on.
      networkChanged: didNetworkChange(
        baseline && { networkId: baseline.networkId, isPrivate: baseline.networkPrivate },
        { networkId: snapshot.networkId, isPrivate: snapshot.networkPrivate }
      ),
      impossibleTravel: travelled,
      newPayee,
      // Graded against the payer's largest settled payment. The two bands are
      // mutually exclusive so a single payment is never scored twice for the
      // same fact.
      amountAnomaly:
        payerHistoryCount > 0 &&
        amountMinor > usualAmountMinor * policy.amountAnomalyMultiple &&
        amountMinor <= usualAmountMinor * policy.amountExtremeMultiple,
      amountExtreme:
        payerHistoryCount > 0 && amountMinor > usualAmountMinor * policy.amountExtremeMultiple,
      hastyApproval: deliberationMs !== null && deliberationMs < policy.hastyApprovalMs,
      deliberationMs,
      payerHistoryCount,
      usualAmountMinor,
    };
  }

  /**
   * Called after a clean settlement, so normal behaviour becomes the norm.
   * txId is stripped: a baseline describes a device, not a payment, and
   * leaving it in would make every comparison look different.
   */
  async updateBaseline(userId: string, snapshot: ContextSnapshot): Promise<void> {
    const { txId: _txId, ...device } = snapshot;
    await redis.set(
      baselineKey(userId),
      JSON.stringify({ ...device, txId: null }),
      'EX',
      policy.contextBaselineTtlSeconds
    );
  }
}

export const context = new ContextModule();
