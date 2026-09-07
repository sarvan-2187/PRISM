/**
 * Run: npm test
 *
 * The vector below is the SAME one asserted by
 * backend/src/modules/authenticator/otp.test.ts, but reached through a
 * different implementation: @noble/hashes here, node:crypto there. Agreeing
 * on these numbers is what proves a code typed off the phone will verify on
 * the server.
 */
import assert from 'node:assert';
import { approvalCode, denialCode, derive, toBase64Url, fromBase64Url, DENY_SUFFIX } from './otp';

const SECRET = Uint8Array.from(
  Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex')
);
const BINDING = 'a3f1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80';

// 1. The cross-implementation vector. Do not change without changing the
//    backend test in the same commit.
assert.strictEqual(approvalCode(SECRET, BINDING), '944316', 'approval vector');
assert.strictEqual(denialCode(SECRET, BINDING), '047685', 'denial vector');
console.log('  ok  matches the backend vector: 944316 / 047685');

// 2. Six digits with the leading zero intact.
assert.strictEqual(denialCode(SECRET, BINDING).length, 6);
assert.ok(denialCode(SECRET, BINDING).startsWith('0'));
console.log('  ok  zero padding holds');

// 3. Binding and domain separation.
assert.notStrictEqual(derive(SECRET, 'b' + BINDING.slice(1)), approvalCode(SECRET, BINDING));
assert.notStrictEqual(approvalCode(SECRET, BINDING), denialCode(SECRET, BINDING));
assert.strictEqual(denialCode(SECRET, BINDING), derive(SECRET, BINDING + DENY_SUFFIX));
console.log('  ok  binding and deny-suffix separation hold');

// 4. base64url round-trip: this is how the secret crosses the pairing QR, so
//    a padding or alphabet slip here breaks every code the device ever makes.
const rt = fromBase64Url(toBase64Url(SECRET));
assert.deepStrictEqual(Array.from(rt), Array.from(SECRET), 'secret round-trip');
assert.ok(!toBase64Url(SECRET).includes('='), 'no padding in the URI');
assert.ok(!/[+/]/.test(toBase64Url(SECRET)), 'url-safe alphabet only');
console.log('  ok  base64url round-trips the secret exactly');

// 5. A secret that survived the QR still produces the same code.
assert.strictEqual(approvalCode(rt, BINDING), '944316', 'code survives pairing transport');
console.log('  ok  a paired secret produces the same code');

console.log('[otp] all assertions passed');
