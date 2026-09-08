/**
 * PRISM App API.
 *
 * Its own server, but NOT its own logic: every module that decides whether
 * money moves is imported from the web backend. Intent locking, context,
 * risk, the policy firewall, the attestation chain and settlement are the
 * same code operating on the same database, so a payment made on the phone
 * is the same kind of object as one made in the browser and lands in the same
 * ledger and the same audit trail.
 *
 * Exactly one thing differs, and it is the reason this server exists: the
 * proof of possession. A browser signs with a passkey; the phone cannot, so
 * it answers with an HMAC over the same intent hash. See `authorize` below.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'node:crypto';

import { query } from '../../../backend/src/db/pool';
import {
  AccountRow,
  TransactionRow,
  UserRow,
  AuthorizationStage,
  formatMinor,
} from '../../../backend/src/db/types';
import { fail, PrismError } from '../../../backend/src/api/errors';
import { intentLock } from '../../../backend/src/modules/intent/intentLock';
import { context } from '../../../backend/src/modules/context/fingerprint';
import { riskEngine } from '../../../backend/src/modules/risk/riskEngine';
import { semantic } from '../../../backend/src/modules/semantic/intentCheck';
import { settlement } from '../../../backend/src/modules/ledger/settlement';
import { audit } from '../../../backend/src/modules/audit/logger';
import { attestationChain } from '../../../backend/src/modules/attestation/chain';
import { policyFirewall } from '../../../backend/src/modules/policy/firewall';
import { dynamicQr } from '../../../backend/src/modules/qr/dynamicQr';
import { authenticator, authWindowKey } from '../../../backend/src/modules/authenticator';
import { policy } from '../../../backend/src/config/policy';
import redis from '../../../backend/src/utils/redis';

import { attachSession, requireSession, mintToken } from './session';

/**
 * The chain stages a device-approved payment must present. Identical to the
 * web backend's list except for the proof: DEVICE_APPROVED where a browser
 * writes WEBAUTHN_APPROVED. Settlement re-verifies this, so a payment that
 * skipped a stage cannot mint a capability no matter what this server thinks.
 */
const REQUIRED_STAGES: AuthorizationStage[] = [
  'INTENT_LOCKED',
  'DEVICE_APPROVED',
  'CONTEXT_VERIFIED',
  'POLICY_EVALUATED',
  'RISK_APPROVED',
  'SETTLEMENT_AUTHORIZED',
];

const router = Router();
router.use(attachSession);

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

async function userByEmail(email: string): Promise<UserRow> {
  const { rows } = await query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
  if (!rows[0]) fail('NOT_FOUND', { reason: 'no such user' });
  return rows[0];
}

async function accountFor(userId: string): Promise<AccountRow> {
  const { rows } = await query<AccountRow>(
    'SELECT * FROM accounts WHERE user_id = $1 ORDER BY created_at LIMIT 1',
    [userId]
  );
  if (!rows[0]) fail('NOT_FOUND', { reason: 'no account' });
  return rows[0];
}

/** Server-authoritative view. The Review screen renders ONLY this. */
async function present(tx: TransactionRow) {
  const { rows } = await query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [
    tx.payee_account_id,
  ]);
  const payee = rows[0];
  return {
    txId: tx.id,
    payeeName: payee?.display_name ?? 'Unknown',
    payeeHandle: payee?.handle ?? '',
    amountMinor: parseInt(tx.amount_minor, 10),
    amountFormatted: formatMinor(tx.amount_minor, tx.currency),
    currency: tx.currency,
    status: tx.status,
    intentHash: tx.intent_hash,
    expiresAt: tx.expires_at.toISOString(),
    secondsRemaining: Math.max(0, Math.floor((tx.expires_at.getTime() - Date.now()) / 1000)),
    riskScore: tx.risk_score,
    riskReasons: tx.risk_reasons,
    failureCode: tx.failure_code,
    stepUpMode: tx.step_up_mode,
  };
}

// ──────────────────────────────────────────────────────────────
// Sign in with the paired device
// ──────────────────────────────────────────────────────────────

/**
 * Two steps, because a code must be bound to something the server chose.
 *
 * Without a server challenge the same six digits would be valid forever for
 * that account, which is a password with extra steps. The challenge is
 * random, single-use and short-lived, and the code derived from it cannot be
 * replayed against a payment because a payment code is derived from an intent
 * hash instead.
 */
router.post(
  '/auth/challenge',
  wrap(async (req, res) => {
    const user = await userByEmail(String(req.body.email ?? ''));
    if (!(await authenticator.hasActiveDevice(user.id))) {
      fail('AUTH_FAILED', {
        reason: 'no paired device on this account — pair one in the web portal first',
      });
    }
    const challenge = randomBytes(32).toString('base64url');
    await redis.set(`app:login:${user.id}`, challenge, 'EX', 120);
    res.json({ challenge, expiresInSeconds: 120 });
  })
);

router.post(
  '/auth/login',
  wrap(async (req, res) => {
    const user = await userByEmail(String(req.body.email ?? ''));
    const key = `app:login:${user.id}`;
    const challenge = await redis.get(key);
    if (!challenge) fail('AUTH_FAILED', { reason: 'challenge expired, request another' });

    const ok = await authenticator.verifyLoginCode(user.id, challenge, String(req.body.code ?? ''));
    if (!ok) {
      await audit.log('LOGIN_FAILED', { userId: user.id, data: { via: 'DEVICE' } });
      fail('AUTH_FAILED', { reason: 'that code is not valid for this sign-in' });
    }
    await redis.del(key); // single use

    await audit.log('LOGIN_SUCCEEDED', { userId: user.id, data: { via: 'DEVICE' } });
    res.json({
      token: await mintToken(user.id),
      userId: user.id,
      displayName: user.display_name,
    });
  })
);

// ──────────────────────────────────────────────────────────────
// Reads — same data the website shows
// ──────────────────────────────────────────────────────────────

router.get(
  '/me',
  requireSession,
  wrap(async (req, res) => {
    const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.userId]);
    const account = await accountFor(req.userId!);
    res.json({
      userId: rows[0].id,
      email: rows[0].email,
      displayName: rows[0].display_name,
      handle: account.handle,
      balanceMinor: parseInt(account.balance_minor, 10),
      balanceFormatted: formatMinor(account.balance_minor),
    });
  })
);

router.get(
  '/payees',
  requireSession,
  wrap(async (req, res) => {
    const { rows } = await query<AccountRow & { paid_before: string }>(
      `SELECT a.*,
              (SELECT COUNT(*)::text FROM transactions t
                WHERE t.payer_user_id = $1 AND t.payee_account_id = a.id
                  AND t.status = 'SETTLED') AS paid_before
         FROM accounts a
        WHERE a.user_id IS DISTINCT FROM $1
        ORDER BY a.display_name`,
      [req.userId]
    );
    res.json(
      rows.map((a) => ({
        accountId: a.id,
        displayName: a.display_name,
        handle: a.handle,
        knownPayee: parseInt(a.paid_before, 10) > 0,
      }))
    );
  })
);

/** Statement: money out at any status, money in once settled. */
router.get(
  '/transactions',
  requireSession,
  wrap(async (req, res) => {
    const { rows } = await query<TransactionRow & { direction: 'SENT' | 'RECEIVED' }>(
      `SELECT t.*,
              CASE WHEN t.payer_user_id = $1 THEN 'SENT' ELSE 'RECEIVED' END AS direction
         FROM transactions t
        WHERE t.payer_user_id = $1
           OR (t.status = 'SETTLED'
               AND t.payee_account_id IN (SELECT id FROM accounts WHERE user_id = $1))
        ORDER BY t.created_at DESC
        LIMIT 30`,
      [req.userId]
    );
    res.json(
      await Promise.all(
        rows.map(async (tx) => {
          const base = await present(tx);
          if (tx.direction === 'SENT') {
            return {
              ...base,
              direction: 'SENT' as const,
              counterpartyName: base.payeeName,
              counterpartyHandle: base.payeeHandle,
            };
          }
          const { rows: payer } = await query<AccountRow>(
            'SELECT * FROM accounts WHERE id = $1',
            [tx.payer_account_id]
          );
          return {
            ...base,
            direction: 'RECEIVED' as const,
            counterpartyName: payer[0]?.display_name ?? 'Unknown',
            counterpartyHandle: payer[0]?.handle ?? '',
          };
        })
      )
    );
  })
);

router.get(
  '/transactions/:id/timeline',
  requireSession,
  wrap(async (req, res) => {
    const tx = await intentLock.get(req.params.id);
    if (tx.payer_user_id !== req.userId) fail('NOT_FOUND');
    const trail = await audit.trail(tx.id);
    res.json({
      transaction: await present(tx),
      events: trail.map((e) => ({
        at: e.created_at.toISOString(),
        event: e.event_type,
        data: e.event_data,
      })),
    });
  })
);

router.get('/policy', (_req, res) => {
  res.json({
    intentTtlSeconds: policy.intentTtlSeconds,
    qrTtlSeconds: policy.qrTtlSeconds,
    stepUpMaxAttempts: policy.stepUp.maxAttempts,
    highValueMinor: policy.highValueMinor,
    riskThresholds: policy.risk,
  });
});

// ──────────────────────────────────────────────────────────────
// Payment
// ──────────────────────────────────────────────────────────────

router.post(
  '/payment/initiate',
  requireSession,
  wrap(async (req, res) => {
    const payerAccount = await accountFor(req.userId!);
    const result = await intentLock.lock({
      payerUserId: req.userId!,
      payerAccountId: payerAccount.id,
      payeeAccountId: String(req.body.payeeAccountId ?? ''),
      amountMinor: Number(req.body.amountMinor),
    });
    res.status(201).json(await present(await intentLock.get(result.txId)));
  })
);

router.get(
  '/payment/:id',
  requireSession,
  wrap(async (req, res) => {
    const tx = await intentLock.get(req.params.id);
    if (tx.payer_user_id !== req.userId) fail('NOT_FOUND');
    res.json(await present(tx));
  })
);

/**
 * Authorize with the paired device.
 *
 * The six digits are HMAC(device_secret, intent_hash) — bound to this exact
 * transaction, so a captured code is worthless against any other payment, and
 * altering the amount changes the hash and therefore the code. That is the
 * same binding property a passkey signature has.
 *
 * What it does NOT have is the key custody: the device secret is shared with
 * the server, where a passkey's private half never leaves the phone. That is
 * why the chain records DEVICE_APPROVED and not WEBAUTHN_APPROVED, and why
 * the timeline says "Approved on a paired device". The audit trail must never
 * claim a stronger proof than the one that actually happened.
 */
router.post(
  '/payment/:id/authorize',
  requireSession,
  wrap(async (req, res) => {
    const tx = await intentLock.get(req.params.id);

    // 1. Ownership and terminal state.
    if (tx.payer_user_id !== req.userId) fail('NOT_FOUND');
    if (tx.status === 'SETTLED') fail('REPLAY_BLOCKED');
    if (tx.status === 'BLOCKED' || tx.status === 'EXPIRED') {
      fail(tx.status === 'EXPIRED' ? 'INTENT_EXPIRED' : 'RISK_BLOCKED');
    }

    // 2. Expiry.
    if (intentLock.isExpired(tx)) {
      await intentLock.markFailed(tx.id, 'INTENT_EXPIRED', 'EXPIRED');
      fail('INTENT_EXPIRED');
    }

    // 3. Replay — the nonce must still be reserved.
    const nonceState = await intentLock.nonceState(tx.nonce);
    if (nonceState === 'CONSUMED') fail('REPLAY_BLOCKED');
    if (nonceState === null) fail('INTENT_EXPIRED', { reason: 'nonce window closed' });

    // 4. Tamper — the client must be authorizing the exact locked record.
    if (!intentLock.verifyHash(tx, String(req.body.intentHash ?? tx.intent_hash))) {
      await intentLock.markFailed(tx.id, 'TAMPER_BLOCKED', 'BLOCKED');
      fail('TAMPER_BLOCKED');
    }

    const attempt = await attestationChain.startAttempt(tx.id);

    // 5. Proof of possession: the device code over this intent hash.
    const code = String(req.body.code ?? '').trim();
    const ok = await authenticator.verifyPaymentCode(req.userId!, tx.intent_hash, code);
    if (!ok) {
      await audit.log('PAYMENT_BLOCKED', {
        transactionId: tx.id,
        userId: req.userId,
        data: { failureCode: 'AUTH_FAILED', via: 'DEVICE' },
      });
      fail('AUTH_FAILED', { reason: 'that code does not match this payment' });
    }
    // Both the chain and the audit log, because they are read by different
    // things: settlement verifies the chain, and the timeline a user reads is
    // built from the audit trail. A stage in only one of them is invisible in
    // the other, and this is the line that must never be missing.
    // The event name is cast because the web backend's AuditEvent union does
    // not list a mobile-only event, and widening that union would be a change
    // to a file this app deliberately does not own. audit_logs.event_type is
    // TEXT, so the row is valid; the client maps unknown names to their raw
    // form anyway, which is exactly the Future-Card behaviour the timeline
    // was built for.
    await audit.log('DEVICE_APPROVED' as Parameters<typeof audit.log>[0], {
      transactionId: tx.id,
      userId: req.userId,
      data: { via: 'DEVICE', biometricClaimed: req.body.biometric === true },
    });
    await attestationChain.append(tx.id, 'DEVICE_APPROVED', {
      verified: true,
      /*
       * Client-asserted, and labelled as such. expo-local-authentication runs
       * on the phone, so this server cannot verify the biometric happened the
       * way WebAuthn carries user-verification inside the signature. Recorded
       * because it is useful evidence; named `Claimed` because it is not proof.
       */
      biometricClaimed: req.body.biometric === true,
    });

    // 6. Context.
    const snapshot = context.snapshot(req, {});
    const signals = await context.evaluate(
      req.userId!,
      snapshot,
      tx.payee_account_id,
      parseInt(tx.amount_minor, 10)
    );
    await audit.log('CONTEXT_EVALUATED', {
      transactionId: tx.id,
      userId: req.userId,
      data: {
        ...signals,
        deviceFingerprint: snapshot.deviceFingerprint,
        networkSubnet: snapshot.networkSubnet,
        networkPrivate: snapshot.networkPrivate,
        surface: 'MOBILE_APP',
      },
    });
    await attestationChain.append(tx.id, 'CONTEXT_VERIFIED', { ...signals });

    // 7. Risk.
    const risk = await riskEngine.evaluate(tx.id, req.userId!, {
      ...signals,
      amountMinor: parseInt(tx.amount_minor, 10),
    });
    await query(
      `UPDATE transactions SET risk_score = $2, risk_decision = $3, fired_rule_ids = $4 WHERE id = $1`,
      [tx.id, risk.score, risk.decision, risk.firedRuleIds]
    );

    // 8. Policy.
    const hasAuthenticator = await authenticator.hasActiveDevice(req.userId!);
    const decision = await policyFirewall.evaluate({
      tx: { ...tx, risk_score: risk.score },
      signals,
      isDuressCredential: false,
      hasAuthenticator,
    });
    await attestationChain.append(tx.id, 'POLICY_EVALUATED', {
      outcome: decision.outcome,
      firedRules: decision.firedRules.map((r) => r.id),
      policyVersion: decision.policyVersion,
    });

    if (decision.outcome === 'DENY') {
      await intentLock.markFailed(tx.id, 'POLICY_DENIED', 'BLOCKED');
      await audit.log('POLICY_DENIED', {
        transactionId: tx.id,
        userId: req.userId,
        data: { firedRules: decision.firedRules.map((r) => r.id), riskScore: risk.score },
      });
      throw new PrismError(403, 'POLICY_DENIED', 'A payment policy refused this transaction.', {
        rules: decision.firedRules,
        score: risk.score,
      });
    }

    /*
     * Step-up mode, chosen the same way the web backend chooses it: the
     * six-digit transaction code whenever a device is paired, the digits quiz
     * only for accounts that have none.
     *
     * An earlier build hardcoded SEMANTIC here, reasoning that a second HMAC
     * from the phone that just approved proves nothing new. That is true of
     * the FACTOR and false of the CONTROL: it left one payment surface where
     * the answer was two guessable digits while the portal demanded six bound
     * to the intent hash, and an attacker holding a session picks the weaker
     * of the two. One step-up, one keyspace, everywhere.
     *
     * On this surface the code is derived on-device rather than scanned — the
     * phone cannot photograph a QR it is itself displaying. That is possession
     * of the pairing secret plus a fresh biometric, not a second device, and
     * the audit trail says so via surface: 'MOBILE_APP'.
     */
    const semanticDone = await attestationChain.hasStage(tx.id, null, 'SEMANTIC_VERIFIED');
    if (decision.outcome === 'REQUIRE_SEMANTIC' && !semanticDone) {
      const stepUpMode = hasAuthenticator ? 'AUTHENTICATOR' : 'SEMANTIC';
      await query(
        `UPDATE transactions SET status = 'STEP_UP_REQUIRED', step_up_mode = $2 WHERE id = $1`,
        [tx.id, stepUpMode]
      );
      const reasons = [...risk.reasons, ...decision.firedRules.map((r) => r.reason)];

      if (stepUpMode === 'AUTHENTICATOR') {
        const ttl = policy.stepUp.authenticatorTtlSeconds;
        await redis.set(authWindowKey(tx.id), '1', 'EX', ttl);
        await audit.log('STEP_UP_ISSUED', {
          transactionId: tx.id,
          userId: req.userId,
          data: { mode: 'AUTHENTICATOR', expiresInSeconds: ttl, surface: 'MOBILE_APP' },
        });
        res.status(202).json({
          decision: 'STEP_UP',
          mode: 'AUTHENTICATOR',
          score: risk.score,
          reasons,
          expiresInSeconds: ttl,
        });
        return;
      }

      const { rows } = await query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [
        tx.payee_account_id,
      ]);
      const challenge = await semantic.issue(tx, rows[0]?.display_name ?? 'Unknown');
      res.status(202).json({
        decision: 'STEP_UP',
        mode: 'SEMANTIC',
        score: risk.score,
        reasons,
        challenge,
      });
      return;
    }

    await attestationChain.append(tx.id, 'RISK_APPROVED', {
      score: risk.score,
      decision: risk.decision,
      firedRuleIds: risk.firedRuleIds,
    });

    // 9. Settlement capability, minted from the complete chain.
    const required: AuthorizationStage[] = [...REQUIRED_STAGES];
    if (semanticDone) required.push('SEMANTIC_VERIFIED');
    await attestationChain.append(tx.id, 'SETTLEMENT_AUTHORIZED', { mode: 'NORMAL' });
    const capability = await attestationChain.mintCapability(
      tx.id,
      attempt,
      tx.intent_hash,
      required,
      'NORMAL',
      policy.intentTtlSeconds
    );
    await query(`UPDATE transactions SET status = 'AUTHORIZED' WHERE id = $1`, [tx.id]);
    await audit.log('SETTLEMENT_AUTHORIZED', {
      transactionId: tx.id,
      userId: req.userId,
      data: { attempt, mode: 'NORMAL', capabilityId: capability.id, via: 'DEVICE' },
    });

    // 10. Settle — verifies the chain and consumes the capability atomically
    // with the ledger write, exactly as the web path does.
    const result = await settlement.settle(tx, capability);
    await intentLock.consumeNonce(tx.nonce);
    await context.updateBaseline(req.userId!, snapshot);

    res.json({
      decision: 'APPROVED',
      authorizedVia: 'DEVICE',
      score: risk.score,
      reasons: risk.reasons,
      settledAt: result.settledAt.toISOString(),
      balanceMinor: result.payerBalanceMinor,
      balanceFormatted: formatMinor(result.payerBalanceMinor),
    });
  })
);

/**
 * Re-open the acceptance window when the six digits went stale.
 *
 * The window, not the code, is what expires: the code is an HMAC over the
 * intent hash and is therefore the same every time it is derived. Bounding
 * how long the server will ACCEPT it is what keeps a code read off a screen
 * an hour ago from settling anything, and it is enforced here rather than on
 * the phone because the phone is the thing being checked.
 */
router.post(
  '/payment/:id/step-up/window',
  requireSession,
  wrap(async (req, res) => {
    const tx = await intentLock.get(req.params.id);
    if (tx.payer_user_id !== req.userId) fail('NOT_FOUND');
    if (intentLock.isExpired(tx)) fail('INTENT_EXPIRED');
    if (tx.status !== 'STEP_UP_REQUIRED') {
      fail('STEP_UP_FAILED', { reason: 'no step-up is pending for this transaction' });
    }
    if (tx.step_up_mode !== 'AUTHENTICATOR') {
      fail('STEP_UP_FAILED', { reason: 'this transaction is not waiting on a device code' });
    }

    /*
     * Re-opening buys TIME, never ATTEMPTS. The cap lives in its own Redis key
     * counted per transaction, so a caller looping this route to refresh the
     * window still gets exactly three wrong codes before the payment closes.
     */
    const ttl = policy.stepUp.authenticatorTtlSeconds;
    await redis.set(authWindowKey(tx.id), '1', 'EX', ttl);
    await audit.log('STEP_UP_ISSUED', {
      transactionId: tx.id,
      userId: req.userId,
      data: { mode: 'AUTHENTICATOR', expiresInSeconds: ttl, surface: 'MOBILE_APP', reissued: true },
    });
    res.json({ expiresInSeconds: ttl });
  })
);

/**
 * The step-up answer. Passing it requires re-authorizing, same as the web.
 *
 * Two challenges, one route, one attempt counter — mirroring the web backend
 * exactly. AUTHENTICATOR is the six-digit transaction code (every paired
 * account); SEMANTIC is the digits quiz that remains for accounts with no
 * phone. Neither path can be used to escape the other's cap.
 */
router.post(
  '/payment/:id/step-up',
  requireSession,
  wrap(async (req, res) => {
    const tx = await intentLock.get(req.params.id);
    if (tx.payer_user_id !== req.userId) fail('NOT_FOUND');
    if (intentLock.isExpired(tx)) fail('INTENT_EXPIRED');
    if (tx.status !== 'STEP_UP_REQUIRED') {
      fail('STEP_UP_FAILED', { reason: 'no step-up is pending for this transaction' });
    }

    if (tx.step_up_mode === 'AUTHENTICATOR') {
      const live = await redis.get(authWindowKey(tx.id));
      if (!live) {
        fail('STEP_UP_FAILED', {
          reason: 'that code has expired, ask for a new one',
          expired: true,
        });
      }
      const ok = await authenticator.verifyPaymentCode(
        req.userId!,
        tx.intent_hash,
        String(req.body.answer ?? '')
      );
      // Shares the semantic module's cap, audit events and pass flag, so three
      // wrong codes close the transaction exactly as three wrong digits would.
      await semantic.verifyExternal(tx, ok);
      await redis.del(authWindowKey(tx.id)); // single use
    } else {
      await semantic.verify(tx, String(req.body.answer ?? ''));
    }
    const attempt = await attestationChain.currentAttempt(tx.id);
    await attestationChain.append(tx.id, 'SEMANTIC_VERIFIED', { verified: true });
    await audit.log('STEP_UP_PASSED', {
      transactionId: tx.id,
      userId: req.userId,
      data: { attempt, surface: 'MOBILE_APP' },
    });
    await query(
      `UPDATE transactions SET status = 'PENDING' WHERE id = $1 AND status = 'STEP_UP_REQUIRED'`,
      [tx.id]
    );
    res.json({ ok: true, next: 'REAUTHORIZE' });
  })
);

// ──────────────────────────────────────────────────────────────
// QR — where a phone genuinely beats a laptop
// ──────────────────────────────────────────────────────────────

router.post(
  '/qr/request',
  requireSession,
  wrap(async (req, res) => {
    const payeeAccount = await accountFor(req.userId!);
    res
      .status(201)
      .json(await dynamicQr.createRequest(payeeAccount.id, Number(req.body.amountMinor)));
  })
);

router.post(
  '/qr/scan',
  requireSession,
  wrap(async (req, res) => {
    const request = await dynamicQr.scan(String(req.body.token ?? ''));
    const payerAccount = await accountFor(req.userId!);
    if (request.payeeAccountId === payerAccount.id) {
      fail('QR_INVALID_SIGNATURE', { reason: 'cannot pay yourself' });
    }
    const locked = await intentLock.lock({
      payerUserId: req.userId!,
      payerAccountId: payerAccount.id,
      payeeAccountId: request.payeeAccountId,
      amountMinor: request.amountMinor,
    });
    res.status(201).json(await present(await intentLock.get(locked.txId)));
  })
);

// ──────────────────────────────────────────────────────────────
// This device
// ──────────────────────────────────────────────────────────────

router.get(
  '/device',
  requireSession,
  wrap(async (req, res) => {
    const device = await authenticator.describeActive(req.userId!);
    res.json({ paired: device !== null, device });
  })
);

/**
 * Is a step-up waiting on this account right now — from a payment made on
 * the WEB PORTAL, not this app? PRISM App shares the same pairing (it
 * imports `authenticator` from the web backend, same `authenticator_devices`
 * row), so a phone signed in here already holds everything needed to answer
 * one: no separate Authenticator app or second pairing required.
 *
 * Session-authed rather than deviceId-authed like the web backend's twin
 * route, because this app already has a session — it never needs the
 * deviceId workaround a session-less phone would.
 */
router.get(
  '/device/pending',
  requireSession,
  wrap(async (req, res) => {
    const pending = await authenticator.pendingFor(req.userId!);
    res.json(pending ? { pending: true, ...pending } : { pending: false });
  })
);

export default router;
