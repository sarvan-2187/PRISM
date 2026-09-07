/**
 * Attack: Session cookie forgery (JOSE alg-confusion + payload tampering)
 *
 * Protection under test: backend/src/modules/keys/keyManager.ts
 * signSession()/verifySession() — an HS256 JWT in an httpOnly cookie
 * (backend/src/api/middleware/session.ts). verifySession() calls jose's
 * jwtVerify with an explicit `algorithms: ['HS256']` allowlist, which is
 * exactly what defeats the classic "alg:none" and "swap the payload,
 * keep the old signature" JOSE bugs from the threat-model playbook §10.
 *
 * We take a REAL session cookie (from setup) and forge two variants:
 *   (a) alg:none — no signature at all
 *   (b) payload tampering — swap `sub` to a different user's id, keep the
 *       original (now-invalid) signature
 * Both should be treated as anonymous by attachSession() and refused with
 * 401 AUTH_FAILED by requireSession() on a protected route.
 */
import { get } from '../lib/api.mjs';
import { loadState } from '../lib/state.mjs';
import * as p from '../lib/print.mjs';

function decodeJwt(token) {
  const [h, payload, sig] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
    sig,
  };
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

async function main() {
  const state = loadState();
  const realCookie = state.users.asha.cookie; // "prism_session=<jwt>"
  const realToken = realCookie.split('=')[1];
  const { header, payload, sig } = decodeJwt(realToken);

  p.section('Session Cookie Forgery (JOSE alg-confusion / payload tamper)');
  p.target('GET', '/api/v1/me (any requireSession route)');
  p.step(`Decoded a real session token — header ${JSON.stringify(header)}, sub=${payload.sub}`);

  let allBlocked = true;

  // (a) alg:none
  const noneHeader = b64url({ ...header, alg: 'none' });
  const nonePayload = b64url(payload);
  const noneToken = `${noneHeader}.${nonePayload}.`;
  p.step('Forging alg:none (no signature)');
  const attackA = await get('/api/v1/me', { cookie: `prism_session=${noneToken}` });
  console.log(`    -> ${attackA.status} ${JSON.stringify(attackA.body)}`);
  if (attackA.status === 401 && attackA.body?.failureCode === 'AUTH_FAILED') {
    console.log('[PASS] alg:none forgery rejected.');
  } else {
    console.log(`[FAIL] Expected 401 AUTH_FAILED, got ${attackA.status} ${attackA.body?.failureCode}`);
    allBlocked = false;
  }

  // (b) payload tamper, original signature kept
  const state2 = loadState();
  const priyaUserId = state2.users.priya.userId;
  const tamperedPayload = b64url({ ...payload, sub: priyaUserId });
  const tamperedToken = `${b64url(header)}.${tamperedPayload}.${sig}`;
  p.step(`Swapping sub -> ${priyaUserId} (Priya) while keeping Asha's original signature`);
  const attackB = await get('/api/v1/me', { cookie: `prism_session=${tamperedToken}` });
  console.log(`    -> ${attackB.status} ${JSON.stringify(attackB.body)}`);
  if (attackB.status === 401 && attackB.body?.failureCode === 'AUTH_FAILED') {
    console.log('[PASS] Payload tamper with stale signature rejected.');
  } else {
    console.log(`[FAIL] Expected 401 AUTH_FAILED, got ${attackB.status} ${attackB.body?.failureCode}`);
    allBlocked = false;
  }

  // Sanity: the real, unmodified cookie still works.
  const control = await get('/api/v1/me', { cookie: realCookie });
  console.log(`    (control) real cookie -> ${control.status}`);

  if (allBlocked && control.status === 200) {
    p.pass('both forged tokens rejected; the genuine cookie still authenticates normally');
    p.finish('PASS');
  } else if (!allBlocked) {
    p.vulnerability('A forged session token was accepted. See the responses above.');
    p.finish('VULNERABILITY');
  } else {
    p.fail('The genuine cookie stopped working — investigate before trusting the PASS above.');
    p.finish('ERROR');
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exitCode = 2;
});
