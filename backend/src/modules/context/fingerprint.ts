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

export interface ContextSnapshot {
  /** Coarse: hashed UA family + language + platform. Never the raw string. */
  deviceFingerprint: string;
  ipPrefix: string;
  acceptLanguage: string;
  /** Milliseconds between the review screen appearing and approval. */
  deliberationMs: number | null;
  credentialId: string | null;
}

export interface ContextSignals {
  newDevice: boolean;
  noBaseline: boolean;
  newPayee: boolean;
  amountAnomaly: boolean;
  hastyApproval: boolean;
  networkChanged: boolean;
  /** For the timeline: what the payer's normal actually looks like. */
  payerHistoryCount: number;
  usualMaxMinor: number;
}

const baselineKey = (userId: string) => `ctx:baseline:${userId}`;

export class ContextModule {
  snapshot(req: Request, extra: { deliberationMs?: number; credentialId?: string }): ContextSnapshot {
    const ua = req.headers['user-agent'] ?? '';
    const lang = req.headers['accept-language'] ?? '';
    const platform = (req.headers['sec-ch-ua-platform'] as string) ?? '';
    return {
      deviceFingerprint: crypto
        .createHash('sha256')
        .update(`${ua}|${lang}|${platform}`)
        .digest('hex')
        .slice(0, 16),
      ipPrefix: (req.ip ?? '').split('.').slice(0, 2).join('.'),
      acceptLanguage: String(lang).slice(0, 32),
      deliberationMs: extra.deliberationMs ?? null,
      credentialId: extra.credentialId ?? null,
    };
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

    const { rows: hist } = await query<{ count: string; max_minor: string | null }>(
      `SELECT COUNT(*)::text AS count, MAX(amount_minor)::text AS max_minor
         FROM transactions
        WHERE payer_user_id = $1 AND status = 'SETTLED'`,
      [userId]
    );
    const payerHistoryCount = parseInt(hist[0].count, 10);
    const usualMaxMinor = parseInt(hist[0].max_minor ?? '0', 10);

    const { rows: paid } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM transactions
        WHERE payer_user_id = $1 AND payee_account_id = $2 AND status = 'SETTLED'`,
      [userId, payeeAccountId]
    );
    const newPayee = parseInt(paid[0].count, 10) === 0;

    return {
      noBaseline: baseline === null,
      newDevice: baseline !== null && baseline.deviceFingerprint !== snapshot.deviceFingerprint,
      networkChanged: baseline !== null && baseline.ipPrefix !== snapshot.ipPrefix,
      newPayee,
      // "Far outside normal" = more than 3x the largest payment ever made.
      // Needs history to mean anything, which is why the seed provides some.
      amountAnomaly: payerHistoryCount > 0 && amountMinor > usualMaxMinor * 3,
      hastyApproval: snapshot.deliberationMs !== null && snapshot.deliberationMs < 1500,
      payerHistoryCount,
      usualMaxMinor,
    };
  }

  /** Called after a clean settlement, so normal behaviour becomes the norm. */
  async updateBaseline(userId: string, snapshot: ContextSnapshot): Promise<void> {
    await redis.set(
      baselineKey(userId),
      JSON.stringify(snapshot),
      'EX',
      policy.contextBaselineTtlSeconds
    );
  }
}

export const context = new ContextModule();
