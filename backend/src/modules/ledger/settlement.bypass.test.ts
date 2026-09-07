/**
 * The bypass-regression test.  Run: npm run test:bypass
 *
 * This is the test that proves the thesis: settlement is structurally
 * dependent on a complete, valid authorization chain. Every case here builds a
 * transaction, hands settlement a capability, and asserts money does NOT move
 * unless the chain genuinely backs it.
 *
 *   1. a capability minted from a complete chain settles (control)
 *   2. a capability whose chain is missing RISK_APPROVED is refused
 *   3. a hand-forged capability (attacker-built, no valid MAC) is refused
 *   4. a capability replayed after consumption is refused, no second debit
 *   5. a capability for transaction A presented against transaction B is refused
 *   6. editing a step payload after the capability is minted breaks settlement
 *
 * Needs Postgres. Self-cleaning.
 */
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { query } from '../../db/pool';
import pool from '../../db/pool';
import { attestationChain } from '../attestation/chain';
import { settlement } from './settlement';
import { intentHash } from '../../utils/canonical';
import { PrismError } from '../../api/errors';
import { TransactionRow, SettlementCapabilityRow } from '../../db/types';

const CLEANUP: string[] = [];
const REQUIRED = [
  'INTENT_LOCKED',
  'WEBAUTHN_APPROVED',
  'CONTEXT_VERIFIED',
  'RISK_APPROVED',
  'SETTLEMENT_AUTHORIZED',
] as const;

let ashaId = '';
let ashaAcct = '';
let priyaAcct = '';

async function fixtures(): Promise<void> {
  ashaId = (await query<{ id: string }>(`SELECT id FROM users WHERE email='asha@prism.demo'`)).rows[0].id;
  ashaAcct = (
    await query<{ id: string }>(`SELECT id FROM accounts WHERE user_id=$1 ORDER BY created_at LIMIT 1`, [ashaId])
  ).rows[0].id;
  priyaAcct = (await query<{ id: string }>(`SELECT id FROM accounts WHERE handle='priya@prism'`)).rows[0].id;
}

async function makeTx(): Promise<TransactionRow> {
  const txId = crypto.randomUUID();
  const nonce = crypto.randomBytes(32).toString('hex');
  const ca = Math.floor(Date.now() / 1000);
  const ea = ca + 90;
  const ih = intentHash({
    amountMinor: 50000,
    createdAt: ca,
    currency: 'INR',
    expiresAt: ea,
    lockVersion: 1,
    nonce,
    payeeAccountId: priyaAcct,
    payerUserId: ashaId,
    txId,
  });
  await query(
    `INSERT INTO transactions
       (id, payer_user_id, payer_account_id, payee_account_id, amount_minor, currency,
        intent_hash, nonce, lock_version, created_at, expires_at, status)
     VALUES ($1,$2,$3,$4,50000,'INR',$5,$6,1, to_timestamp($7), to_timestamp($8),'PENDING')`,
    [txId, ashaId, ashaAcct, priyaAcct, ih, nonce, ca, ea]
  );
  await attestationChain.append(txId, 'INTENT_LOCKED', { amountMinor: 50000 });
  CLEANUP.push(txId);
  return (await query<TransactionRow>(`SELECT * FROM transactions WHERE id=$1`, [txId])).rows[0];
}

async function buildChain(txId: string, stages: readonly string[]): Promise<void> {
  for (const s of stages) {
    if (s === 'INTENT_LOCKED') continue; // already the root
    await attestationChain.append(txId, s as never, { built: s });
  }
}

async function balances(): Promise<{ asha: bigint; priya: bigint }> {
  const r = await query<{ id: string; balance_minor: string }>(
    `SELECT id, balance_minor FROM accounts WHERE id = ANY($1)`,
    [[ashaAcct, priyaAcct]]
  );
  const m = Object.fromEntries(r.rows.map((x) => [x.id, BigInt(x.balance_minor)]));
  return { asha: m[ashaAcct], priya: m[priyaAcct] };
}

async function expectRefused(fn: () => Promise<unknown>, label: string): Promise<void> {
  const before = await balances();
  await assert.rejects(fn, (e) => e instanceof PrismError, `${label}: must throw PrismError`);
  const after = await balances();
  assert.equal(after.asha, before.asha, `${label}: payer balance must not move`);
  assert.equal(after.priya, before.priya, `${label}: payee balance must not move`);
}

async function main(): Promise<void> {
  await fixtures();

  // 1. control — a complete chain settles.
  const t1 = await makeTx();
  await buildChain(t1.id, REQUIRED);
  const cap1 = await attestationChain.mintCapability(t1.id, 1, t1.intent_hash, [...REQUIRED], 'NORMAL', 60);
  const b1 = await balances();
  const r1 = await settlement.settle(t1, cap1);
  assert.equal(r1.mode, 'NORMAL');
  const a1 = await balances();
  assert.equal(a1.asha, b1.asha - 50000n, 'control: payer debited');
  assert.equal(a1.priya, b1.priya + 50000n, 'control: payee credited');

  // 2. chain missing RISK_APPROVED — mintCapability itself refuses.
  const t2 = await makeTx();
  await buildChain(t2.id, ['INTENT_LOCKED', 'WEBAUTHN_APPROVED', 'CONTEXT_VERIFIED', 'SETTLEMENT_AUTHORIZED']);
  await expectRefused(
    () => attestationChain.mintCapability(t2.id, 1, t2.intent_hash, [...REQUIRED], 'NORMAL', 60),
    'missing RISK_APPROVED'
  );

  // 3. hand-forged capability — attacker builds the row, no valid MAC.
  const t3 = await makeTx();
  await buildChain(t3.id, REQUIRED);
  const forged = (
    await query<SettlementCapabilityRow>(
      `INSERT INTO settlement_capabilities
         (transaction_id, attempt, intent_hash, chain_tip_hash, required_stages, mode, mac, expires_at)
       VALUES ($1,1,$2,'whatever',$3,'NORMAL','not-a-real-mac', NOW() + INTERVAL '1 minute')
       RETURNING *`,
      [t3.id, t3.intent_hash, [...REQUIRED]]
    )
  ).rows[0];
  await expectRefused(() => settlement.settle(t3, forged), 'forged capability MAC');

  // 4. replay a consumed capability.
  const t4 = await makeTx();
  await buildChain(t4.id, REQUIRED);
  const cap4 = await attestationChain.mintCapability(t4.id, 1, t4.intent_hash, [...REQUIRED], 'NORMAL', 60);
  await settlement.settle(t4, cap4); // first settle ok
  const fresh4 = (
    await query<SettlementCapabilityRow>(`SELECT * FROM settlement_capabilities WHERE id=$1`, [cap4.id])
  ).rows[0];
  await expectRefused(() => settlement.settle(t4, fresh4), 'replayed capability');
  const led4 = await query<{ c: string }>(
    `SELECT COUNT(*)::text c FROM ledger_entries WHERE transaction_id=$1`,
    [t4.id]
  );
  assert.equal(led4.rows[0].c, '2', 'replayed capability: still exactly one DEBIT + CREDIT');

  // 5. capability for A presented against B.
  const t5a = await makeTx();
  const t5b = await makeTx();
  await buildChain(t5a.id, REQUIRED);
  const cap5 = await attestationChain.mintCapability(t5a.id, 1, t5a.intent_hash, [...REQUIRED], 'NORMAL', 60);
  await expectRefused(() => settlement.settle(t5b, cap5), 'capability for a different transaction');

  // 6. edit a step payload after minting.
  const t6 = await makeTx();
  await buildChain(t6.id, REQUIRED);
  const cap6 = await attestationChain.mintCapability(t6.id, 1, t6.intent_hash, [...REQUIRED], 'NORMAL', 60);
  await query(
    `UPDATE authorization_steps SET payload = jsonb_set(payload,'{built}','"tampered"')
      WHERE transaction_id=$1 AND stage='RISK_APPROVED'`,
    [t6.id]
  );
  await expectRefused(() => settlement.settle(t6, cap6), 'payload edited after minting');

  console.log('settlement.bypass.test.ts: all assertions passed');
  console.log('  proven: no complete valid chain => no settlement, no money moved');
}

async function cleanup(): Promise<void> {
  if (!CLEANUP.length) return;
  await query(`DELETE FROM ledger_entries WHERE transaction_id = ANY($1)`, [CLEANUP]);
  await query(`DELETE FROM settlement_capabilities WHERE transaction_id = ANY($1)`, [CLEANUP]);
  await query(`DELETE FROM authorization_steps WHERE transaction_id = ANY($1)`, [CLEANUP]);
  await query(`DELETE FROM audit_logs WHERE transaction_id = ANY($1)`, [CLEANUP]);
  await query(`DELETE FROM transactions WHERE id = ANY($1)`, [CLEANUP]);
  await query(
    `UPDATE accounts a SET balance_minor = a.opening_balance_minor + COALESCE((
       SELECT SUM(CASE WHEN le.direction='CREDIT' THEN le.amount_minor ELSE -le.amount_minor END)
         FROM ledger_entries le WHERE le.account_id=a.id),0)
      WHERE a.id = ANY($1)`,
    [[ashaAcct, priyaAcct]]
  );
}

main()
  .then(cleanup)
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('settlement.bypass.test.ts: FAILED');
    console.error(err);
    await cleanup().catch(() => {});
    await pool.end();
    process.exit(1);
  });
