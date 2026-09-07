/**
 * Self-check for the attestation canonicaliser.  Run: npm run test:canon2
 *
 * A serialiser that disagrees with itself later produces authorization records
 * that fail their own verification. These assertions pin the properties the
 * chain depends on: key order does not matter, array order does, and the
 * ambiguous values JSON.stringify silently mangles are rejected outright.
 */
import assert from 'node:assert/strict';
import { canonicalJson, canonicalHash } from './attestationCanonical';

// 1. Key order is not meaning.
assert.equal(
  canonicalJson({ b: 1, a: 2, c: 3 }),
  canonicalJson({ c: 3, a: 2, b: 1 }),
  'object key order must not change the output'
);
assert.equal(canonicalJson({ a: 1, b: 2 }), '{"a":1,"b":2}');

// 2. Array order IS meaning.
assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]), 'array order is preserved');

// 3. Nested.
assert.equal(
  canonicalJson({ z: [{ y: 1, x: 2 }], a: 'k' }),
  '{"a":"k","z":[{"x":2,"y":1}]}'
);

// 4. The values JSON.stringify mangles are refused, not coerced.
assert.throws(() => canonicalJson({ a: undefined }), /undefined/, 'undefined is rejected');
assert.throws(() => canonicalJson({ a: NaN }), /non-finite/, 'NaN is rejected');
assert.throws(() => canonicalJson({ a: Infinity }), /non-finite/, 'Infinity is rejected');
assert.throws(() => canonicalJson({ a: 10n }), /bigint/, 'bigint is rejected');
assert.throws(() => canonicalJson({ a: new Date() }), /Date/, 'Date is rejected — pass an epoch int');
assert.throws(() => canonicalJson({ a: () => 0 }), /function/, 'function is rejected');

// 5. -0 and 0 hash the same.
assert.equal(canonicalJson({ a: -0 }), canonicalJson({ a: 0 }));

// 6. null and booleans.
assert.equal(canonicalJson({ a: null, b: true, c: false }), '{"a":null,"b":true,"c":false}');

// 7. Hash is 43-char base64url, matching the intent-hash form.
const h = canonicalHash({ stage: 'INTENT_LOCKED', seq: 0 });
assert.equal(h.length, 43);
assert.match(h, /^[A-Za-z0-9_-]+$/);

// 8. Same input, same hash. Different input, different hash.
assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));

console.log('attestationCanonical.test.ts: all assertions passed');
console.log('  sample hash:', h);
