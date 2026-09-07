/**
 * Dynamic QR — signature, expiry, single use.   Run: npm run test:qr
 * OWNER: S2
 *
 * Covers the three QR failures named in the explainer's failure catalogue,
 * plus the property the whole QR-swap defence rests on: the payee shown to
 * the payer is read from the database, never from the scanned code.
 *
 * Needs Redis and Postgres running: docker compose up -d
 */
import assert from 'node:assert/strict';
import crypto from 'crypto';
import redis from '../../utils/redis';
import pool, { query } from '../../db/pool';
import { dynamicQr } from './dynamicQr';
import { keyManager } from '../keys/keyManager';
import { PrismError } from '../../api/errors';
import { AccountRow } from '../../db/types';

async function expectFailure(fn: () => Promise<unknown>, code: string, label: string) {
  try {
    await fn();
    assert.fail(`${label}: expected ${code}, but it succeeded`);
  } catch (err) {
    assert.ok(err instanceof PrismError, `${label}: expected PrismError, got ${String(err)}`);
    assert.equal(err.failureCode, code, label);
  }
}

async function run() {
  console.log('\nDynamic QR\n');

  const { rows: accounts } = await query<AccountRow>(
    `SELECT * FROM accounts WHERE handle IN ('priya@prism','rajesh@prism') ORDER BY handle`
  );
  const priya = accounts.find((a) => a.handle === 'priya@prism')!;
  const rajesh = accounts.find((a) => a.handle === 'rajesh@prism')!;
  assert.ok(priya && rajesh, 'seed data missing — run npm run db:seed');

  // ── 1. Honest round trip ────────────────────────────────────────────
  {
    const { token } = await dynamicQr.createRequest(priya.id, 250_000); // ₹2,500
    const scanned = await dynamicQr.scan(token);
    assert.equal(scanned.payeeAccountId, priya.id);
    assert.equal(scanned.payeeName, 'Priya Sharma');
    assert.equal(scanned.amountMinor, 250_000);
    console.log('  ✓ valid request resolves to the right payee and amount');
  }

  // ── 2. The token carries no payment details ─────────────────────────
  // This is novelty N3 stated as an assertion rather than a claim: decode the
  // payload and confirm there is nothing in it worth lying about.
  {
    const { token } = await dynamicQr.createRequest(rajesh.id, 5_000_000);
    const body = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    assert.deepEqual(
      Object.keys(body).sort().filter((k) => !['iat', 'exp'].includes(k)),
      ['req', 'v'],
      'the QR must carry only a version and a reference'
    );
    assert.ok(!JSON.stringify(body).includes('5000000'), 'amount must not appear in the token');
    assert.ok(!JSON.stringify(body).includes(rajesh.id), 'payee id must not appear in the token');
    console.log('  ✓ token carries only { v, req } — no payee, no amount');
    await dynamicQr.scan(token); // consume it so it does not linger
  }

  // ── 3. A swapped sticker cannot impersonate the shop ────────────────
  // The attacker's own perfectly valid request still displays the attacker's
  // real name, because the name comes from `accounts`, not from the code.
  {
    const { token } = await dynamicQr.createRequest(rajesh.id, 5_000_000); // ₹50,000
    const scanned = await dynamicQr.scan(token);
    assert.equal(scanned.payeeName, 'RAJESH K', 'must show the real account holder');
    assert.notEqual(scanned.payeeName, 'Priya Sharma');
    console.log('  ✓ attacker-generated request displays the attacker, not the shop');
  }

  // ── 4. An unsigned sticker is refused ───────────────────────────────
  {
    await expectFailure(() => dynamicQr.scan('not-a-jws-at-all'), 'QR_INVALID_SIGNATURE', 'garbage');

    // A well-formed JWS signed with the wrong key — the realistic forgery.
    const foreign = await new (await import('jose')).SignJWT({ v: 1, req: crypto.randomUUID() })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(new TextEncoder().encode('an-attacker-secret'));
    await expectFailure(() => dynamicQr.scan(foreign), 'QR_INVALID_SIGNATURE', 'foreign signature');
    console.log('  ✓ unsigned and wrongly-signed codes are refused');
  }

  // ── 5. A screenshot expires ─────────────────────────────────────────
  {
    const expired = await keyManager.signQrToken({ v: 1, req: crypto.randomUUID() }, -10);
    await expectFailure(() => dynamicQr.scan(expired), 'QR_EXPIRED', 'expired token');
    console.log('  ✓ an expired token is refused as QR_EXPIRED, not as a bad signature');
  }

  // ── 6. Single use ───────────────────────────────────────────────────
  {
    const { token } = await dynamicQr.createRequest(priya.id, 100_000);
    await dynamicQr.scan(token);
    await expectFailure(() => dynamicQr.scan(token), 'QR_ALREADY_USED', 'second scan');
    console.log('  ✓ a request can be scanned exactly once');
  }

  // ── 7. Concurrent scans: exactly one wins ───────────────────────────
  {
    const { token } = await dynamicQr.createRequest(priya.id, 100_000);
    const results = await Promise.allSettled([dynamicQr.scan(token), dynamicQr.scan(token)]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 1, 'exactly one of two simultaneous scans may succeed');
    console.log('  ✓ two simultaneous scans: exactly one succeeds');
  }

  await query(`DELETE FROM audit_logs WHERE transaction_id IS NULL AND event_type LIKE 'QR_%'`);
  console.log('\ndynamicQr.test.ts: all assertions passed\n');
}

run()
  .then(async () => {
    await pool.end();
    redis.disconnect();
  })
  .catch(async (err) => {
    console.error('\nFAILED:', err.message);
    await pool.end();
    redis.disconnect();
    process.exit(1);
  });
