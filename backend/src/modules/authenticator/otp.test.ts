/**
 * Run: npm run test:otp
 *
 * The first assertion is a SHARED VECTOR. auth_expo_app/lib/otp.test.ts
 * asserts the same three numbers against its own independent implementation
 * (@noble/hashes, not node:crypto). If either side drifts, one of the two
 * tests fails — instead of the phone quietly producing codes the server
 * rejects, which is a bug you would otherwise only find in front of a judge.
 */
import assert from 'node:assert';
import { approvalCode, denialCode, derive, codesMatch, DENY_SUFFIX } from './otp';

const SECRET = Buffer.from(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'hex'
);
const BINDING = 'a3f1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80';

// 1. Known vector. Must match auth_expo_app/lib/otp.test.ts exactly.
assert.strictEqual(approvalCode(SECRET, BINDING), '944316', 'approval vector');
assert.strictEqual(denialCode(SECRET, BINDING), '047685', 'denial vector');
console.log('  ok  shared vector: approval 944316, denial 047685');

// 2. The denial code keeps its leading zero. A naive String(n) would render
//    this as "47685" and every deny would be rejected as the wrong length.
assert.strictEqual(denialCode(SECRET, BINDING).length, 6, 'six digits, always');
assert.ok(denialCode(SECRET, BINDING).startsWith('0'), 'leading zero preserved');
console.log('  ok  zero padding holds');

// 3. Transaction binding: flip one character of the binding, get another code.
const flipped = derive(SECRET, 'b' + BINDING.slice(1));
assert.notStrictEqual(flipped, approvalCode(SECRET, BINDING), 'binding must matter');
console.log('  ok  a changed binding changes the code');

// 4. Domain separation: approving and denying the SAME transaction differ.
assert.notStrictEqual(
  approvalCode(SECRET, BINDING),
  denialCode(SECRET, BINDING),
  'deny suffix must separate the domains'
);
assert.strictEqual(denialCode(SECRET, BINDING), derive(SECRET, BINDING + DENY_SUFFIX));
console.log('  ok  approval and denial are different codes');

// 5. A code minted for transaction A does not authorize transaction B. This is
//    the property the whole design rests on.
const txA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888';
const txB = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8889';
assert.notStrictEqual(approvalCode(SECRET, txA), approvalCode(SECRET, txB), 'cross-transaction replay');
console.log('  ok  a code for one transaction is not valid for another');

// 6. A different device secret produces a different code for the same payment.
const otherSecret = Buffer.alloc(32, 0xab);
assert.notStrictEqual(approvalCode(otherSecret, BINDING), approvalCode(SECRET, BINDING));
console.log('  ok  the code is bound to the device secret');

// 7. Comparison is length-safe and rejects near misses.
assert.ok(codesMatch('944316', approvalCode(SECRET, BINDING)), 'exact match');
assert.ok(codesMatch(' 944316 ', approvalCode(SECRET, BINDING)), 'trims what a user typed');
assert.ok(!codesMatch('94431', approvalCode(SECRET, BINDING)), 'short code');
assert.ok(!codesMatch('944317', approvalCode(SECRET, BINDING)), 'off by one digit');
assert.ok(!codesMatch('', approvalCode(SECRET, BINDING)), 'empty');
console.log('  ok  codesMatch rejects short, wrong and empty input');

console.log('[otp] all assertions passed');
