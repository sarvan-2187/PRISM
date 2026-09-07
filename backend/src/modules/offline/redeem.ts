/**
 * Offline Authorization Voucher — redemption — BLACKOUT (FC-01-A).
 *
 * A voucher is what the device produced while it had no network: a signed
 * grant, the exact LockedIntent it built from one of that grant's slots, the
 * hash it computed from that intent, and a WebAuthn assertion signed over
 * that hash. This module is what runs when connectivity returns.
 *
 * An offline approval is a proof of authenticity, not a promise of
 * settlement. This redeems the proof — who approved exactly what, on which
 * device, without a server — and then, only now that the server can ask
 * anything again, runs the SAME risk engine and policy firewall the online
 * path runs, live. A voucher can be authentic and still be denied here; that
 * is what stops "offline mode" from being a bypass.
 *
 * Order of checks mirrors api/routes.ts's authorize pipeline as closely as
 * the two flows allow: cheapest and least-trusting checks first, and only
 * the last step moves money.
 *
 *   1. Grant MAC + shape             -> GRANT_INVALID
 *   2. Grant not expired/revoked     -> GRANT_EXPIRED
 *   3. Reserve the voucher's nonce   -> REPLAY_BLOCKED  (a DB UNIQUE constraint)
 *   4. Intent fits inside the grant  -> TAMPER_BLOCKED  (envelope + slot match)
 *   5. Recomputed hash matches       -> TAMPER_BLOCKED  (utils/canonical.ts, same function online uses)
 *   6. Assertion verifies            -> SIG_INVALID
 *   7. Risk + policy, run live       -> RISK_BLOCKED / POLICY_DENIED / STEP_UP_FAILED
 *   8. Settle                        -> the normal ACID path, unmodified
 */
import { Request } from 'express';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server/script/deps';
import { getClient, query } from '../../db/pool';
import { AuthorizationStage, TransactionRow, formatMinor } from '../../db/types';
import { intentHash as computeIntentHash, hashesMatch, LockedIntent } from '../../utils/canonical';
import { fail, PrismError } from '../../api/errors';
import { offlineGrant, GrantBody } from './grant';
import { identity } from '../identity/webauthn';
import { attestationChain } from '../attestation/chain';
import { context } from '../context/fingerprint';
import { riskEngine } from '../risk/riskEngine';
import { policyFirewall } from '../policy/firewall';
import { settlement } from '../ledger/settlement';
import { intentLock } from '../intent/intentLock';
import { audit } from '../audit/logger';
import { policy } from '../../config/policy';

/** Every stage an offline settlement must have before it can settle — same shape as routes.ts's REQUIRED_STAGES, minus SEMANTIC_VERIFIED (see step 7 below: offline vouchers cannot complete an interactive step-up, so REQUIRE_SEMANTIC is a hard failure here rather than a detour). */
const REQUIRED_STAGES: AuthorizationStage[] = [
  'INTENT_LOCKED',
  'WEBAUTHN_APPROVED',
  'CONTEXT_VERIFIED',
  'POLICY_EVALUATED',
  'RISK_APPROVED',
  'SETTLEMENT_AUTHORIZED',
];

export interface RedeemResult {
  decision: 'APPROVED';
  score: number;
  reasons: string[];
  settledAt: string;
  balanceMinor: number;
  balanceFormatted: string;
  txId: string;
}

async function markVoucherOutcome(
  nonce: string,
  outcome: 'SETTLED' | 'FAILED',
  failureCode: string | null,
  txId: string | null
): Promise<void> {
  await query(
    `UPDATE offline_vouchers SET outcome = $2, failure_code = $3, tx_id = COALESCE($4, tx_id) WHERE nonce = $1`,
    [nonce, outcome, failureCode, txId]
  );
}

export class OfflineRedeemModule {
  async redeem(req: Request): Promise<RedeemResult> {
    const userId = req.userId!;
    const token = String(req.body.token ?? '');
    const intent = req.body.intent as LockedIntent;
    const claimedHash = String(req.body.intentHash ?? '');
    const assertion = req.body.assertion as AuthenticationResponseJSON;

    // 1. Grant MAC + shape.
    const grant: GrantBody = offlineGrant.verify(token);

    // 2. Freshness / revocation.
    await offlineGrant.assertLive(grant);

    if (grant.payerUserId !== userId) {
      // Not this session's grant. Treated as a tamper attempt, not a 404 —
      // the grant is structurally valid, just not this payer's to spend.
      fail('TAMPER_BLOCKED', { reason: 'grant does not belong to this session' });
    }

    if (!intent || typeof intent !== 'object') {
      fail('TAMPER_BLOCKED', { reason: 'missing or malformed intent' });
    }
    const nonce = String(intent.nonce ?? '');
    if (!nonce) fail('TAMPER_BLOCKED', { reason: 'intent has no nonce' });

    // 3. Reserve the voucher's nonce. This INSERT is the replay defence: the
    // UNIQUE constraint on offline_vouchers.nonce means the same captured
    // voucher can cross this line exactly once, ever — enforced by the
    // database, not by a check that a code change could accidentally skip.
    try {
      await query(
        `INSERT INTO offline_vouchers (grant_id, nonce, outcome) VALUES ($1, $2, 'PENDING')`,
        [grant.grantId, nonce]
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        fail('REPLAY_BLOCKED', { reason: 'this offline voucher has already been redeemed' });
      }
      throw err;
    }

    let txId: string | null = null;
    try {
      // 4. Intent must sit inside the envelope: a real slot from this grant,
      // an allowed payee, within the amount cap, for this payer.
      const slot = grant.slots.find((s) => s.txId === intent.txId && s.nonce === intent.nonce);
      if (!slot) fail('TAMPER_BLOCKED', { reason: 'txId/nonce is not a slot from this grant' });

      const allowed = grant.allowedPayees.some((p) => p.accountId === intent.payeeAccountId);
      if (!allowed) fail('TAMPER_BLOCKED', { reason: 'payee is not on the offline allow-list' });

      if (intent.payerUserId !== grant.payerUserId) {
        fail('TAMPER_BLOCKED', { reason: 'payer does not match the grant' });
      }
      if (intent.currency !== grant.currency) {
        fail('TAMPER_BLOCKED', { reason: 'currency does not match the grant' });
      }
      if (intent.lockVersion !== 1) {
        fail('TAMPER_BLOCKED', { reason: 'unexpected lockVersion' });
      }
      if (
        !Number.isInteger(intent.amountMinor) ||
        intent.amountMinor <= 0 ||
        intent.amountMinor > grant.maxAmountMinor
      ) {
        fail('TAMPER_BLOCKED', { reason: 'amount exceeds the offline cap or is not a positive integer' });
      }

      // 5. Recompute the hash from the intent with the exact function the
      // online path uses, and compare against what the device claims it
      // signed. A field edited after signing changes this recomputed hash,
      // so it stops matching claimedHash right here — cheaply, before any
      // signature verification runs.
      let recomputed: string;
      try {
        recomputed = computeIntentHash(intent);
      } catch (err) {
        fail('TAMPER_BLOCKED', { reason: `intent does not hash: ${(err as Error).message}` });
        throw err; // unreachable — fail() never returns
      }
      if (!hashesMatch(recomputed, claimedHash)) {
        fail('TAMPER_BLOCKED', { reason: 'recomputed hash does not match the claimed intent hash' });
      }

      // The transaction row is created here — before the signature is
      // checked, not after — deliberately mirroring the online flow, where
      // intentLock.lock() already exists in the database before the WebAuthn
      // challenge is even issued. Any audit/chain write that names this
      // transaction (including the assertion check right below) needs a real
      // row to reference, or its write silently fails on audit_logs' foreign
      // key — audit.log() swallows that failure so a payment is never
      // blocked by a logging outage, but it also means a wrong write order
      // here quietly loses timeline entries instead of erroring loudly.
      txId = intent.txId;
      const client = await getClient();
      try {
        await client.query('BEGIN');
        try {
          await client.query(
            `INSERT INTO transactions
               (id, payer_user_id, payer_account_id, payee_account_id, amount_minor, currency,
                intent_hash, nonce, lock_version, created_at, expires_at, status, authorized_offline)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1, to_timestamp($9), to_timestamp($10), 'PENDING', TRUE)`,
            [
              txId,
              userId,
              grant.payerAccountId,
              intent.payeeAccountId,
              intent.amountMinor,
              intent.currency,
              claimedHash,
              nonce,
              intent.createdAt,
              intent.expiresAt,
            ]
          );
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            fail('REPLAY_BLOCKED', { reason: 'this transaction id or nonce has already settled' });
          }
          throw err;
        }
        await attestationChain.append(
          txId,
          'INTENT_LOCKED',
          {
            mode: 'OFFLINE',
            grantId: grant.grantId,
            // Device-claimed, not trusted for any gating decision — the real
            // time bound that binds is grant.notAfter, checked in step 2
            // against the SERVER's clock. Recorded here so the timeline can
            // show what the device claimed without the system relying on it.
            lockedAt: intent.createdAt,
            redeemedAt: Math.floor(Date.now() / 1000),
            amountMinor: intent.amountMinor,
            payeeAccountId: intent.payeeAccountId,
            currency: intent.currency,
          },
          { client }
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // 6. Now that the row exists: the assertion must be from a credential
      // this grant actually pinned (device binding), and must verify over
      // the exact hash. A failure from here on is recorded against a real
      // transaction, so the offline_vouchers row and every audit/chain write
      // below can safely reference txId.
      const assertionCredentialId = String(assertion?.id ?? '');
      if (!grant.credentialIds.includes(assertionCredentialId)) {
        fail('SIG_INVALID', { reason: 'credential is not one this grant authorized' });
      }
      await identity.verifyOfflineAssertion(userId, txId, claimedHash, assertion);
      await attestationChain.append(txId, 'WEBAUTHN_APPROVED', {
        mode: 'OFFLINE',
        credentialId: assertionCredentialId,
        verified: true,
      });

      // Context, risk, policy — the real thing, evaluated now that the
      // server can be asked. deliberationMs is measured from this row's
      // created_at (the device-claimed lock moment), so it naturally reads
      // as "time offline plus time to redeem" rather than triggering a false
      // HASTY_APPROVAL — an offline approval, by construction, always took a
      // deliberate local biometric confirmation.
      const snapshot = context.snapshot(req, { credentialId: assertionCredentialId, txId });
      const signals = await context.evaluate(userId, snapshot, intent.payeeAccountId, intent.amountMinor);
      await audit.log('CONTEXT_EVALUATED', {
        transactionId: txId,
        userId,
        data: {
          ...signals,
          deviceFingerprint: snapshot.deviceFingerprint,
          acceptLanguage: snapshot.acceptLanguage,
          networkId: snapshot.networkId,
          networkSubnet: snapshot.networkSubnet,
          networkFamily: snapshot.networkFamily,
          networkPrivate: snapshot.networkPrivate,
          offline: true,
        },
      });
      await attestationChain.append(txId, 'CONTEXT_VERIFIED', { ...signals });

      const risk = await riskEngine.evaluate(txId, userId, { ...signals, amountMinor: intent.amountMinor });
      await query(
        `UPDATE transactions SET risk_score = $2, risk_decision = $3, fired_rule_ids = $4 WHERE id = $1`,
        [txId, risk.score, risk.decision, risk.firedRuleIds]
      );

      const { rows: txRows } = await query<TransactionRow>('SELECT * FROM transactions WHERE id = $1', [txId]);
      const tx = txRows[0];
      const scoredTx = { ...tx, risk_score: risk.score };

      const decision = await policyFirewall.evaluate({ tx: scoredTx, signals, isDuressCredential: false });
      await attestationChain.append(txId, 'POLICY_EVALUATED', {
        outcome: decision.outcome,
        firedRules: decision.firedRules.map((r) => r.id),
        policyVersion: decision.policyVersion,
      });
      await query(`UPDATE transactions SET policy_version = $2 WHERE id = $1`, [txId, decision.policyVersion]);

      if (decision.outcome === 'DENY') {
        await intentLock.markFailed(txId, 'POLICY_DENIED', 'BLOCKED');
        await audit.log('POLICY_DENIED', {
          transactionId: txId,
          userId,
          data: { firedRules: decision.firedRules.map((r) => r.id), riskScore: risk.score, offline: true },
        });
        throw new PrismError(403, 'POLICY_DENIED', 'A payment policy refused this transaction.', {
          rules: decision.firedRules,
          score: risk.score,
        });
      }

      if (decision.outcome === 'REQUIRE_SEMANTIC') {
        // An offline voucher cannot complete an interactive comprehension
        // check — there is no live device to put the question to. Refusing
        // is the correct behaviour: this is exactly the "still be denied"
        // half of "proof of authenticity, not promise of settlement".
        await intentLock.markFailed(txId, 'STEP_UP_FAILED', 'BLOCKED');
        await audit.log('STEP_UP_FAILED', {
          transactionId: txId,
          userId,
          data: { reason: 'semantic verification required but not obtainable for an offline voucher' },
        });
        throw new PrismError(
          403,
          'STEP_UP_FAILED',
          'This offline payment needs verification that can only happen online.'
        );
      }

      if (risk.decision === 'BLOCK') {
        await intentLock.markFailed(txId, 'RISK_BLOCKED', 'BLOCKED');
        await audit.log('PAYMENT_BLOCKED', {
          transactionId: txId,
          userId,
          data: { failureCode: 'RISK_BLOCKED', score: risk.score, reasons: risk.reasons, offline: true },
        });
        throw new PrismError(403, 'RISK_BLOCKED', 'This payment was blocked as high risk.', {
          score: risk.score,
          reasons: risk.reasons,
        });
      }

      await attestationChain.append(txId, 'RISK_APPROVED', {
        score: risk.score,
        decision: risk.decision,
        firedRuleIds: risk.firedRuleIds,
      });

      await attestationChain.append(txId, 'SETTLEMENT_AUTHORIZED', { mode: 'NORMAL' });
      const capability = await attestationChain.mintCapability(
        txId,
        1,
        claimedHash,
        REQUIRED_STAGES,
        'NORMAL',
        policy.intentTtlSeconds
      );
      await query(`UPDATE transactions SET status = 'AUTHORIZED' WHERE id = $1`, [txId]);
      await audit.log('SETTLEMENT_AUTHORIZED', {
        transactionId: txId,
        userId,
        data: { attempt: 1, mode: 'NORMAL', capabilityId: capability.id, offline: true },
      });

      const result = await settlement.settle(tx, capability);
      await intentLock.consumeNonce(nonce);
      await context.updateBaseline(userId, snapshot);

      await markVoucherOutcome(nonce, 'SETTLED', null, txId);
      await audit.log('OFFLINE_VOUCHER_REDEEMED', {
        transactionId: txId,
        userId,
        data: { grantId: grant.grantId, amountMinor: intent.amountMinor },
      });

      return {
        decision: 'APPROVED',
        score: risk.score,
        reasons: risk.reasons,
        settledAt: result.settledAt.toISOString(),
        balanceMinor: result.payerBalanceMinor,
        balanceFormatted: formatMinor(result.payerBalanceMinor),
        txId,
      };
    } catch (err) {
      const failureCode = err instanceof PrismError ? err.failureCode : 'INTERNAL_ERROR';
      await markVoucherOutcome(nonce, 'FAILED', failureCode, txId).catch(() => {});
      if (txId) {
        // A row was inserted (the failure is at or after the signature
        // check) — terminate it rather than leaving it PENDING forever. A
        // failure before insertion (tamper/envelope checks) leaves txId null
        // and there is nothing here to terminate.
        await intentLock.markFailed(txId, failureCode, 'BLOCKED').catch(() => {});
      }
      if (err instanceof PrismError) {
        await audit.log('OFFLINE_VOUCHER_REJECTED', {
          transactionId: txId,
          userId,
          data: { failureCode, reason: err.message, details: err.details ?? null },
        });
      }
      throw err;
    }
  }
}

export const offlineRedeem = new OfflineRedeemModule();
