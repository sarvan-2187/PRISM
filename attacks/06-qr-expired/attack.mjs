/**
 * Attack: Expired QR reuse
 *
 * Protection under test: the QR token's 60-second lifetime
 * (backend/src/config/policy.ts qrTtlSeconds), enforced two ways in
 * backend/src/modules/qr/dynamicQr.ts redeem():
 *   1. the Ed25519 JWS itself carries an `exp` claim (keyManager.signQrToken),
 *      so jose's jwtVerify rejects it outright once expired
 *   2. the Redis `qr:{jti}` key shares the same TTL, so even a signature
 *      check that ignored `exp` would find the jti unknown
 *
 * Deliberately slow (~65s): this is a real clock-based expiry.
 */
import { post, get } from '../lib/api.mjs';
import { loadState } from '../lib/state.mjs';
import * as p from '../lib/print.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const state = loadState();
  const cookie = state.users.asha.cookie;
  const payeeAccountId = state.knownPayeeAccountId;

  p.section('Expired QR Reuse');
  p.target('POST', '/api/v1/qr/redeem');

  const locked = await post('/api/v1/payment/initiate', { payeeAccountId, amountMinor: 1500 }, { cookie });
  if (locked.status !== 201) throw new Error(`initiate failed: ${locked.status}`);
  const { txId } = locked.body;

  const qr = await get(`/api/v1/qr/${txId}`, { cookie });
  if (qr.status !== 200) throw new Error(`qr issue failed: ${qr.status} ${JSON.stringify(qr.body)}`);
  p.step(`Issued a genuine QR for ${txId}, ${qr.body.expiresInSeconds}s TTL`);

  const waitMs = (qr.body.expiresInSeconds + 5) * 1000;
  p.step(`Waiting ${Math.round(waitMs / 1000)}s for it to expire...`);
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    await sleep(5_000);
    const remaining = Math.max(0, Math.round((waitMs - (Date.now() - start)) / 1000));
    process.stdout.write(`    ...${remaining}s remaining\r`);
  }
  console.log('');

  p.step('Attempting redemption of the now-expired token');
  const attack = await post('/api/v1/qr/redeem', { token: qr.body.token }, { cookie });
  console.log(`    -> ${attack.status} ${JSON.stringify(attack.body)}`);

  if (attack.status === 410 && attack.body?.failureCode === 'QR_EXPIRED') {
    p.pass('expired token rejected');
    p.finish('PASS');
  } else if (attack.status === 200) {
    p.vulnerability(`An expired QR token (${txId}) was still accepted.`);
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
