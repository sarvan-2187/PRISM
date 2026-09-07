/**
 * Attack: QR replay / double redemption
 *
 * Protection under test: backend/src/modules/qr/dynamicQr.ts redeem() single-use
 * enforcement — a GETSET against `qr:{jti}` in Redis (ISSUED -> CONSUMED)
 * claimed atomically so two scans of the same code cannot both see ISSUED.
 * This is PRISM's N3 novelty claim: "prevents screenshot/QR reuse".
 */
import { post, get } from '../lib/api.mjs';
import { loadState } from '../lib/state.mjs';
import * as p from '../lib/print.mjs';

async function main() {
  const state = loadState();
  const cookie = state.users.asha.cookie;
  const payeeAccountId = state.knownPayeeAccountId;

  p.section('QR Replay (reuse after first redemption)');
  p.target('POST', '/api/v1/qr/redeem');

  const locked = await post('/api/v1/payment/initiate', { payeeAccountId, amountMinor: 3000 }, { cookie });
  if (locked.status !== 201) throw new Error(`initiate failed: ${locked.status}`);
  const { txId } = locked.body;

  const qr = await get(`/api/v1/qr/${txId}`, { cookie });
  if (qr.status !== 200) throw new Error(`qr issue failed: ${qr.status} ${JSON.stringify(qr.body)}`);
  p.step(`Issued a genuine signed QR for ${txId} (expires in ${qr.body.expiresInSeconds}s)`);

  p.step('Redeeming it once (as the legitimate first scan)');
  const first = await post('/api/v1/qr/redeem', { token: qr.body.token }, { cookie });
  console.log(`    -> ${first.status} ${JSON.stringify(first.body)}`);
  if (first.status !== 200) {
    throw new Error(`Expected the first redemption to succeed, got ${first.status} ${JSON.stringify(first.body)}`);
  }

  p.step('Replaying the SAME token a second time (screenshot/relay style reuse)');
  const second = await post('/api/v1/qr/redeem', { token: qr.body.token }, { cookie });
  console.log(`    -> ${second.status} ${JSON.stringify(second.body)}`);

  if (second.status === 409 && second.body?.failureCode === 'QR_ALREADY_USED') {
    p.pass('second redemption of the same token refused — single-use enforced via Redis GETSET');
    p.finish('PASS');
  } else if (second.status === 200) {
    p.vulnerability(`The same QR token (${txId}) was redeemed twice successfully.`);
    p.finish('VULNERABILITY');
  } else {
    p.fail(`Unexpected response: ${second.status} ${JSON.stringify(second.body)}`);
    p.finish('ERROR');
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exitCode = 2;
});
