/**
 * Self-check for the authorization chain.  Run: npm run test:chain
 *
 * Needs Postgres (docker compose up -d). Creates a throwaway transaction,
 * exercises every property the settlement invariant depends on, and deletes
 * everything it made.
 *
 * What is pinned:
 *   1. a clean chain verifies and its tip is stable
 *   2. a payload edited directly in the database fails row_hash verification
 *   3. a row whose mac is overwritten fails MAC verification
 *   4. a deleted middle row fails the seq-continuity / link check
 *   5. stage order is enforced (stages must go forward)
 *   6. a duplicate stage in one attempt is refused
 *   7. mintCapability refuses when a required stage is absent
 *   8. a second attempt links to the first attempt's tip
 */
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { query } from '../../db/pool';
import pool from '../../db/pool';
import { attestationChain } from './chain';
import { keyManager } from '../keys/keyManager';
import { intentHash } from '../../utils/canonical';
import { PrismError } from '../../api/errors';

/** assert.rejects matcher: the thrown PrismError carries this failure code. */
const rejectsWith = (code: string) => (err: unknown) => {
  assert.ok(err instanceof PrismError, `expected PrismError, got ${err}`);
  assert.equal(err.failureCode, code, `expected ${code}, got ${err.failureCode} (${err.message})`);
  return true;
};

const CLEANUP: string[] = []; // transaction ids

async function makeTx(): Promise<{ txId: string; ih: string }> {
  const u = await query<{ id: string }>(`SELECT id FROM users WHERE email = 'asha@prism.demo'`);
  const pa = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE user_id = $1 ORDER BY created_at LIMIT 1`,
    [u.rows[0].id]
  );
  const pe = await query<{ id: string }>(`SELECT id FROM accounts WHERE handle = 'priya@prism'`);
  const txId = crypto.randomUUID();
  const nonce = crypto.randomBytes(32).toString('hex');
  const createdAt = Math.floor(Date.now() / 1000);
  const expiresAt = createdAt + 90;
  const ih = intentHash({
    amountMinor: 50000,
    createdAt,
    currency: 'INR',
    expiresAt,
    lockVersion: 1,
    nonce,
    payeeAccountId: pe.rows[0].id,
    payerUserId: u.rows[0].id,
    txId,
  });
  await query(
    `INSERT INTO transactions
       (id, payer_user_id, payer_account_id, payee_account_id, amount_minor, currency,
        intent_hash, nonce, lock_version, created_at, expires_at, status)
     VALUES ($1,$2,$3,$4,50000,'INR',$5,$6,1, to_timestamp($7), to_timestamp($8),'PENDING')`,
    [txId, u.rows[0].id, pa.rows[0].id, pe.rows[0].id, ih, nonce, createdAt, expiresAt]
  );
  CLEANUP.push(txId);
  return { txId, ih };
}

async function fullAttempt(txId: string): Promise<void> {
  await attestationChain.append(txId, 'INTENT_LOCKED', { amountMinor: 50000 });
  await attestationChain.append(txId, 'WEBAUTHN_APPROVED', { credentialId: 'demo', verified: true });
  await attestationChain.append(txId, 'CONTEXT_VERIFIED', { newDevice: false });
  await attestationChain.append(txId, 'POLICY_EVALUATED', { decision: 'ALLOW' });
  await attestationChain.append(txId, 'RISK_APPROVED', { score: 25, decision: 'APPROVE' });
  await attestationChain.append(txId, 'SETTLEMENT_AUTHORIZED', {});
}

const REQUIRED = [
  'INTENT_LOCKED',
  'WEBAUTHN_APPROVED',
  'POLICY_EVALUATED',
  'RISK_APPROVED',
  'SETTLEMENT_AUTHORIZED',
] as const;

async function main(): Promise<void> {
  // 1. clean chain
  const { txId, ih } = await makeTx();
  await fullAttempt(txId);
  const v1 = await attestationChain.verify(txId, 1, ih);
  assert.equal(v1.ok, true, `clean chain must verify: ${v1.reason}`);
  const tip1 = v1.tipHash;
  const v1again = await attestationChain.verify(txId, 1, ih);
  assert.equal(v1again.tipHash, tip1, 'tip hash is stable across verifications');

  // 7. capability needs every required stage — this chain has them
  const cap = await attestationChain.mintCapability(txId, 1, ih, [...REQUIRED], 'NORMAL', 60);
  attestationChain.verifyCapabilityShape(cap);
  assert.equal(cap.mode, 'NORMAL');

  // 2. tamper a payload directly in the DB
  const { txId: t2, ih: ih2 } = await makeTx();
  await fullAttempt(t2);
  await query(
    `UPDATE authorization_steps SET payload = jsonb_set(payload,'{score}','999')
      WHERE transaction_id = $1 AND stage = 'RISK_APPROVED'`,
    [t2]
  );
  const v2 = await attestationChain.verify(t2, 1, ih2);
  assert.equal(v2.ok, false, 'edited payload must fail verification');
  assert.match(v2.reason ?? '', /row_hash mismatch|payload altered/);

  // 3. overwrite a mac
  const { txId: t3, ih: ih3 } = await makeTx();
  await fullAttempt(t3);
  await query(
    `UPDATE authorization_steps SET mac = $2 WHERE transaction_id = $1 AND stage = 'WEBAUTHN_APPROVED'`,
    [t3, keyManager.macStep('a-different-row-hash')]
  );
  const v3 = await attestationChain.verify(t3, 1, ih3);
  assert.equal(v3.ok, false, 'overwritten mac must fail verification');
  assert.match(v3.reason ?? '', /MAC invalid|forged/);

  // 4. delete a middle row
  const { txId: t4, ih: ih4 } = await makeTx();
  await fullAttempt(t4);
  await query(`DELETE FROM authorization_steps WHERE transaction_id = $1 AND stage = 'CONTEXT_VERIFIED'`, [t4]);
  const v4 = await attestationChain.verify(t4, 1, ih4);
  assert.equal(v4.ok, false, 'a hole in the chain must fail verification');
  assert.match(v4.reason ?? '', /seq gap|broken link/);

  // 5. stage order: a backwards stage is refused
  const { txId: t5 } = await makeTx();
  await attestationChain.append(t5, 'INTENT_LOCKED', {});
  await attestationChain.append(t5, 'RISK_APPROVED', {});
  await assert.rejects(
    () => attestationChain.append(t5, 'CONTEXT_VERIFIED', {}),
    rejectsWith('CHAIN_INVALID'),
    'stages must go forward'
  );

  // 6. duplicate stage
  const { txId: t6 } = await makeTx();
  await attestationChain.append(t6, 'INTENT_LOCKED', {});
  await attestationChain.append(t6, 'WEBAUTHN_APPROVED', {});
  await assert.rejects(
    () => attestationChain.append(t6, 'WEBAUTHN_APPROVED', {}),
    rejectsWith('CHAIN_INVALID'),
    'a stage cannot appear twice in one attempt'
  );

  // 7b. mintCapability refuses a missing required stage
  const { txId: t7, ih: ih7 } = await makeTx();
  await attestationChain.append(t7, 'INTENT_LOCKED', {});
  await attestationChain.append(t7, 'WEBAUTHN_APPROVED', {});
  await attestationChain.append(t7, 'POLICY_EVALUATED', { decision: 'ALLOW' });
  await attestationChain.append(t7, 'SETTLEMENT_AUTHORIZED', {}); // RISK_APPROVED skipped
  await assert.rejects(
    () => attestationChain.mintCapability(t7, 1, ih7, [...REQUIRED], 'NORMAL', 60),
    rejectsWith('CHAIN_INCOMPLETE'),
    'no capability without every required stage'
  );

  // 8. second attempt links to the first attempt's tip
  const { txId: t8, ih: ih8 } = await makeTx();
  await fullAttempt(t8);
  const firstTip = (await attestationChain.verify(t8, 1, ih8)).tipHash;
  const root2 = await attestationChain.append(t8, 'INTENT_LOCKED', { retry: true });
  assert.equal(root2.attempt, 2, 'a new INTENT_LOCKED starts attempt 2');
  assert.equal(root2.seq, 0, 'attempt 2 restarts at seq 0');
  const step2 = await query<{ prev_hash: string }>(
    `SELECT prev_hash FROM authorization_steps WHERE transaction_id = $1 AND attempt = 2 AND seq = 0`,
    [t8]
  );
  assert.equal(step2.rows[0].prev_hash, firstTip, "attempt 2's root links to attempt 1's tip");

  console.log('chain.test.ts: all assertions passed');
  console.log('  clean chain tip:', tip1);
}

async function cleanup(): Promise<void> {
  if (CLEANUP.length) {
    await query(`DELETE FROM settlement_capabilities WHERE transaction_id = ANY($1)`, [CLEANUP]);
    await query(`DELETE FROM authorization_steps WHERE transaction_id = ANY($1)`, [CLEANUP]);
    await query(`DELETE FROM transactions WHERE id = ANY($1)`, [CLEANUP]);
  }
}

main()
  .then(cleanup)
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('chain.test.ts: FAILED');
    console.error(err);
    await cleanup().catch(() => {});
    await pool.end();
    process.exit(1);
  });
