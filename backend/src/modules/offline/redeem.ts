/**
 * Offline authorization voucher — redemption — BLACKOUT (FC-01-A).
 *
 * The card: "the device goes fully offline mid-payment. Authentication must
 * still complete locally and stay replay-proof when connectivity returns."
 *
 * So this is the SAME payment, not a different one. A payment is initiated
 * online in the ordinary way (POST /payment/initiate), which locks the
 * intent, computes the intent hash server-side, and hands that hash to the
 * browser. If the network dies before the payer taps Approve, the device
 * already holds everything it needs: the passkey prompt is local hardware,
 * and the challenge it signs — the intent hash — was handed over while the
 * link was still up. Nothing has to be invented offline.
 *
 * A voucher is therefore just: which transaction, the hash the device
 * signed, the assertion, and the grant proving this device was armed while
 * online. This module authorizes that already-locked transaction.
 *
 * Order of checks (cheapest and least-trusting first; only the last step
 * moves money):
 *
 *   1. Grant MAC + shape              -> GRANT_INVALID
 *   2. Grant window + reconnect grace -> GRANT_EXPIRED
 *   3. Load the REAL transaction, check ownership and terminal state
 *   4. Reserve the transaction's nonce -> REPLAY_BLOCKED (a DB UNIQUE constraint)
 *   5. Intent still hashes to what was signed -> TAMPER_BLOCKED
 *   6. Payment fits the grant's envelope      -> TAMPER_BLOCKED
 *   7. Assertion verifies over that hash      -> SIG_INVALID
 *   8. Risk + policy, re-run LIVE             -> RISK_BLOCKED / POLICY_DENIED
 *   9. Settle through the normal ACID path
 *
 * What is deliberately NOT checked: intentLock.isExpired(). The intent
 * window is 90 seconds and no real blackout respects it — enforcing it here
 * would reject every honest offline approval, which is exactly the bug this
 * rewrite fixes. The grant window plus its reconnect grace bounds the
 * voucher instead, and the lag is recorded on the chain rather than hidden.
 */
import { Request } from 'express';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server/script/deps';
import { query } from '../../db/pool';
import { AuthorizationStage, formatMinor } from '../../db/types';
import { hashesMatch } from '../../utils/canonical';
import { fail, PrismError, FAILURES, FailureCode } from '../../api/errors';
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

/** Same stages the online authorize path requires before settlement. */
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
  /** Seconds between the intent's own expiry and this redemption. Display + audit only. */
  lateBySeconds: number;
}

async function markVoucherOutcome(
  nonce: string,
  outcome: 'SETTLED' | 'FAILED',
  failureCode: string | null
): Promise<void> {
  await query(`UPDATE offline_vouchers SET outcome = $2, failure_code = $3 WHERE nonce = $1`, [
    nonce,
    outcome,
    failureCode,
  ]);
}

export class OfflineRedeemModule {
  async redeem(req: Request): Promise<RedeemResult> {
    const userId = req.userId!;
    const token = String(req.body.token ?? '');
    const txId = String(req.body.txId ?? '');
    const claimedHash = String(req.body.intentHash ?? '');
    const assertion = req.body.assertion as AuthenticationResponseJSON;

    if (!txId) fail('TAMPER_BLOCKED', { reason: 'voucher names no transaction' });

    // 1 + 2. The grant: proof this device was armed while online, and the
    // only time bound that applies to an offline approval.
    const grant: GrantBody = offlineGrant.verify(token);
    await offlineGrant.assertLive(grant);
    if (grant.payerUserId !== userId) {
      fail('TAMPER_BLOCKED', { reason: 'grant does not belong to this session' });
    }

    // 3. The real, already-locked transaction — the same row the online
    // path would have authorized.
    const tx = await intentLock.get(txId);
    if (tx.payer_user_id !== userId) fail('NOT_FOUND');
    if (tx.status === 'SETTLED' || tx.status === 'DURESS_HELD') {
      fail('REPLAY_BLOCKED', { reason: 'this payment has already settled' });
    }
    if (tx.status === 'BLOCKED' || tx.status === 'EXPIRED' || tx.status === 'SUPERSEDED') {
      const code: FailureCode =
        tx.failure_code && tx.failure_code in FAILURES
          ? (tx.failure_code as FailureCode)
          : 'RISK_BLOCKED';
      fail(code, { reason: `transaction is already terminal (${tx.status})` });
    }

    // 4. Replay defence. The transaction's OWN nonce is the key: one
    // transaction, one offline redemption, ever — enforced by the UNIQUE
    // constraint on offline_vouchers.nonce, not by a check above it. A
    // captured voucher resubmitted after the link is back dies right here.
    try {
      await query(
        `INSERT INTO offline_vouchers (grant_id, nonce, tx_id, outcome) VALUES ($1, $2, $3, 'PENDING')`,
        [grant.grantId, tx.nonce, tx.id]
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        fail('REPLAY_BLOCKED', { reason: 'this offline voucher has already been redeemed' });
      }
      throw err;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = Math.floor(tx.expires_at.getTime() / 1000);
    const lateBySeconds = Math.max(0, nowSeconds - expiresAtSeconds);

    try {
      // 5. The device signed a hash. It must be the hash this transaction
      // actually has, recomputed by the server from its own columns — the
      // same verifyHash the online path uses, with the same meaning.
      if (!claimedHash || !hashesMatch(claimedHash, tx.intent_hash)) {
        fail('TAMPER_BLOCKED', { reason: "the signed hash is not this transaction's intent hash" });
      }
      if (!intentLock.verifyHash(tx, claimedHash)) {
        fail('TAMPER_BLOCKED', { reason: 'intent hash does not match the locked record' });
      }

      // 6. The payment has to sit inside the envelope the grant sealed while
      // the device was still online. The device cannot widen any of this.
      const allowed = grant.allowedPayees.some((p) => p.accountId === tx.payee_account_id);
      if (!allowed) {
        fail('TAMPER_BLOCKED', { reason: "payee is not on this grant's offline allow-list" });
      }
      const amountMinor = parseInt(tx.amount_minor, 10);
      if (amountMinor > grant.maxAmountMinor) {
        fail('TAMPER_BLOCKED', { reason: 'amount exceeds the offline cap sealed in the grant' });
      }
      if (tx.currency !== grant.currency) {
        fail('TAMPER_BLOCKED', { reason: 'currency does not match the grant' });
      }

      // Redis nonce state is a second, independent replay layer. A CONSUMED
      // nonce means this transaction already settled. A MISSING one is fine
      // here and only here: its TTL is shorter than the offline window, so
      // absence means "aged out", not "spent" — the UNIQUE constraint in
      // step 4 is what actually guarantees single use.
      const nonceState = await intentLock.nonceState(tx.nonce);
      if (nonceState === 'CONSUMED') {
        fail('REPLAY_BLOCKED', { reason: 'nonce already consumed' });
      }

      // 7. The signature itself, over that exact hash, from a credential
      // this grant pinned while online (device binding) and that is still
      // not revoked (the stolen-device response still wins).
      const assertionCredentialId = String(assertion?.id ?? '');
      if (!grant.credentialIds.includes(assertionCredentialId)) {
        fail('SIG_INVALID', { reason: 'credential is not one this grant authorized' });
      }
      await identity.verifyOfflineAssertion(userId, tx.id, tx.intent_hash, assertion);

      // From here this is the online authorize pipeline, unchanged: same
      // modules, same order, same chain stages. The transaction already
      // carries its INTENT_LOCKED root from when it was locked online.
      const attempt = await attestationChain.startAttempt(tx.id);
      await attestationChain.append(tx.id, 'WEBAUTHN_APPROVED', {
        mode: 'OFFLINE',
        credentialId: assertionCredentialId,
        grantId: grant.grantId,
        // Recorded, never trusted: the server cannot observe when the device
        // actually signed. The grant window is what bounds this.
        approvedOfflineAtClaimed: Number(req.body.approvedAt) || null,
        redeemedAt: nowSeconds,
        lateBySeconds,
        verified: true,
      });

      const snapshot = context.snapshot(req, { credentialId: assertionCredentialId, txId: tx.id });
      const signals = await context.evaluate(userId, snapshot, tx.payee_account_id, amountMinor);
      await audit.log('CONTEXT_EVALUATED', {
        transactionId: tx.id,
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
          lateBySeconds,
        },
      });
      await attestationChain.append(tx.id, 'CONTEXT_VERIFIED', { ...signals, offline: true });

      const risk = await riskEngine.evaluate(tx.id, userId, { ...signals, amountMinor });
      await query(
        `UPDATE transactions SET risk_score = $2, risk_decision = $3, fired_rule_ids = $4 WHERE id = $1`,
        [tx.id, risk.score, risk.decision, risk.firedRuleIds]
      );
      const scoredTx = { ...tx, risk_score: risk.score };

      const decision = await policyFirewall.evaluate({
        tx: scoredTx,
        signals,
        isDuressCredential: false,
      });
      await attestationChain.append(tx.id, 'POLICY_EVALUATED', {
        outcome: decision.outcome,
        firedRules: decision.firedRules.map((r) => r.id),
        policyVersion: decision.policyVersion,
      });
      await query(`UPDATE transactions SET policy_version = $2 WHERE id = $1`, [
        tx.id,
        decision.policyVersion,
      ]);

      if (decision.outcome === 'DENY') {
        await intentLock.markFailed(tx.id, 'POLICY_DENIED', 'BLOCKED');
        await audit.log('POLICY_DENIED', {
          transactionId: tx.id,
          userId,
          data: {
            firedRules: decision.firedRules.map((r) => r.id),
            riskScore: risk.score,
            offline: true,
          },
        });
        throw new PrismError(403, 'POLICY_DENIED', 'A payment policy refused this transaction.', {
          rules: decision.firedRules,
          score: risk.score,
        });
      }

      if (decision.outcome === 'REQUIRE_SEMANTIC') {
        // Only reachable for an amended intent. An offline voucher cannot
        // answer a comprehension check — there is no live device to ask.
        await intentLock.markFailed(tx.id, 'STEP_UP_FAILED', 'BLOCKED');
        await audit.log('STEP_UP_FAILED', {
          transactionId: tx.id,
          userId,
          data: { reason: 'semantic verification required but not obtainable for an offline voucher' },
        });
        throw new PrismError(
          403,
          'STEP_UP_FAILED',
          'This payment needs a verification step that can only be done online.'
        );
      }

      if (risk.decision === 'BLOCK') {
        await intentLock.markFailed(tx.id, 'RISK_BLOCKED', 'BLOCKED');
        await audit.log('PAYMENT_BLOCKED', {
          transactionId: tx.id,
          userId,
          data: {
            failureCode: 'RISK_BLOCKED',
            score: risk.score,
            reasons: risk.reasons,
            offline: true,
          },
        });
        throw new PrismError(403, 'RISK_BLOCKED', 'This payment was blocked as high risk.', {
          score: risk.score,
          reasons: risk.reasons,
        });
      }

      await attestationChain.append(tx.id, 'RISK_APPROVED', {
        score: risk.score,
        decision: risk.decision,
        firedRuleIds: risk.firedRuleIds,
      });
      await attestationChain.append(tx.id, 'SETTLEMENT_AUTHORIZED', { mode: 'NORMAL', offline: true });

      const capability = await attestationChain.mintCapability(
        tx.id,
        attempt,
        tx.intent_hash,
        REQUIRED_STAGES,
        'NORMAL',
        policy.intentTtlSeconds
      );
      await query(
        `UPDATE transactions SET status = 'AUTHORIZED', authorized_offline = TRUE WHERE id = $1`,
        [tx.id]
      );
      await audit.log('SETTLEMENT_AUTHORIZED', {
        transactionId: tx.id,
        userId,
        data: { attempt, mode: 'NORMAL', capabilityId: capability.id, offline: true },
      });

      const result = await settlement.settle(tx, capability);
      await intentLock.consumeNonce(tx.nonce);
      await context.updateBaseline(userId, snapshot);

      await markVoucherOutcome(tx.nonce, 'SETTLED', null);
      await audit.log('OFFLINE_VOUCHER_REDEEMED', {
        transactionId: tx.id,
        userId,
        data: { grantId: grant.grantId, amountMinor, lateBySeconds },
      });

      return {
        decision: 'APPROVED',
        score: risk.score,
        reasons: risk.reasons,
        settledAt: result.settledAt.toISOString(),
        balanceMinor: result.payerBalanceMinor,
        balanceFormatted: formatMinor(result.payerBalanceMinor),
        txId: tx.id,
        lateBySeconds,
      };
    } catch (err) {
      const failureCode = err instanceof PrismError ? err.failureCode : 'INTERNAL_ERROR';
      await markVoucherOutcome(tx.nonce, 'FAILED', failureCode).catch(() => {});
      if (err instanceof PrismError) {
        await audit.log('OFFLINE_VOUCHER_REJECTED', {
          transactionId: tx.id,
          userId,
          data: { failureCode, reason: err.message, details: err.details ?? null },
        });
      }
      throw err;
    }
  }
}

export const offlineRedeem = new OfflineRedeemModule();
