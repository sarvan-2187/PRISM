/**
 * Attack: Stale/expired intent reuse
 *
 * Protection under test: the 90-second intent-lock window
 * (backend/src/config/policy.ts intentTtlSeconds) enforced in
 * backend/src/api/routes.ts authorize handler, step 2:
 *   if (intentLock.isExpired(tx)) { markFailed(..., 'INTENT_EXPIRED', 'EXPIRED'); fail('INTENT_EXPIRED'); }
 *
 * This check runs before signature verification, so — like the tamper and
 * replay checks — it can be tested honestly with a placeholder assertion:
 * an attacker who captured a stale approval attempt gets refused on expiry
 * alone, before the server even looks at whether a signature is valid.
 *
 * Deliberately slow (~95s): this is a real clock-based expiry, not
 * simulated, so PRISM_DISABLE is never touched.
 */
import { post, get } from '../lib/api.mjs';
import { loadState } from '../lib/state.mjs';
import * as p from '../lib/print.mjs';

const AMOUNT = 1000; // ₹10.00

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const state = loadState();
  const cookie = state.users.asha.cookie;
  const payeeAccountId = state.knownPayeeAccountId;

  p.section('Expired Intent Reuse');
  p.target('POST', '/api/v1/payment/:id/authorize');

  const locked = await post('/api/v1/payment/initiate', { payeeAccountId, amountMinor: AMOUNT }, { cookie });
  if (locked.status !== 201) throw new Error(`initiate failed: ${locked.status} ${JSON.stringify(locked.body)}`);
  const { txId, secondsRemaining, expiresAt } = locked.body;
  p.step(`Locked intent ${txId}, expires at ${expiresAt} (${secondsRemaining}s window)`);

  const waitMs = (secondsRemaining + 5) * 1000;
  p.step(`Waiting ${Math.round(waitMs / 1000)}s for the window to close...`);
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    await sleep(10_000);
    const remaining = Math.max(0, Math.round((waitMs - (Date.now() - start)) / 1000));
    process.stdout.write(`    ...${remaining}s remaining\r`);
  }
  console.log('');

  p.step('Submitting authorize against the now-expired intent');
  const attack = await post(`/api/v1/payment/${txId}/authorize`, { assertion: { id: 'stale-approval' } }, { cookie });
  console.log(`    -> ${attack.status} ${JSON.stringify(attack.body)}`);

  if (attack.status === 410 && attack.body?.failureCode === 'INTENT_EXPIRED') {
    p.pass('90-second window enforced; stale approval refused before signature check');
    const after = await get(`/api/v1/payment/${txId}`, { cookie });
    console.log(`[+] Transaction status is now '${after.body.status}' — no money moved`);
    p.finish('PASS');
  } else if (attack.status === 200) {
    p.vulnerability(`Transaction ${txId} settled after its ${secondsRemaining}s window had closed.`);
    p.finish('VULNERABILITY');
  } else {
    p.fail(`Unexpected response: ${attack.status} ${JSON.stringify(attack.body)}`);
    p.finish('ERROR');
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exitCode = 2;
});
