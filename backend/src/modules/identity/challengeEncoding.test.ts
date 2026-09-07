/**
 * Self-check for the WebAuthn payment-challenge encoding.  Run: npm test
 *
 * The intent hash IS the challenge (novelty N1). `canonical.test.ts` pins the
 * hash string; this pins the one thing that string has to survive — a round
 * trip through @simplewebauthn/server's option builder.
 *
 * The trap: `generateAuthenticationOptions({ challenge: <string> })` treats a
 * string as arbitrary text and re-encodes it to base64url(utf8(challenge)), so
 * the browser would sign a value that is not the intent hash and every payment
 * would fail verification with a false SIG_INVALID. Passing the raw 32 sha256
 * bytes makes the library encode them straight back to the stored hash.
 */
import assert from 'node:assert/strict';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { intentHash } from '../../utils/canonical';

const h = intentHash({
  amountMinor: 500000,
  createdAt: 1788160000,
  currency: 'INR',
  expiresAt: 1788160090,
  lockVersion: 1,
  nonce: 'a3f9',
  payeeAccountId: 'priya_042',
  payerUserId: 'asha_001',
  txId: 'txn_91f',
});

async function main(): Promise<void> {
  assert.equal(h.length, 43, 'intent hash is 43-char unpadded base64url');

  // 1. The fix: raw bytes round-trip to exactly the stored hash.
  const fixed = await generateAuthenticationOptions({
    rpID: 'localhost',
    challenge: isoBase64URL.toBuffer(h),
  });
  assert.equal(fixed.challenge, h, 'toBuffer(hash) must yield options.challenge === intentHash');

  // 2. Buffer.from(_, 'base64url') is the documented equivalent fallback.
  const viaBuffer = await generateAuthenticationOptions({
    rpID: 'localhost',
    challenge: Buffer.from(h, 'base64url'),
  });
  assert.equal(viaBuffer.challenge, h, 'Buffer.from(hash, base64url) must also round-trip');

  // 3. The bug this guards against: a string challenge is re-encoded and no
  //    longer equals the intent hash.
  const buggy = await generateAuthenticationOptions({ rpID: 'localhost', challenge: h });
  assert.notEqual(buggy.challenge, h, 'passing the hash as a string is the bug — must not match');

  // 4. clientDataJSON.challenge (what the browser echoes) is compared verbatim
  //    against expectedChallenge by verifyAuthenticationResponse, so the value
  //    the authenticator signs must be exactly the stored hash.
  assert.equal(
    isoBase64URL.fromBuffer(isoBase64URL.toBuffer(fixed.challenge)),
    h,
    'challenge decodes and re-encodes to the intent hash'
  );

  console.log('challengeEncoding.test.ts: all assertions passed');
  console.log('  challenge === intent hash:', h);
}

main().catch((err) => {
  console.error('challengeEncoding.test.ts: FAILED');
  console.error(err);
  process.exit(1);
});
