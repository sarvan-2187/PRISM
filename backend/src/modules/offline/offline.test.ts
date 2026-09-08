/**
 * Self-check for offline authorization.  Run: npm run test:offline
 *
 * BLACKOUT (FC-01-A): a payment is under way, the device drops offline
 * mid-flight, and authentication must still complete locally and stay
 * replay-proof when connectivity returns.
 *
 * The scenario each case exercises is the real one: a transaction is locked
 * ONLINE the ordinary way (the same intentLock.lock() every payment uses),
 * then approved with no server — a signature over the intent hash the
 * server already handed over — and redeemed afterwards.
 *
 * Case 3 is the one that was broken: an approval that arrives after the
 * 90-second intent window has closed. Every real blackout outlives that
 * window, so rejecting it made the whole feature unusable.
 *
 * Needs Postgres and Redis (docker compose up -d) and the seed applied.
 * Every row this creates is deleted on exit and balances are restored.
 */
import assert from 'node:assert/strict';
import crypto from 'crypto';
import type { Request } from 'express';
import pool, { query, getClient } from '../../db/pool';
import redis from '../../utils/redis';
import { offlineGrant, GrantBody } from './grant';
import { offlineRedeem } from './redeem';
import { intentLock } from '../intent/intentLock';
import { attestationChain } from '../attestation/chain';
import { intentHash } from '../../utils/canonical';
import { generateNonce } from '../../utils/crypto';
import { PrismError } from '../../api/errors';
import { policy } from '../../config/policy';
import { createSoftCredential, SoftCredential } from '../identity/softAuthenticator';

const rejectsWith = (code: string) => (err: unknown) => {
  assert.ok(err instanceof PrismError, `expected PrismError, got ${err}`);
  assert.equal(err.failureCode, code, `expected ${code}, got ${err.failureCode} (${err.message})`);
  return true;
};

const CLEANUP = { txIds: [] as string[], grantIds: [] as string[], credIds: [] as string[] };

let ashaUserId = '';
let ashaAccountId = '';
let priyaAccountId = '';
let rajeshAccountId = '';
let ashaBalance0 = 0n;
let priyaBalance0 = 0n;
let cred: SoftCredential;

function fakeReq(userId: string, body: unknown): Request {
  return {
    userId,
    body,
    headers: { 'user-agent': 'prism-offline-test/1.0', 'accept-language': 'en-IN' },
    ip: '127.0.0.1',
    params: {},
  } as unknown as Request;
}

/** Lock a payment the ordinary ONLINE way — exactly what /payment/initiate does. */
async function lockPayment(payeeAccountId: string, amountMinor: number) {
  const locked = await intentLock.lock({
    payerUserId: ashaUserId,
    payerAccountId: ashaAccountId,
    payeeAccountId,
    amountMinor,
  });
  CLEANUP.txIds.push(locked.txId);
  return locked;
}

/**
 * The same lock, but as it would look `agoSeconds` in the past.
 *
 * It has to be built this way rather than by UPDATE-ing the timestamps
 * afterwards: createdAt and expiresAt are inside the intent hash, so editing
 * them post-hoc makes the row stop hashing to its own intent_hash and
 * verifyHash correctly refuses it. Mirrors intentLock.lock() — row, chain
 * root and reserved nonce — with an older clock.
 */
async function lockPaymentInThePast(payeeAccountId: string, amountMinor: number, agoSeconds: number) {
  const txId = crypto.randomUUID();
  const nonce = generateNonce();
  const createdAt = Math.floor(Date.now() / 1000) - agoSeconds;
  const expiresAt = createdAt + policy.intentTtlSeconds;
  const hash = intentHash({
    amountMinor,
    createdAt,
    currency: policy.currency,
    expiresAt,
    lockVersion: 1,
    nonce,
    payeeAccountId,
    payerUserId: ashaUserId,
    txId,
  });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO transactions
         (id, payer_user_id, payer_account_id, payee_account_id, amount_minor,
          currency, intent_hash, nonce, lock_version, created_at, expires_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,to_timestamp($9),to_timestamp($10),'PENDING')`,
      [
        txId,
        ashaUserId,
        ashaAccountId,
        payeeAccountId,
        amountMinor,
        policy.currency,
        hash,
        nonce,
        createdAt,
        expiresAt,
      ]
    );
    await attestationChain.append(
      txId,
      'INTENT_LOCKED',
      { amountMinor, payeeAccountId, currency: policy.currency, createdAt, expiresAt },
      { client }
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await redis.set(`nonce:${nonce}`, 'RESERVED', 'EX', policy.nonceTtlSeconds);

  CLEANUP.txIds.push(txId);
  return { txId, intentHash: hash };
}

/**
 * What the device does during the blackout: sign the intent hash it already
 * holds. No network, no server-side state, nothing invented locally.
 */
function signOffline(token: string, txId: string, intentHash: string, signer: SoftCredential) {
  return {
    token,
    txId,
    intentHash,
    assertion: signer.sign(intentHash),
    approvedAt: Math.floor(Date.now() / 1000),
  };
}

async function setup(): Promise<void> {
  const u = await query<{ id: string }>(`SELECT id FROM users WHERE email = 'asha@prism.demo'`);
  assert.ok(u.rows[0], 'seed missing — run npm run db:seed');
  ashaUserId = u.rows[0].id;

  const pa = await query<{ id: string; balance_minor: string }>(
    `SELECT id, balance_minor FROM accounts WHERE user_id = $1 ORDER BY created_at LIMIT 1`,
    [ashaUserId]
  );
  ashaAccountId = pa.rows[0].id;
  ashaBalance0 = BigInt(pa.rows[0].balance_minor);

  const pe = await query<{ id: string; balance_minor: string }>(
    `SELECT id, balance_minor FROM accounts WHERE handle = 'priya@prism'`
  );
  priyaAccountId = pe.rows[0].id;
  priyaBalance0 = BigInt(pe.rows[0].balance_minor);

  const ra = await query<{ id: string }>(`SELECT id FROM accounts WHERE handle = 'rajesh@prism'`);
  rajeshAccountId = ra.rows[0].id;

  cred = createSoftCredential(ashaUserId);
  CLEANUP.credIds.push(cred.credentialId);
  await query(
    `INSERT INTO credentials (id, user_id, public_key, counter, device_type, backed_up, transports)
     VALUES ($1, $2, $3, 0, 'singleDevice', false, '{internal}')`,
    [cred.credentialId, ashaUserId, cred.cosePublicKey]
  );
}

async function main(): Promise<void> {
  await setup();

  const { grant, token } = await offlineGrant.issue(ashaUserId, ashaAccountId);
  CLEANUP.grantIds.push(grant.grantId);
  assert.ok(
    grant.allowedPayees.some((p) => p.accountId === priyaAccountId),
    'setup: Priya must be an allowed offline payee (the seed gives Asha settled history with her)'
  );
  assert.ok(
    grant.credentialIds.includes(cred.credentialId),
    "grant pins this session's active non-duress credential"
  );

  // 1. The card's actual scenario: locked online, approved with no server,
  //    settles on reconnect.
  {
    const locked = await lockPayment(priyaAccountId, 200000); // ₹2,000
    const voucher = signOffline(token, locked.txId, locked.intentHash, cred);
    const result = await offlineRedeem.redeem(fakeReq(ashaUserId, voucher));
    assert.equal(result.decision, 'APPROVED', '1: an offline approval settles on reconnect');

    const tx = await query<{ status: string; authorized_offline: boolean }>(
      `SELECT status, authorized_offline FROM transactions WHERE id = $1`,
      [locked.txId]
    );
    assert.equal(tx.rows[0].status, 'SETTLED', '1: status SETTLED');
    assert.equal(tx.rows[0].authorized_offline, true, '1: flagged as authorized offline');

    // 2. Replay: the same captured voucher, resubmitted after reconnect.
    await assert.rejects(
      () => offlineRedeem.redeem(fakeReq(ashaUserId, voucher)),
      rejectsWith('REPLAY_BLOCKED'),
      '2: a captured offline approval cannot be redeemed twice'
    );
  }

  // 3. THE REGRESSION: the blackout outlasted the 90-second intent window.
  //    This is what made every honest offline payment fail before.
  {
    const locked = await lockPaymentInThePast(
      priyaAccountId,
      150000, // ₹1,500
      policy.intentTtlSeconds + 120
    );
    const aged = await intentLock.get(locked.txId);
    assert.equal(intentLock.isExpired(aged), true, "3: setup — the intent's own window has closed");

    const voucher = signOffline(token, locked.txId, locked.intentHash, cred);
    const result = await offlineRedeem.redeem(fakeReq(ashaUserId, voucher));
    assert.equal(
      result.decision,
      'APPROVED',
      '3: an approval older than the intent window still settles'
    );
    assert.ok(result.lateBySeconds > 0, '3: the lag is measured and reported, not hidden');
  }

  // 4. Tamper: a voucher pointed at a different transaction than the one
  //    whose hash was signed.
  {
    const a = await lockPayment(priyaAccountId, 100000);
    const b = await lockPayment(priyaAccountId, 400000);
    const crossed = signOffline(token, b.txId, a.intentHash, cred);
    await assert.rejects(
      () => offlineRedeem.redeem(fakeReq(ashaUserId, crossed)),
      rejectsWith('TAMPER_BLOCKED'),
      '4: a hash from another transaction cannot authorize this one'
    );
  }

  // 5. A payee the grant never covered (never settled with, so not on the
  //    allow-list) cannot be paid offline at all.
  {
    const locked = await lockPayment(rajeshAccountId, 100000);
    assert.ok(
      !grant.allowedPayees.some((p) => p.accountId === rajeshAccountId),
      'setup: Rajesh must NOT be an allowed offline payee'
    );
    const voucher = signOffline(token, locked.txId, locked.intentHash, cred);
    await assert.rejects(
      () => offlineRedeem.redeem(fakeReq(ashaUserId, voucher)),
      rejectsWith('TAMPER_BLOCKED'),
      '5: a payee outside the grant cannot be paid offline'
    );
  }

  // 6. Over the offline cap.
  {
    const locked = await lockPayment(priyaAccountId, grant.maxAmountMinor + 100);
    const voucher = signOffline(token, locked.txId, locked.intentHash, cred);
    await assert.rejects(
      () => offlineRedeem.redeem(fakeReq(ashaUserId, voucher)),
      rejectsWith('TAMPER_BLOCKED'),
      '6: an amount over the sealed cap cannot settle offline'
    );
  }

  // 7. Grant past its window AND its reconnect grace.
  {
    const dead: GrantBody = {
      ...grant,
      notAfter: Math.floor(Date.now() / 1000) - policy.offline.redeemGraceSeconds - 10,
    };
    await assert.rejects(
      () => offlineGrant.assertLive(dead),
      rejectsWith('GRANT_EXPIRED'),
      '7: a grant past its window and grace is refused'
    );
    // ...but still live inside the grace, which is what lets a slow
    // reconnect settle at all.
    const late: GrantBody = { ...grant, notAfter: Math.floor(Date.now() / 1000) - 5 };
    await offlineGrant.assertLive(late);
  }

  // 8. Grant body edited, MAC left as the original's.
  {
    const [bodyB64, mac] = token.split('.');
    const edited: GrantBody = { ...grant, maxAmountMinor: 100_00_00000 };
    const forged = `${Buffer.from(JSON.stringify(edited), 'utf8').toString('base64url')}.${mac}`;
    assert.throws(
      () => offlineGrant.verify(forged),
      rejectsWith('GRANT_INVALID'),
      '8: MAC catches the edit'
    );
    assert.throws(
      () => offlineGrant.verify(`${bodyB64}.not-a-real-mac`),
      rejectsWith('GRANT_INVALID'),
      '8b: a forged MAC is refused'
    );
  }

  // 9. Revoked after arming, before redemption — the stolen-device response
  //    still wins over an approval that credential already signed.
  {
    const locked = await lockPayment(priyaAccountId, 100000);
    const voucher = signOffline(token, locked.txId, locked.intentHash, cred);
    await query(`UPDATE credentials SET revoked_at = NOW() WHERE id = $1`, [cred.credentialId]);
    try {
      await assert.rejects(
        () => offlineRedeem.redeem(fakeReq(ashaUserId, voucher)),
        rejectsWith('AUTH_FAILED'),
        '9: a voucher signed by a now-revoked credential must not settle'
      );
    } finally {
      await query(`UPDATE credentials SET revoked_at = NULL WHERE id = $1`, [cred.credentialId]);
    }
  }

  console.log('offline.test.ts: all assertions passed');
}

async function cleanup(): Promise<void> {
  const { txIds, grantIds, credIds } = CLEANUP;
  if (txIds.length) {
    await query(`DELETE FROM settlement_capabilities WHERE transaction_id = ANY($1)`, [txIds]);
    await query(`DELETE FROM authorization_steps WHERE transaction_id = ANY($1)`, [txIds]);
    await query(`DELETE FROM ledger_entries WHERE transaction_id = ANY($1)`, [txIds]);
    await query(`DELETE FROM offline_vouchers WHERE tx_id = ANY($1)`, [txIds]);
  }
  if (grantIds.length) {
    await query(`DELETE FROM offline_vouchers WHERE grant_id = ANY($1)`, [grantIds]);
  }
  if (txIds.length) {
    await query(`DELETE FROM audit_logs WHERE transaction_id = ANY($1)`, [txIds]);
    await query(`DELETE FROM transactions WHERE id = ANY($1)`, [txIds]);
  }
  if (grantIds.length) await query(`DELETE FROM offline_grants WHERE id = ANY($1)`, [grantIds]);
  if (credIds.length) await query(`DELETE FROM credentials WHERE id = ANY($1)`, [credIds]);
  if (ashaAccountId) {
    await query('UPDATE accounts SET balance_minor = $2 WHERE id = $1', [
      ashaAccountId,
      ashaBalance0.toString(),
    ]);
  }
  if (priyaAccountId) {
    await query('UPDATE accounts SET balance_minor = $2 WHERE id = $1', [
      priyaAccountId,
      priyaBalance0.toString(),
    ]);
  }
}

main()
  .then(cleanup)
  .then(async () => {
    await pool.end();
    redis.disconnect();
  })
  .catch(async (err) => {
    console.error('offline.test.ts: FAILED');
    console.error(err);
    await cleanup().catch(() => {});
    await pool.end();
    redis.disconnect();
    process.exit(1);
  });
