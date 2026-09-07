/**
 * Attack: Forged / unsigned QR redemption (incl. JOSE alg-confusion)
 *
 * Protection under test: backend/src/modules/qr/dynamicQr.ts redeem(), which
 * verifies the QR's Ed25519 JWS signature via backend/src/modules/keys/keyManager.ts
 * verifyQrToken() before trusting any of its contents. PLAN.md's threat table
 * names this directly: "QR manipulation -> Ed25519-signed QR ... QR_INVALID_SIGNATURE".
 *
 * Two forgeries, both classic JOSE bugs from the threat-model playbook §10:
 *   (a) a completely unsigned/garbage token — the "printed sticker" attack
 *   (b) alg:none — a JWS header claiming no signature is required at all
 * keyManager.verifyQrToken() calls jose's jwtVerify with an explicit
 * `algorithms: ['EdDSA']` allowlist, which is exactly what defeats both.
 */
import { post } from '../lib/api.mjs';
import { loadState } from '../lib/state.mjs';
import * as p from '../lib/print.mjs';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

async function main() {
  const state = loadState();
  const cookie = state.users.asha.cookie;
  const payeeAccountId = state.knownPayeeAccountId;

  p.section('Forged / Unsigned QR Redemption');
  p.target('POST', '/api/v1/qr/redeem');

  const locked = await post('/api/v1/payment/initiate', { payeeAccountId, amountMinor: 2500 }, { cookie });
  if (locked.status !== 201) throw new Error(`initiate failed: ${locked.status}`);
  const { txId, intentHash } = locked.body;
  p.step(`Locked a real transaction ${txId} to reference in the forged payloads`);

  let allBlocked = true;

  // (a) A printed-sticker style forgery: plausible-looking JWS, garbage signature.
  const garbageHeader = b64url({ alg: 'EdDSA', kid: 'attacker-forged' });
  const garbagePayload = b64url({ v: 1, tx: txId, ih: intentHash, jti: 'forged-jti-1' });
  const garbageToken = `${garbageHeader}.${garbagePayload}.${Buffer.from('not-a-real-signature').toString('base64url')}`;

  p.step('Submitting an unsigned/garbage token pointing at the real transaction');
  const attackA = await post('/api/v1/qr/redeem', { token: garbageToken }, { cookie });
  console.log(`    -> ${attackA.status} ${JSON.stringify(attackA.body)}`);
  if (attackA.status === 403 && attackA.body?.failureCode === 'QR_INVALID_SIGNATURE') {
    console.log('[PASS] Garbage signature rejected.');
  } else if (attackA.status === 200) {
    p.vulnerability('An unsigned/garbage QR token was accepted and returned real transaction details.');
    allBlocked = false;
  } else {
    console.log(`[FAIL] Expected QR_INVALID_SIGNATURE, got ${attackA.status} ${attackA.body?.failureCode}`);
    allBlocked = false;
  }

  // (b) Classic JOSE alg:none confusion.
  const noneHeader = b64url({ alg: 'none', kid: 'attacker-forged' });
  const nonePayload = b64url({ v: 1, tx: txId, ih: intentHash, jti: 'forged-jti-2' });
  const noneToken = `${noneHeader}.${nonePayload}.`;

  p.step('Submitting an alg:none token (no signature segment at all)');
  const attackB = await post('/api/v1/qr/redeem', { token: noneToken }, { cookie });
  console.log(`    -> ${attackB.status} ${JSON.stringify(attackB.body)}`);
  if (attackB.status === 403 && attackB.body?.failureCode === 'QR_INVALID_SIGNATURE') {
    console.log('[PASS] alg:none rejected — server enforces an explicit EdDSA algorithm allowlist.');
  } else if (attackB.status === 200) {
    p.vulnerability('An alg:none QR token was accepted. The server is not enforcing an algorithm allowlist.');
    allBlocked = false;
  } else {
    console.log(`[FAIL] Expected QR_INVALID_SIGNATURE, got ${attackB.status} ${attackB.body?.failureCode}`);
    allBlocked = false;
  }

  if (allBlocked) {
    p.pass('both forged QR variants rejected on signature verification');
    p.finish('PASS');
  } else {
    p.finish('VULNERABILITY');
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exitCode = 2;
});
