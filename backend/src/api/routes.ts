import { Router, Request, Response, NextFunction } from 'express';
import { defaultLimiter, strictLimiter } from './middleware/rateLimiter';
import { requireSession, issueSession, clearSession } from './middleware/session';
import { fail, PrismError, FAILURES, FailureCode } from './errors';
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
import { attestationChain } from '../modules/attestation/chain';
import { policyFirewall } from '../modules/policy/firewall';
import { policy, disabledControls } from '../config/policy';
import { AuthorizationStage } from '../db/types';
import { authenticator, PAIRING_TTL_SECONDS } from '../modules/authenticator';
import { keyManager } from '../modules/keys/keyManager';
import redis from '../utils/redis';

/**
 * Marks that an Authenticator code was issued for this transaction, and when.
 *
 * The code itself is derived from the intent hash alone, so it never expires
 * on the phone and a drifted phone clock cannot break it. The WINDOW is
 * enforced here instead: this key exists for policy.stepUp.authenticatorTtlSeconds
 * and its absence is what makes a stale code worthless.
 */
const authWindowKey = (txId: string) => `stepup:auth:${txId}`;

/** Stages every payment must have in its chain before it can settle. */
const REQUIRED_STAGES: AuthorizationStage[] = [
  'INTENT_LOCKED',
  'WEBAUTHN_APPROVED',
  'CONTEXT_VERIFIED',
  'POLICY_EVALUATED',
  'RISK_APPROVED',
  'SETTLEMENT_AUTHORIZED',
];

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

/**
 * Guard on binding a new passkey to an account.
 *
 * The FIRST passkey may be enrolled unauthenticated — there is nothing yet to
 * prove possession of, and the seeded demo users start with none. Every
 * SUBSEQUENT passkey requires an authenticated session, which can only have
 * been obtained by asserting with a passkey the account already holds.
 *
 * Without this, naming a known email was enough: /auth/register/verify looked
 * the user up, bound an attacker-controlled authenticator to them, and handed
 * back a session cookie. `excludeCredentials` does not close it — that is an
 * authenticator-side UX hint, not a server-side deny.
 */
async function assertMayEnrol(user: UserRow, req: Request): Promise<void> {
  const existing = await identity.credentialsFor(user.id);
  if (existing.length === 0) return; // bootstrap: first passkey for this account
  if (req.userId === user.id) return; // possession of an existing passkey already proven
  fail('AUTH_FAILED', {
    reason: 'this account already has a passkey; sign in before enrolling another',
  });
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
    /** Which challenge a stepped-up transaction is waiting on. */
    stepUpMode: tx.step_up_mode,
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
    await assertMayEnrol(user, req);
    res.json(await identity.registrationOptions(user));
  })
);

router.post(
  '/auth/register/verify',
  strictLimiter,
  wrap(async (req, res) => {
    const user = await userByEmail(String(req.body.email ?? ''));
    await assertMayEnrol(user, req);
    await identity.verifyRegistration(user.id, req.body.response);
    await issueSession(res, user.id, req.secure);
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
    await issueSession(res, user.id, req.secure);
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
    if (tx.status === 'BLOCKED' || tx.status === 'EXPIRED') {
      // Re-hitting a transaction that already failed terminally. Return the
      // code it failed with — but only if it is a real catalogue entry, so a
      // missing/unknown failure_code degrades to a sane code instead of
      // throwing a 500 out of fail().
      const code: FailureCode =
        tx.failure_code && tx.failure_code in FAILURES
          ? (tx.failure_code as FailureCode)
          : tx.status === 'EXPIRED'
            ? 'INTENT_EXPIRED'
            : 'RISK_BLOCKED';
      await audit.log('PAYMENT_BLOCKED', {
        transactionId: tx.id,
        userId: req.userId,
        data: { failureCode: code, terminal: true },
      });
      fail(code);
    }

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

    // 4. Tamper — the client must be authorizing the exact locked record.
    // Amount and payee are inside the intent hash, so a captured assertion
    // already cannot be replayed against altered details (the signed bytes
    // differ). We additionally reject outright when the request body carries an
    // amount, payee, or hash that disagrees with the locked transaction, so a
    // swap attempt fails as TAMPER_BLOCKED here rather than as a downstream
    // SIG_INVALID. verifyHash recomputes the hash from the DB columns and
    // timing-safe compares.
    const bodyAmount =
      req.body.amountMinor !== undefined && req.body.amountMinor !== null
        ? Number(req.body.amountMinor)
        : undefined;
    const bodyPayee =
      req.body.payeeAccountId !== undefined && req.body.payeeAccountId !== null
        ? String(req.body.payeeAccountId)
        : undefined;
    const claimedHash = String(req.body.intentHash ?? tx.intent_hash);
    const tampered =
      (bodyAmount !== undefined && bodyAmount !== parseInt(tx.amount_minor, 10)) ||
      (bodyPayee !== undefined && bodyPayee !== tx.payee_account_id) ||
      !intentLock.verifyHash(tx, claimedHash);
    if (tampered) {
      await intentLock.markFailed(tx.id, 'TAMPER_BLOCKED', 'BLOCKED');
      await audit.log('PAYMENT_BLOCKED', {
        transactionId: tx.id,
        userId: req.userId,
        data: { failureCode: 'TAMPER_BLOCKED', claimedHash, bodyAmount, bodyPayee },
      });
      fail('TAMPER_BLOCKED');
    }

    // Every check from here writes one step into the authorization chain. The
    // chain is rooted in tx.intent_hash; settlement later refuses unless it can
    // reverify the whole thing and every mandatory stage is present. A step
    // that never gets written is a mandatory stage that never ran.
    const attempt = await attestationChain.startAttempt(tx.id);

    // 5. Signature over that exact hash.
    await identity.verifyPaymentAssertion(req.userId!, tx.id, tx.intent_hash, req.body.assertion);
    await attestationChain.append(tx.id, 'WEBAUTHN_APPROVED', {
      credentialId: String(req.body.assertion?.id ?? ''),
      verified: true,
    });

    // 6. Context.
    const snapshot = context.snapshot(req, { credentialId: req.body.assertion?.id });
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
        // The device and network PRISM actually examined, recorded the way it
        // stored them: coarse, hashed, readable. Surfaced so the timeline's
        // "examined" step shows what was examined rather than only asserting it.
        deviceFingerprint: snapshot.deviceFingerprint,
        acceptLanguage: snapshot.acceptLanguage,
        networkId: snapshot.networkId,
        networkSubnet: snapshot.networkSubnet,
        networkFamily: snapshot.networkFamily,
        networkPrivate: snapshot.networkPrivate,
      },
    });
    await attestationChain.append(tx.id, 'CONTEXT_VERIFIED', { ...signals });

    // Was this attempt approved with a duress passkey? The credential is
    // indistinguishable to anyone watching the screen; the server knows which
    // one signed.
    const credRow = await query<{ is_duress: boolean }>(
      'SELECT is_duress FROM credentials WHERE id = $1 AND user_id = $2',
      [String(req.body.assertion?.id ?? ''), req.userId]
    );
    const isDuressCredential = credRow.rows[0]?.is_duress === true;

    // 7. Risk (needed before policy — the RISK_BLOCK_THRESHOLD rule reads the score).
    const risk = await riskEngine.evaluate(tx.id, req.userId!, {
      ...signals,
      amountMinor: parseInt(tx.amount_minor, 10),
    });
    await query(`UPDATE transactions SET risk_score = $2, risk_decision = $3, fired_rule_ids = $4 WHERE id = $1`, [
      tx.id,
      risk.score,
      risk.decision,
      risk.firedRuleIds,
    ]);
    const scoredTx = { ...tx, risk_score: risk.score };

    // 8. Policy firewall. Its decision cites rules, not a score.
    // A paired phone changes what an elevated score, a large amount or a
    // daily cap MEANS: escalate to the second device rather than refuse. Read
    // once here so the policy rules stay pure functions of their context.
    const hasAuthenticator = await authenticator.hasActiveDevice(req.userId!);
    const decision = await policyFirewall.evaluate({
      tx: scoredTx,
      signals,
      isDuressCredential,
      hasAuthenticator,
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
        userId: req.userId,
        data: { firedRules: decision.firedRules.map((r) => r.id), riskScore: risk.score },
      });
      throw new PrismError(403, 'POLICY_DENIED', 'A payment policy refused this transaction.', {
        rules: decision.firedRules,
        score: risk.score,
      });
    }

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

    // Semantic verification is required only when the transaction's details
    // changed after it was locked (policy REQUIRE_SEMANTIC). A high-risk
    // transaction whose details did NOT change is refused by the ELEVATED_RISK
    // policy rule above, not sent round a comprehension quiz.
    // Checked across the whole transaction: a step-up passed in an earlier
    // attempt still counts, because the change it confirmed has not changed.
    const semanticDone = await attestationChain.hasStage(tx.id, null, 'SEMANTIC_VERIFIED');
    const needsSemantic = decision.outcome === 'REQUIRE_SEMANTIC';
    if (needsSemantic && !semanticDone) {
      /*
       * Which challenge this transaction waits on. A paired phone replaces the
       * last-two-digits quiz entirely: the six digits are an HMAC over this
       * transaction's own intent hash, produced on hardware the attacker does
       * not hold. The quiz remains for accounts with no phone, so nobody is
       * dead-ended by not owning one.
       */
      const stepUpMode = hasAuthenticator ? 'AUTHENTICATOR' : 'SEMANTIC';
      await query(
        `UPDATE transactions SET status = 'STEP_UP_REQUIRED', step_up_mode = $2 WHERE id = $1`,
        [tx.id, stepUpMode]
      );
      const { rows } = await query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [
        tx.payee_account_id,
      ]);
      const challenge = await semantic.issue(tx, rows[0]?.display_name ?? 'Unknown');
      res.status(202).json({
        decision: decision.outcome === 'REQUIRE_SEMANTIC' ? 'CONFIRM_CHANGE' : 'STEP_UP',
        mode: stepUpMode,
        score: risk.score,
        reasons: [...risk.reasons, ...decision.firedRules.map((r) => r.reason)],
        changes: challenge.changes ?? null,
        challenge,
      });
      return;
    }

    await attestationChain.append(tx.id, 'RISK_APPROVED', {
      score: risk.score,
      decision: risk.decision,
      firedRuleIds: risk.firedRuleIds,
    });

    // 9. Settlement authorization: mint the capability from the complete chain.
    const mode: 'NORMAL' | 'DURESS' = decision.outcome === 'DURESS_HOLD' ? 'DURESS' : 'NORMAL';
    const required: AuthorizationStage[] = [...REQUIRED_STAGES];
    if (needsSemantic || semanticDone) required.push('SEMANTIC_VERIFIED');
    await attestationChain.append(tx.id, 'SETTLEMENT_AUTHORIZED', { mode });
    const capability = await attestationChain.mintCapability(
      tx.id,
      attempt,
      tx.intent_hash,
      required,
      mode,
      policy.intentTtlSeconds
    );
    await query(`UPDATE transactions SET status = 'AUTHORIZED' WHERE id = $1`, [tx.id]);
    await audit.log('SETTLEMENT_AUTHORIZED', {
      transactionId: tx.id,
      userId: req.userId,
      data: { attempt, mode, capabilityId: capability.id },
    });

    // 10. Settle — verifies the chain and consumes the capability atomically
    // with the ledger write.
    const result = await settlement.settle(tx, capability);
    await intentLock.consumeNonce(tx.nonce);
    if (result.mode === 'NORMAL') await context.updateBaseline(req.userId!, snapshot);

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

    // Only a transaction the risk engine actually sent to step-up may be
    // answered. markFailed does not clear the Redis step-up record, so without
    // this check a still-live challenge could be answered on a BLOCKED
    // transaction to walk it back to PENDING and re-authorize it.
    if (tx.status !== 'STEP_UP_REQUIRED') {
      fail('STEP_UP_FAILED', { reason: 'no step-up is pending for this transaction' });
    }

    /*
     * Two challenges, one route, one attempt counter.
     *
     * AUTHENTICATOR is the paired-phone code; SEMANTIC is the digits quiz for
     * accounts with no phone. Neither path can be used to escape the other's
     * cap, and both end in the same place.
     */
    if (tx.step_up_mode === 'AUTHENTICATOR') {
      // The 60-second window, enforced here rather than on the phone.
      const live = await redis.get(authWindowKey(tx.id));
      if (!live) {
        fail('STEP_UP_FAILED', {
          reason: 'that code has expired, ask the portal for a new one',
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

    // Record comprehension on the chain, in the attempt that is mid-flight. The
    // re-authorization then finds SEMANTIC_VERIFIED present and can mint a
    // capability that lists it as satisfied — this is what makes step-up an
    // actual precondition of settlement rather than a detour.
    const attempt = await attestationChain.currentAttempt(tx.id);
    // On the SEMANTIC path the client re-authorizes, which opens a new attempt
    // and writes RISK_APPROVED there, so the stage goes on the chain now. On
    // the AUTHENTICATOR path this route finishes the SAME attempt, and the
    // chain requires RISK_APPROVED before SEMANTIC_VERIFIED — so that ordering
    // is handled below, after the risk engine has actually run again.
    if (tx.step_up_mode !== 'AUTHENTICATOR') {
      await attestationChain.append(tx.id, 'SEMANTIC_VERIFIED', { verified: true });
    }
    await audit.log('STEP_UP_PASSED', { transactionId: tx.id, userId: req.userId, data: { attempt } });

    // Guarded so a concurrent block cannot be undone by this write.
    await query(
      `UPDATE transactions SET status = 'PENDING'
        WHERE id = $1 AND status = 'STEP_UP_REQUIRED'`,
      [tx.id]
    );

    /*
     * The phone code COMPLETES the payment. There is no second passkey prompt.
     *
     * Asking for the passkey again would prove possession of the laptop that
     * already signed thirty seconds ago — it adds a tap, not a factor. The
     * code proves possession of separate hardware, which is the thing the
     * first signature could not establish, so it is the stronger second
     * factor and it finishes the authorization on its own.
     *
     * Everything after this point is the same pipeline /authorize runs, minus
     * the signature check: the same context evaluation, the same risk engine,
     * the same policy firewall, the same chain verification and the same
     * atomic settlement. Nothing is skipped, and the WEBAUTHN_APPROVED stage
     * from this very attempt is still what roots the chain.
     */
    if (tx.step_up_mode !== 'AUTHENTICATOR') {
      // Digits path is unchanged: it re-authorizes with the passkey, because
      // the quiz alone proves nothing about who is holding the device.
      res.json({ ok: true, next: 'REAUTHORIZE' });
      return;
    }

    /*
     * CONTEXT_VERIFIED and POLICY_EVALUATED are already on this attempt's
     * chain, written by the authorize call that asked for the step-up. They
     * are not re-appended: the chain forbids a stage repeating out of order,
     * and re-verifying the same context would not make it more true. The
     * checks below still RUN — their results just gate the settlement rather
     * than adding links.
     */
    const attempt2 = await attestationChain.currentAttempt(tx.id);
    const snapshot2 = context.snapshot(req, {});
    const signals2 = await context.evaluate(
      req.userId!,
      snapshot2,
      tx.payee_account_id,
      parseInt(tx.amount_minor, 10)
    );

    const risk2 = await riskEngine.evaluate(tx.id, req.userId!, {
      ...signals2,
      amountMinor: parseInt(tx.amount_minor, 10),
    });
    await query(
      `UPDATE transactions SET risk_score = $2, risk_decision = $3, fired_rule_ids = $4 WHERE id = $1`,
      [tx.id, risk2.score, risk2.decision, risk2.firedRuleIds]
    );

    /*
     * Re-run the firewall with the step-up now satisfied. A rule that still
     * DENIES here denies for a reason the phone code cannot answer — a daily
     * cap, a blocked payee — and the code proving possession of the device
     * does not make those go away.
     */
    const decision2 = await policyFirewall.evaluate({
      tx: { ...tx, risk_score: risk2.score },
      signals: signals2,
      isDuressCredential: false,
      hasAuthenticator: true,
    });
    if (decision2.outcome === 'DENY') {
      await intentLock.markFailed(tx.id, 'POLICY_DENIED', 'BLOCKED');
      await audit.log('POLICY_DENIED', {
        transactionId: tx.id,
        userId: req.userId,
        data: { firedRules: decision2.firedRules.map((r) => r.id), riskScore: risk2.score },
      });
      throw new PrismError(403, 'POLICY_DENIED', 'A payment policy refused this transaction.', {
        rules: decision2.firedRules,
        score: risk2.score,
      });
    }

    // Order matters and is enforced by the chain: risk, then the step-up that
    // answered it, then the authorization to settle.
    await attestationChain.append(tx.id, 'RISK_APPROVED', {
      score: risk2.score,
      decision: risk2.decision,
      firedRuleIds: risk2.firedRuleIds,
    });
    await attestationChain.append(tx.id, 'SEMANTIC_VERIFIED', {
      verified: true,
      via: 'AUTHENTICATOR',
    });

    const required2: AuthorizationStage[] = [...REQUIRED_STAGES, 'SEMANTIC_VERIFIED'];
    await attestationChain.append(tx.id, 'SETTLEMENT_AUTHORIZED', { mode: 'NORMAL' });
    const capability2 = await attestationChain.mintCapability(
      tx.id,
      attempt2,
      tx.intent_hash,
      required2,
      'NORMAL',
      policy.intentTtlSeconds
    );
    await query(`UPDATE transactions SET status = 'AUTHORIZED' WHERE id = $1`, [tx.id]);
    await audit.log('SETTLEMENT_AUTHORIZED', {
      transactionId: tx.id,
      userId: req.userId,
      data: { attempt: attempt2, mode: 'NORMAL', capabilityId: capability2.id, via: 'AUTHENTICATOR' },
    });

    const settled = await settlement.settle(tx, capability2);
    await intentLock.consumeNonce(tx.nonce);
    await context.updateBaseline(req.userId!, snapshot2);

    res.json({
      ok: true,
      next: 'SETTLED',
      decision: 'APPROVED',
      score: risk2.score,
      reasons: risk2.reasons,
      settledAt: settled.settledAt.toISOString(),
      balanceMinor: settled.payerBalanceMinor,
      balanceFormatted: formatMinor(settled.payerBalanceMinor),
    });
  })
);

/**
 * The signed challenge the PRISM Authenticator scans.
 *
 * Signed, not plain, because the app renders the payee and amount from it so
 * the user can compare them against the portal. An unsigned token would let
 * anyone who can draw a QR choose what the second device displays, which is
 * precisely the fraud the second device exists to catch. The phone verifies it
 * with the public key from /.well-known/prism-keys and needs no network after.
 *
 * Issuing also opens the 60-second acceptance window.
 */
router.get(
  '/payment/:id/step-up/token',
  requireSession,
  wrap(async (req, res) => {
    const tx = await intentLock.get(req.params.id);
    if (tx.payer_user_id !== req.userId) fail('NOT_FOUND');
    if (tx.status !== 'STEP_UP_REQUIRED') {
      fail('STEP_UP_FAILED', { reason: 'no step-up is pending for this transaction' });
    }
    if (tx.step_up_mode !== 'AUTHENTICATOR') {
      fail('STEP_UP_FAILED', { reason: 'this transaction is not waiting on a paired device' });
    }

    const ttl = policy.stepUp.authenticatorTtlSeconds;
    const { rows } = await query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [
      tx.payee_account_id,
    ]);
    const seen = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM transactions
        WHERE payer_user_id = $1 AND payee_account_id = $2 AND status = 'SETTLED'`,
      [req.userId, tx.payee_account_id]
    );

    const token = await keyManager.signQrToken(
      {
        txId: tx.id,
        intentHash: tx.intent_hash,
        payee: rows[0]?.display_name ?? 'Unknown',
        payeeIsNew: parseInt(seen.rows[0].n, 10) === 0,
        amountMinor: parseInt(tx.amount_minor, 10),
        currency: tx.currency,
        score: tx.risk_score,
        reasons: tx.risk_reasons,
      },
      ttl
    );

    await redis.set(authWindowKey(tx.id), '1', 'EX', ttl);
    await audit.log('STEP_UP_ISSUED', {
      transactionId: tx.id,
      userId: req.userId,
      data: { mode: 'AUTHENTICATOR', expiresInSeconds: ttl },
    });

    res.json({ token, expiresInSeconds: ttl });
  })
);

// ──────────────────────────────────────────────────────────────
// PRISM Authenticator — the paired second device
// ──────────────────────────────────────────────────────────────

/**
 * Mint a PENDING device and its secret.
 *
 * The secret is RETURNED so the portal can draw it as a QR, and is never
 * accepted back from the phone: on a plain-HTTP LAN a secret POSTed by the
 * phone would be readable on the wire. Same shape as an otpauth:// URI.
 */
router.post(
  '/authenticator/pair/start',
  requireSession,
  strictLimiter,
  wrap(async (req, res) => {
    const offer = await authenticator.startPairing(req.userId!);
    await audit.log('AUTHENTICATOR_PAIR_STARTED', {
      userId: req.userId,
      data: { deviceId: offer.deviceId, expiresInSeconds: PAIRING_TTL_SECONDS }, // never the secret
    });
    res.status(201).json(offer);
  })
);

router.post(
  '/authenticator/pair/confirm',
  requireSession,
  strictLimiter,
  wrap(async (req, res) => {
    const ok = await authenticator.confirmPairing(req.userId!, String(req.body.deviceId ?? ''));
    if (!ok) fail('AUTH_FAILED', { reason: 'no pending pairing for this account, or it expired' });
    await audit.log('AUTHENTICATOR_PAIRED', {
      userId: req.userId,
      data: { deviceId: req.body.deviceId },
    });
    res.json({ ok: true });
  })
);

/** Does this account have a second device? Drives the settings screen. */
router.get(
  '/authenticator',
  requireSession,
  wrap(async (req, res) => {
    const device = await authenticator.describeActive(req.userId!);
    res.json({ paired: device !== null, device });
  })
);

/** Lost phone. One-way, exactly like revoking a passkey. */
router.post(
  '/authenticator/revoke',
  requireSession,
  wrap(async (req, res) => {
    const revoked = await authenticator.revokeActive(req.userId!);
    if (!revoked) fail('NOT_FOUND', { reason: 'no active authenticator device' });
    await audit.log('AUTHENTICATOR_REVOKED', { userId: req.userId, data: {} });
    res.json({ ok: true });
  })
);

/**
 * Amend a locked intent. The amount or recipient cannot be edited in place —
 * that would defeat the whole point of freezing them — so this supersedes the
 * old transaction with a new one that links back to it. The new transaction
 * carries amended_from, which makes the policy firewall require semantic
 * confirmation of the change before it can settle.
 */
router.post(
  '/payment/:id/amend',
  requireSession,
  wrap(async (req, res) => {
    const prior = await intentLock.get(req.params.id);
    if (prior.payer_user_id !== req.userId) fail('NOT_FOUND');
    if (!['PENDING', 'STEP_UP_REQUIRED'].includes(prior.status)) {
      fail('REPLAY_BLOCKED', { reason: `cannot amend a ${prior.status} transaction` });
    }
    if (intentLock.isExpired(prior)) fail('INTENT_EXPIRED');

    const payerAccount = await accountFor(req.userId!);
    const amountMinor =
      req.body.amountMinor !== undefined ? Number(req.body.amountMinor) : parseInt(prior.amount_minor, 10);
    const payeeAccountId = String(req.body.payeeAccountId ?? prior.payee_account_id);
    if (amountMinor === parseInt(prior.amount_minor, 10) && payeeAccountId === prior.payee_account_id) {
      fail('INVALID_AMOUNT', { reason: 'amendment changes nothing' });
    }

    const locked = await intentLock.lock({
      payerUserId: req.userId!,
      payerAccountId: payerAccount.id,
      payeeAccountId,
      amountMinor,
      amendedFrom: prior.id,
    });
    await intentLock.markSuperseded(prior.id);
    await audit.log('INTENT_AMENDED', {
      transactionId: locked.txId,
      userId: req.userId,
      data: { amendedFrom: prior.id, amountMinor, payeeAccountId },
    });

    const tx = await intentLock.get(locked.txId);
    res.status(201).json(await present(tx));
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
// Duress — a second passkey enrolled while safe. Signing a payment with it
// looks identical to anyone watching, but the payment is held in quarantine
// and an alert is raised.
// ──────────────────────────────────────────────────────────────

router.post(
  '/credentials/duress/options',
  requireSession,
  wrap(async (req, res) => {
    // The session already proves the user holds a passkey (they logged in with
    // one). Enrolling the duress key is just another registration.
    const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.userId]);
    res.json(await identity.registrationOptions(rows[0]));
  })
);

router.post(
  '/credentials/duress/verify',
  requireSession,
  wrap(async (req, res) => {
    const credentialId = await identity.verifyRegistration(req.userId!, req.body.response);
    await identity.markDuress(req.userId!, credentialId);
    await audit.log('PASSKEY_REGISTERED', {
      userId: req.userId,
      data: { credentialId, duress: true },
    });
    res.json({ ok: true, credentialId });
  })
);

/**
 * Release a payment that was held under duress. Requires a fresh assertion from
 * a NON-duress credential — the coercer cannot do this. The held funds either
 * go on to the original payee or come back to the payer.
 */
router.post(
  '/transactions/:id/release',
  requireSession,
  strictLimiter,
  wrap(async (req, res) => {
    const tx = await intentLock.get(req.params.id);
    if (tx.payer_user_id !== req.userId) fail('NOT_FOUND');
    if (tx.status !== 'DURESS_HELD') fail('REPLAY_BLOCKED', { reason: 'transaction is not on hold' });

    // Prove possession with a normal passkey. The challenge is the intent hash,
    // same as a payment, and the credential must not be a duress one.
    await identity.verifyPaymentAssertion(req.userId!, tx.id, tx.intent_hash, req.body.assertion);
    const credRow = await query<{ is_duress: boolean }>(
      'SELECT is_duress FROM credentials WHERE id = $1',
      [String(req.body.assertion?.id ?? '')]
    );
    if (credRow.rows[0]?.is_duress) {
      fail('AUTH_FAILED', { reason: 'a duress credential cannot release a held payment' });
    }

    const forward = req.body.action !== 'refund'; // default: send to the payee
    const result = await settlement.releaseDuress(tx, forward);
    await audit.log('DURESS_RELEASED', {
      transactionId: tx.id,
      userId: req.userId,
      data: { action: forward ? 'forwarded' : 'refunded' },
    });
    res.json({ ok: true, action: forward ? 'forwarded' : 'refunded', ...result });
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
