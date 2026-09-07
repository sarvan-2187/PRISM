import { Router, Request, Response, NextFunction } from 'express';
import { defaultLimiter, strictLimiter } from './middleware/rateLimiter';
import { requireSession, issueSession, clearSession } from './middleware/session';
import { fail, PrismError } from './errors';
import { query } from '../db/pool';
import { AccountRow, TransactionRow, UserRow, formatMinor } from '../db/types';
import { identity } from '../modules/identity/webauthn';
import { intentLock } from '../modules/intent/intentLock';
import { dynamicQr } from '../modules/qr/dynamicQr';
import { context } from '../modules/context/fingerprint';
import { riskEngine } from '../modules/risk/riskEngine';
import { semantic } from '../modules/semantic/intentCheck';
import { settlement } from '../modules/ledger/settlement';
import { audit } from '../modules/audit/logger';
import { policy, disabledControls } from '../config/policy';

const router = Router();
router.use(defaultLimiter);

/** Async route wrapper so a rejected promise reaches the error handler. */
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

/** Server-authoritative view of a transaction. The client renders ONLY this. */
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
  };
}

// ──────────────────────────────────────────────────────────────
// Identity
// ──────────────────────────────────────────────────────────────

router.post(
  '/auth/register/options',
  strictLimiter,
  wrap(async (req, res) => {
    const user = await userByEmail(String(req.body.email ?? ''));
    res.json(await identity.registrationOptions(user));
  })
);

router.post(
  '/auth/register/verify',
  strictLimiter,
  wrap(async (req, res) => {
    const user = await userByEmail(String(req.body.email ?? ''));
    await identity.verifyRegistration(user.id, req.body.response);
    await issueSession(res, user.id);
    res.json({ ok: true, userId: user.id, displayName: user.display_name });
  })
);

router.post(
  '/auth/login/options',
  strictLimiter,
  wrap(async (req, res) => {
    const user = await userByEmail(String(req.body.email ?? ''));
    res.json(await identity.loginOptions(user));
  })
);

router.post(
  '/auth/login/verify',
  strictLimiter,
  wrap(async (req, res) => {
    const user = await userByEmail(String(req.body.email ?? ''));
    await identity.verifyLogin(user.id, req.body.response);
    await issueSession(res, user.id);
    res.json({ ok: true, userId: user.id, displayName: user.display_name });
  })
);

router.post('/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

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
      balanceMinor: parseInt(account.balance_minor, 10),
      balanceFormatted: formatMinor(account.balance_minor),
    });
  })
);

// ──────────────────────────────────────────────────────────────
// Payees
// ──────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────
// Payment
// ──────────────────────────────────────────────────────────────

/** Stage 1 — freeze the intent. */
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
    const tx = await intentLock.get(result.txId);
    res.status(201).json(await present(tx));
  })
);

/** Server-authoritative details. The review screen renders only this. */
router.get(
  '/payment/:id',
  requireSession,
  wrap(async (req, res) => {
    const tx = await intentLock.get(req.params.id);
    if (tx.payer_user_id !== req.userId) fail('NOT_FOUND');
    res.json(await present(tx));
  })
);

/** Stage 2 — issue the assertion challenge. The challenge IS the intent hash. */
router.post(
  '/payment/:id/challenge',
  requireSession,
  wrap(async (req, res) => {
    const tx = await intentLock.get(req.params.id);
    if (tx.payer_user_id !== req.userId) fail('NOT_FOUND');
    if (intentLock.isExpired(tx)) {
      await intentLock.markFailed(tx.id, 'INTENT_EXPIRED', 'EXPIRED');
      fail('INTENT_EXPIRED');
    }
    res.json(await identity.paymentChallenge(req.userId!, tx.id, tx.intent_hash));
  })
);

/**
 * Stage 3 — authorize. The order of these checks is the security design;
 * see docs. Nothing below a step runs until that step has passed, and only
 * the very last step moves money or consumes the nonce.
 */
router.post(
  '/payment/:id/authorize',
  requireSession,
  wrap(async (req, res) => {
    const tx = await intentLock.get(req.params.id);

    // 1. Ownership and state.
    if (tx.payer_user_id !== req.userId) fail('NOT_FOUND');
    if (tx.status === 'SETTLED') fail('REPLAY_BLOCKED');
    if (tx.status === 'BLOCKED' || tx.status === 'EXPIRED') fail(tx.failure_code as 'RISK_BLOCKED');

    // 2. Expiry.
    if (intentLock.isExpired(tx)) {
      await intentLock.markFailed(tx.id, 'INTENT_EXPIRED', 'EXPIRED');
      await audit.log('PAYMENT_BLOCKED', {
        transactionId: tx.id,
        userId: req.userId,
        data: { failureCode: 'INTENT_EXPIRED' },
      });
      fail('INTENT_EXPIRED');
    }

    // 3. Replay — nonce must still be RESERVED.
    const nonceState = await intentLock.nonceState(tx.nonce);
    if (nonceState === 'CONSUMED') {
      await audit.log('PAYMENT_BLOCKED', {
        transactionId: tx.id,
        userId: req.userId,
        data: { failureCode: 'REPLAY_BLOCKED' },
      });
      fail('REPLAY_BLOCKED');
    }
    if (nonceState === null) fail('INTENT_EXPIRED', { reason: 'nonce window closed' });

    // 4. Tamper — recompute the hash from the database and compare.
    const claimedHash = String(req.body.intentHash ?? tx.intent_hash);
    if (!intentLock.verifyHash(tx, claimedHash)) {
      await intentLock.markFailed(tx.id, 'TAMPER_BLOCKED', 'BLOCKED');
      await audit.log('PAYMENT_BLOCKED', {
        transactionId: tx.id,
        userId: req.userId,
        data: { failureCode: 'TAMPER_BLOCKED', claimedHash },
      });
      fail('TAMPER_BLOCKED');
    }

    // 5. Signature over that exact hash.
    await identity.verifyPaymentAssertion(req.userId!, tx.id, tx.intent_hash, req.body.assertion);

    // 6. Context + risk.
    const snapshot = context.snapshot(req, {
      deliberationMs: Number(req.body.deliberationMs) || undefined,
      credentialId: req.body.assertion?.id,
    });
    const signals = await context.evaluate(
      req.userId!,
      snapshot,
      tx.payee_account_id,
      parseInt(tx.amount_minor, 10)
    );
    await audit.log('CONTEXT_EVALUATED', {
      transactionId: tx.id,
      userId: req.userId,
      data: { ...signals },
    });

    const risk = await riskEngine.evaluate(tx.id, req.userId!, {
      ...signals,
      amountMinor: parseInt(tx.amount_minor, 10),
    });

    if (risk.decision === 'BLOCK') {
      await intentLock.markFailed(tx.id, 'RISK_BLOCKED', 'BLOCKED');
      await audit.log('PAYMENT_BLOCKED', {
        transactionId: tx.id,
        userId: req.userId,
        data: { failureCode: 'RISK_BLOCKED', score: risk.score, reasons: risk.reasons },
      });
      throw new PrismError(403, 'RISK_BLOCKED', 'This payment was blocked as high risk.', {
        score: risk.score,
        reasons: risk.reasons,
      });
    }

    if (risk.decision === 'STEP_UP') {
      // No money moves and the nonce is untouched. The transaction stays
      // replayable by nobody and retryable by the genuine user.
      await query(`UPDATE transactions SET status = 'STEP_UP_REQUIRED' WHERE id = $1`, [tx.id]);
      const { rows } = await query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [
        tx.payee_account_id,
      ]);
      const challenge = await semantic.issue(tx, rows[0]?.display_name ?? 'Unknown');
      res.status(202).json({
        decision: 'STEP_UP',
        score: risk.score,
        reasons: risk.reasons,
        challenge,
      });
      return;
    }

    // 7. Settle.
    const result = await settlement.settle(tx);
    await intentLock.consumeNonce(tx.nonce);
    await context.updateBaseline(req.userId!, snapshot);

    res.json({
      decision: 'APPROVED',
      score: risk.score,
      reasons: risk.reasons,
      settledAt: result.settledAt.toISOString(),
      balanceMinor: result.payerBalanceMinor,
      balanceFormatted: formatMinor(result.payerBalanceMinor),
    });
  })
);

/**
 * Semantic step-up. Passing it does NOT authorize the payment: it requires a
 * fresh transaction-bound assertion, which the client obtains by calling
 * /challenge again and re-authorizing.
 */
router.post(
  '/payment/:id/step-up',
  requireSession,
  strictLimiter,
  wrap(async (req, res) => {
    const tx = await intentLock.get(req.params.id);
    if (tx.payer_user_id !== req.userId) fail('NOT_FOUND');
    if (intentLock.isExpired(tx)) fail('INTENT_EXPIRED');

    await semantic.verify(tx, String(req.body.answer ?? ''));
    await query(`UPDATE transactions SET status = 'PENDING' WHERE id = $1`, [tx.id]);

    res.json({ ok: true, next: 'REAUTHORIZE' });
  })
);

// ──────────────────────────────────────────────────────────────
// QR — an authenticated pointer, never a source of truth
// ──────────────────────────────────────────────────────────────

// NOTE (S2 -> S1): these two replace GET /qr/:txId and POST /qr/redeem.
// The old pair had the PAYER minting a QR for their own transaction, which is
// backwards from the fraud in the problem statement (Asha scans the shop's
// code), and POST /qr/redeem had no ownership check, so any signed-in user
// could read any transaction's payee and amount. Sanjay: review and adjust the
// wiring as you see fit — the module contract is createRequest() / scan().

/** Payee side: mint a signed, single-use payment request to display as a QR. */
router.post(
  '/qr/request',
  requireSession,
  wrap(async (req, res) => {
    const payeeAccount = await accountFor(req.userId!);
    res.status(201).json(
      await dynamicQr.createRequest(payeeAccount.id, Number(req.body.amountMinor))
    );
  })
);

/**
 * Payer side: scan a request and lock an intent from it.
 *
 * The payee and amount come from the server's own records, never from the
 * scanned code — so a swapped sticker can point at an attacker but cannot
 * make the attacker look like the shop.
 */
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
// Audit / security timeline
// ──────────────────────────────────────────────────────────────

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

router.get(
  '/transactions',
  requireSession,
  wrap(async (req, res) => {
    const { rows } = await query<TransactionRow>(
      `SELECT * FROM transactions WHERE payer_user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.userId]
    );
    res.json(await Promise.all(rows.map(present)));
  })
);

// ──────────────────────────────────────────────────────────────
// Credential revocation — the stolen-device response
// ──────────────────────────────────────────────────────────────

router.get(
  '/credentials',
  requireSession,
  wrap(async (req, res) => {
    const creds = await identity.credentialsFor(req.userId!);
    res.json(
      creds.map((c) => ({
        id: c.id,
        deviceType: c.device_type,
        createdAt: c.created_at.toISOString(),
        lastUsedAt: c.last_used_at?.toISOString() ?? null,
      }))
    );
  })
);

router.post(
  '/credentials/:id/revoke',
  requireSession,
  wrap(async (req, res) => {
    await identity.revokeCredential(req.userId!, req.params.id);
    res.json({ ok: true });
  })
);

// ──────────────────────────────────────────────────────────────
// Policy — what the system is currently enforcing. Handy in the demo.
// ──────────────────────────────────────────────────────────────

router.get('/policy', (_req, res) => {
  res.json({
    intentTtlSeconds: policy.intentTtlSeconds,
    qrTtlSeconds: policy.qrTtlSeconds,
    stepUpMaxAttempts: policy.stepUp.maxAttempts,
    riskThresholds: policy.risk,
    disabledControls: [...disabledControls()],
  });
});

export default router;
