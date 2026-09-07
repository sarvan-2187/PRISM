/**
 * Self-check for offline authorization.  Run: npm run test:offline
 *
 * BLACKOUT (FC-01-A): the device goes fully offline mid-payment. This pins
 * the two properties the card demands — a voucher still authenticates with
 * no server, and a captured voucher cannot be replayed once the link is
 * back — plus the tamper/expiry/revocation edges around them.
 *
 * Needs Postgres and Redis running (docker compose up -d) and the seed
 * applied (npm run db:seed) — Asha must have settled history with Priya, or
 * the grant has no allowed payee to test against.
 *
 * Drives the modules directly (not over HTTP): offline.redeem() needs only
 * an Express-shaped Request, which a plain object satisfies. Every row this
 * creates is deleted on exit and account balances are restored.
 */
import assert from 'node:assert/strict';
import type { Request } from 'express';
import pool, { query } from '../../db/pool';
import redis from '../../utils/redis';
import { offlineGrant, GrantBody } from './grant';
import { offlineRedeem } from './redeem';
import { intentHash as computeIntentHash, LockedIntent } from '../../utils/canonical';
import { PrismError } from '../../api/errors';
import { createSoftCredential, SoftCredential } from '../identity/softAuthenticator';

const rejectsWith = (code: string) => (err: unknown) => {
  assert.ok(err instanceof PrismError, `expected PrismError, got ${err}`);
  assert.equal(err.failureCode, code, `expected ${code}, got ${err.failureCode} (${err.message})`);
  return true;
};

const CLEANUP = {
  txIds: [] as string[],
  grantIds: [] as string[],
  credIds: [] as string[],
};

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

/** Build, hash and sign a voucher body from one slot of a grant. */
function buildVoucher(
  grant: GrantBody,
  token: string,
  slotIndex: number,
  signer: SoftCredential,
  overrides: Partial<LockedIntent> = {}
): { token: string; intent: LockedIntent; intentHash: string; assertion: ReturnType<SoftCredential['sign']> } {
  const slot = grant.slots[slotIndex];
  const intent: LockedIntent = {
    amountMinor: 200000, // ₹2,000 — under the ₹5,000 cap
    createdAt: Math.floor(Date.now() / 1000),
    currency: grant.currency,
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    lockVersion: 1,
    nonce: slot.nonce,
    payeeAccountId: priyaAccountId,
    payerUserId: grant.payerUserId,
    txId: slot.txId,
    ...overrides,
  };
  const hash = computeIntentHash(intent);
  return { token, intent, intentHash: hash, assertion: signer.sign(hash) };
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

  // 1. Happy path: a voucher signed with no network reaches SETTLED.
  {
    const { grant, token } = await offlineGrant.issue(ashaUserId, ashaAccountId);
    CLEANUP.grantIds.push(grant.grantId);
    assert.ok(
      grant.allowedPayees.some((p) => p.accountId === priyaAccountId),
      'setup: Priya must be an allowed offline payee (seed gives Asha settled history with her)'
    );
    // >= 1 rather than exactly 1: a shared dev/demo database may already have
    // other non-duress passkeys registered for Asha (a browser registration,
    // an earlier e2e run). The property under test is that ours is included.
    assert.ok(
      grant.credentialIds.includes(cred.credentialId),
      "grant pins this session's active non-duress credential"
    );

    const voucher = buildVoucher(grant, token, 0, cred);
    const result = await offlineRedeem.redeem(fakeReq(ashaUserId, voucher));
    CLEANUP.txIds.push(result.txId);
    assert.equal(result.decision, 'APPROVED', '1: offline voucher settles');

    const tx = await query<{ status: string; authorized_offline: boolean }>(
      `SELECT status, authorized_offline FROM transactions WHERE id = $1`,
      [result.txId]
    );
    assert.equal(tx.rows[0].status, 'SETTLED', '1: status SETTLED');
    assert.equal(tx.rows[0].authorized_offline, true, '1: flagged as an offline authorization');

    // 2. Replay: the exact same captured voucher, resubmitted after "reconnect".
    await assert.rejects(
      () => offlineRedeem.redeem(fakeReq(ashaUserId, voucher)),
      rejectsWith('REPLAY_BLOCKED'),
      '2: a captured voucher cannot be redeemed twice'
    );
  }

  // 3. Tamper: amount edited after signing, hash left as the original.
  {
    const { grant, token } = await offlineGrant.issue(ashaUserId, ashaAccountId);
    CLEANUP.grantIds.push(grant.grantId);
    const voucher = buildVoucher(grant, token, 0, cred);
    CLEANUP.txIds.push(voucher.intent.txId); // no-op if redeem() never reaches the insert
    const tampered = { ...voucher, intent: { ...voucher.intent, amountMinor: 300000 } };
    await assert.rejects(
      () => offlineRedeem.redeem(fakeReq(ashaUserId, tampered)),
      rejectsWith('TAMPER_BLOCKED'),
      '3: amount edited post-signature must not settle'
    );
  }

  // 4. Payee outside the offline allow-list (never settled with Asha before).
  {
    const { grant, token } = await offlineGrant.issue(ashaUserId, ashaAccountId);
    CLEANUP.grantIds.push(grant.grantId);
    assert.ok(
      !grant.allowedPayees.some((p) => p.accountId === rajeshAccountId),
      'setup: Rajesh must NOT be an allowed offline payee (no settled history)'
    );
    const voucher = buildVoucher(grant, token, 0, cred, { payeeAccountId: rajeshAccountId });
    CLEANUP.txIds.push(voucher.intent.txId);
    await assert.rejects(
      () => offlineRedeem.redeem(fakeReq(ashaUserId, voucher)),
      rejectsWith('TAMPER_BLOCKED'),
      '4: a payee outside the grant cannot be paid offline'
    );
  }

  // 5. Amount over the offline cap.
  {
    const { grant, token } = await offlineGrant.issue(ashaUserId, ashaAccountId);
    CLEANUP.grantIds.push(grant.grantId);
    const voucher = buildVoucher(grant, token, 0, cred, { amountMinor: grant.maxAmountMinor + 100 });
    CLEANUP.txIds.push(voucher.intent.txId);
    await assert.rejects(
      () => offlineRedeem.redeem(fakeReq(ashaUserId, voucher)),
      rejectsWith('TAMPER_BLOCKED'),
      '5: a voucher over the cap cannot settle'
    );
  }

  // 6. Expired grant. Unit-tested directly against assertLive(): a signed
  // token embeds its own notAfter (MAC'd, so a real expiry cannot be waited
  // out in seconds here) — this exercises exactly the comparison redeem()
  // runs against that embedded value.
  {
    const { grant } = await offlineGrant.issue(ashaUserId, ashaAccountId);
    CLEANUP.grantIds.push(grant.grantId);
    const expired: GrantBody = { ...grant, notAfter: Math.floor(Date.now() / 1000) - 10 };
    await assert.rejects(
      () => offlineGrant.assertLive(expired),
      rejectsWith('GRANT_EXPIRED'),
      '6: a grant past its window is refused'
    );
  }

  // 7. Grant body edited, MAC left as the original's.
  {
    const { grant, token } = await offlineGrant.issue(ashaUserId, ashaAccountId);
    CLEANUP.grantIds.push(grant.grantId);
    const [bodyB64, mac] = token.split('.');
    const edited: GrantBody = { ...grant, maxAmountMinor: 100_00_00000 };
    const forgedToken = `${Buffer.from(JSON.stringify(edited), 'utf8').toString('base64url')}.${mac}`;
    assert.notEqual(forgedToken, token, 'sanity: the forged token must actually differ');
    assert.throws(() => offlineGrant.verify(forgedToken), rejectsWith('GRANT_INVALID'), '7: MAC catches the edit');
    // A syntactically valid but never-issued token, same check.
    assert.throws(
      () => offlineGrant.verify(`${bodyB64}.not-a-real-mac`),
      rejectsWith('GRANT_INVALID'),
      '7b: a forged MAC is refused'
    );
  }

  // 8. Revocation after the grant was issued but before redemption — the
  // stolen-device response. The credential was valid when the grant pinned
  // it (so it clears the grant-boundary check); revoking it must still stop
  // a voucher that credential already signed from settling.
  {
    const { grant, token } = await offlineGrant.issue(ashaUserId, ashaAccountId);
    CLEANUP.grantIds.push(grant.grantId);
    const voucher = buildVoucher(grant, token, 0, cred);
    // Unlike cases 3-5, this one fails AFTER the transaction row is inserted
    // (the signature check runs later than the envelope/hash checks — see
    // redeem.ts), so this id is real and must be cleaned up, not a no-op.
    CLEANUP.txIds.push(voucher.intent.txId);
    await query(`UPDATE credentials SET revoked_at = NOW() WHERE id = $1`, [cred.credentialId]);
    try {
      await assert.rejects(
        () => offlineRedeem.redeem(fakeReq(ashaUserId, voucher)),
        rejectsWith('AUTH_FAILED'),
        '8: a captured voucher signed by a now-revoked credential must not settle'
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
  }
  if (grantIds.length) {
    await query(`DELETE FROM offline_vouchers WHERE grant_id = ANY($1)`, [grantIds]);
  }
  if (txIds.length) {
    // redeem() audits several stages against these transaction ids
    // (CONTEXT_EVALUATED, SETTLEMENT_AUTHORIZED, OFFLINE_VOUCHER_REDEEMED, ...);
    // audit_logs.transaction_id FKs to transactions, so it must clear first.
    await query(`DELETE FROM audit_logs WHERE transaction_id = ANY($1)`, [txIds]);
    await query(`DELETE FROM transactions WHERE id = ANY($1)`, [txIds]);
  }
  if (grantIds.length) {
    await query(`DELETE FROM offline_grants WHERE id = ANY($1)`, [grantIds]);
  }
  if (credIds.length) {
    await query(`DELETE FROM credentials WHERE id = ANY($1)`, [credIds]);
  }
  if (ashaAccountId) {
    await query('UPDATE accounts SET balance_minor = $2 WHERE id = $1', [ashaAccountId, ashaBalance0.toString()]);
  }
  if (priyaAccountId) {
    await query('UPDATE accounts SET balance_minor = $2 WHERE id = $1', [priyaAccountId, priyaBalance0.toString()]);
  }
}

main()
  .then(cleanup)
  .then(async () => {
    await pool.end();
    // redis (ioredis) holds an open TCP connection that keeps the event loop
    // alive indefinitely; chain.test.ts never hits this because it never
    // imports anything that touches redis. Close it explicitly so the
    // process exits on success the same way it already does on failure.
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
