/**
 * Attack: Transaction tampering (claimed-hash substitution)
 *
 * Protection under test: backend/src/modules/intent/intentLock.ts verifyHash()
 * and its call site in backend/src/api/routes.ts (/payment/:id/authorize,
 * step 4 "Tamper"). The server recomputes the intent hash from the DB record
 * it locked at /payment/initiate and compares it — timing-safe — against
 * whatever hash the client claims. A real client never sends this field; an
 * attacker intercepting traffic can.
 *
 * There is no `amountMinor` field on /authorize to edit directly (the amount
 * is immutable once locked — see PLAN.md §3.5), so the realistic version of
 * "amount tampering post-hash" against this exact API is: obtain a genuine
 * hash for a CHEAP transaction, then try to get an EXPENSIVE transaction to
 * settle by claiming that cheap hash belongs to it. If the server trusted
 * the client-supplied hash instead of its own record, this would let an
 * attacker settle transaction B while the system believes it verified A.
 */
import { post } from '../lib/api.mjs';
import { loadState } from '../lib/state.mjs';
import * as p from '../lib/print.mjs';

const AMOUNT_CHEAP = 500; // ₹5.00 in paise
const AMOUNT_EXPENSIVE = 5_000_000; // ₹50,000.00 in paise

async function main() {
  const state = loadState();
  const cookie = state.users.asha.cookie;
  const payeeAccountId = state.knownPayeeAccountId;
  if (!payeeAccountId) throw new Error('No known payee in .state.json — rerun npm run setup');

  p.section('Transaction Tampering (claimed intent-hash substitution)');
  p.target('POST', '/api/v1/payment/:id/authorize');

  const cheap = await post('/api/v1/payment/initiate', { payeeAccountId, amountMinor: AMOUNT_CHEAP }, { cookie });
  const expensive = await post(
    '/api/v1/payment/initiate',
    { payeeAccountId, amountMinor: AMOUNT_EXPENSIVE },
    { cookie }
  );
  if (cheap.status !== 201 || expensive.status !== 201) {
    throw new Error(`Setup failed: cheap=${cheap.status} expensive=${expensive.status}`);
  }
  p.step(`Locked intent A: ₹${AMOUNT_CHEAP / 100} -> hash ${cheap.body.intentHash.slice(0, 16)}...`);
  p.step(`Locked intent B: ₹${AMOUNT_EXPENSIVE / 100} -> hash ${expensive.body.intentHash.slice(0, 16)}...`);
  p.step(`Attempting to settle B (₹${AMOUNT_EXPENSIVE / 100}) while claiming A's hash belongs to it`);

  const attack = await post(
    `/api/v1/payment/${expensive.body.txId}/authorize`,
    { intentHash: cheap.body.intentHash }, // no assertion needed: the tamper check runs before signature verification
    { cookie }
  );

  info(attack);

  if (attack.status === 403 && attack.body?.failureCode === 'TAMPER_BLOCKED') {
    p.pass('server recomputed the hash from its own DB record; claimed hash did not match');
    console.log('\n[+] Sanity check: single-character corruption of a real hash is also rejected');
    const corrupted = cheap.body.intentHash.slice(0, -1) + (cheap.body.intentHash.at(-1) === 'A' ? 'B' : 'A');
    const attack2 = await post(`/api/v1/payment/${cheap.body.txId}/authorize`, { intentHash: corrupted }, { cookie });
    if (attack2.status === 403 && attack2.body?.failureCode === 'TAMPER_BLOCKED') {
      console.log('[PASS] One flipped character in the hash is also rejected.');
    } else {
      console.log(`[FAIL] Expected TAMPER_BLOCKED on a corrupted hash, got ${attack2.status} ${attack2.body?.failureCode}`);
    }
    p.finish('PASS');
  } else if (attack.status === 200 || attack.status === 202) {
    p.vulnerability(
      `Transaction ${expensive.body.txId} (₹${AMOUNT_EXPENSIVE / 100}) was accepted using a hash ` +
        `captured from a different, cheaper transaction. The server is trusting a client-supplied ` +
        `intent hash instead of recomputing it from the locked DB record.`
    );
    p.finish('VULNERABILITY');
  } else {
    p.fail(`Unexpected response: ${attack.status} ${JSON.stringify(attack.body)}`);
    p.finish('ERROR');
  }
}

function info(res) {
  console.log(`    -> ${res.status} ${JSON.stringify(res.body)}`);
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exitCode = 2;
});
