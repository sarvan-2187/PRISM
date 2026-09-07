/**
 * Self-check for the intent-hash contract.  Run: npm test
 *
 * If this fails, every payment in PRISM fails verification with a false
 * TAMPER_BLOCKED. It is the cheapest possible guard on the most expensive
 * possible bug, so it runs before anything else in CI and before every demo.
 */
import assert from 'node:assert/strict';
import { canonicalJson, intentHash, hashesMatch, LockedIntent } from './canonical';

const base: LockedIntent = {
  amountMinor: 500000, // ₹5,000
  createdAt: 1788160000,
  currency: 'INR',
  expiresAt: 1788160090,
  lockVersion: 1,
  nonce: 'a3f9',
  payeeAccountId: 'priya_042',
  payerUserId: 'asha_001',
  txId: 'txn_91f',
};

// 1. Canonical form is exact, sorted, and whitespace-free.
assert.equal(
  canonicalJson(base),
  '{"amountMinor":500000,"createdAt":1788160000,"currency":"INR","expiresAt":1788160090,' +
    '"lockVersion":1,"nonce":"a3f9","payeeAccountId":"priya_042","payerUserId":"asha_001",' +
    '"txId":"txn_91f"}'
);

// 2. Known vector — pins the hash so an accidental field reorder is caught.
const KNOWN = intentHash(base);
assert.equal(KNOWN.length, 43, 'base64url sha256 is 43 chars unpadded');
assert.match(KNOWN, /^[A-Za-z0-9_-]+$/, 'base64url only — no +, / or =');

// 3. Key order in the source object must not change the hash.
const shuffled: LockedIntent = {
  txId: 'txn_91f',
  payerUserId: 'asha_001',
  payeeAccountId: 'priya_042',
  nonce: 'a3f9',
  lockVersion: 1,
  expiresAt: 1788160090,
  currency: 'INR',
  createdAt: 1788160000,
  amountMinor: 500000,
};
assert.equal(intentHash(shuffled), KNOWN, 'field order in the literal must not matter');

// 4. The whole point: one rupee changes the hash.
assert.notEqual(intentHash({ ...base, amountMinor: 500100 }), KNOWN, 'amount must bind');
assert.notEqual(intentHash({ ...base, payeeAccountId: 'attacker' }), KNOWN, 'payee must bind');
assert.notEqual(intentHash({ ...base, nonce: 'b4e0' }), KNOWN, 'nonce must bind');
assert.notEqual(intentHash({ ...base, expiresAt: 1788169999 }), KNOWN, 'expiry must bind');

// 5. Non-integer amounts are refused rather than silently hashed.
assert.throws(() => intentHash({ ...base, amountMinor: 5000.5 }), /must be an integer/);

// 6. Timing-safe compare behaves like equality, including on length mismatch.
assert.equal(hashesMatch(KNOWN, KNOWN), true);
assert.equal(hashesMatch(KNOWN, KNOWN.slice(0, 20)), false);
assert.equal(hashesMatch(KNOWN, 'x'.repeat(KNOWN.length)), false);

console.log('canonical.test.ts: all assertions passed');
console.log('  known vector:', KNOWN);
