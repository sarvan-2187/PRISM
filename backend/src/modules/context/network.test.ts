/**
 * Network micro-fingerprinting.   Run: npm run test:network      OWNER: S2
 *
 * Every case in section 1 is a regression against a real defect. The previous
 * implementation was `ip.split('.').slice(0, 2).join('.')`, which was wrong in
 * both directions at once: too blunt to see a real move on IPv4, and so
 * sensitive on IPv6 that an ordinary client tripped the drift signal by
 * itself. This file is what stops that coming back.
 *
 * Pure functions only — no Redis, no Postgres, no server.
 */
import assert from 'node:assert/strict';
import {
  normaliseSubnet,
  networkChanged,
  impossibleTravel,
  distanceKm,
  geoForIp,
} from './network';
import { policy } from '../../config/policy';

const id = (ip: string) => normaliseSubnet(ip).networkId;

console.log('\nNetwork micro-fingerprinting\n');

// ── 1. The bug table, as regressions ──────────────────────────────────

// Was: both collapsed to "192.168", so a change of network was invisible.
assert.notEqual(id('192.168.1.44'), id('192.168.9.7'), 'different /24s must differ');
assert.equal(id('192.168.1.44'), id('192.168.1.201'), 'same /24 must match');
console.log('  ✓ IPv4 graded at /24 — different subnets now distinguishable');

// Was: the interface identifier was kept, so IPv6 privacy extensions — which
// rotate it routinely — made a stationary client look like it kept moving.
assert.equal(
  id('2001:db8:85a3::8a2e:370:7334'),
  id('2001:db8:85a3::9999:1'),
  'same /48 must match despite a rotated interface identifier'
);
assert.notEqual(
  id('2001:db8:85a3::1'),
  id('2001:db8:9999::1'),
  'different /48s must differ'
);
console.log('  ✓ IPv6 graded at /48 — privacy-extension rotation no longer looks like drift');

// Was: split('.') produced "::ffff:127.0" for the IPv4-mapped form Node
// commonly returns on a dual stack.
const mapped = normaliseSubnet('::ffff:127.0.0.1');
assert.equal(mapped.family, 'ipv4', 'IPv4-mapped IPv6 must be unwrapped to IPv4');
assert.equal(mapped.isPrivate, true, 'loopback must be flagged private');
assert.equal(mapped.networkId, id('127.0.0.1'), 'mapped and plain loopback must agree');
console.log('  ✓ ::ffff:127.0.0.1 unwraps to loopback and is flagged private');

// Was: a full IPv6 address was stored verbatim as its own "prefix", while the
// module promised coarse, hashed features.
const v6 = normaliseSubnet('2001:db8:85a3::8a2e:370:7334');
assert.ok(!v6.networkId.includes(':'), 'stored id must not be an address');
assert.ok(!v6.networkId.includes('8a2e'), 'stored id must not leak the host part');
assert.match(v6.networkId, /^[0-9a-f]{16}$/, 'stored id is a truncated hash');
console.log('  ✓ what is stored is a hash, not an address');

// ── 2. Address classification ─────────────────────────────────────────

for (const priv of ['10.0.0.5', '172.16.4.1', '192.168.0.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1']) {
  assert.equal(normaliseSubnet(priv).isPrivate, true, `${priv} must be private`);
}
for (const pub of ['203.0.113.7', '8.8.8.8', '2001:db8::1']) {
  assert.equal(normaliseSubnet(pub).isPrivate, false, `${pub} must be public`);
}
assert.equal(normaliseSubnet('172.32.0.1').isPrivate, false, '172.32 is outside RFC1918');
assert.equal(normaliseSubnet('999.1.1.1').family, 'unknown', 'octets over 255 are not IPv4');
assert.equal(normaliseSubnet('').isPrivate, true, 'unparseable must never count as evidence');
assert.equal(normaliseSubnet(null).isPrivate, true, 'null must never count as evidence');
console.log('  ✓ private, public and unparseable addresses classified correctly');

// ── 3. Drift, and when it must stay silent ────────────────────────────

const home = normaliseSubnet('203.0.113.7');
const cafe = normaliseSubnet('198.51.100.9');
const loopback = normaliseSubnet('::1');

assert.equal(networkChanged(home, cafe), true, 'public -> different public is drift');
assert.equal(networkChanged(home, normaliseSubnet('203.0.113.90')), false, 'same /24 is not drift');

// The demo runs entirely on loopback. If either of these ever returns true,
// every payment in the demo picks up a spurious NETWORK_CHANGED.
assert.equal(networkChanged(loopback, loopback), false, 'loopback to loopback is not drift');
assert.equal(networkChanged(loopback, home), false, 'private -> public is a deployment change');
assert.equal(networkChanged(home, loopback), false, 'public -> private is a deployment change');
console.log('  ✓ private addresses never raise drift — the demo cannot misfire on localhost');

// A baseline written before this field existed must read as unknown, not as
// changed, or every session in flight at deploy time trips at once.
assert.equal(networkChanged(null, home), false, 'no baseline is not drift');
assert.equal(networkChanged({}, home), false, 'legacy baseline without networkId is not drift');
assert.equal(
  networkChanged({ ipPrefix: '203.0' } as never, home),
  false,
  'a pre-upgrade baseline shape is not drift'
);
console.log('  ✓ stale baselines read as unknown, not as changed');

// ── 4. Impossible travel ──────────────────────────────────────────────

const CHENNAI = { lat: 13.0827, lon: 80.2707 };
const DELHI = { lat: 28.6139, lon: 77.209 };
const MADURAI = { lat: 9.9252, lon: 78.1198 };

const chennaiDelhi = distanceKm(CHENNAI, DELHI);
assert.ok(chennaiDelhi > 1700 && chennaiDelhi < 1800, `Chennai-Delhi ~1760km, got ${chennaiDelhi}`);
assert.equal(Math.round(distanceKm(CHENNAI, CHENNAI)), 0, 'a point is zero from itself');

const MIN = 60_000;
assert.equal(
  impossibleTravel(CHENNAI, DELHI, 4 * MIN, policy.maxPlausibleKmH),
  true,
  'Chennai to Delhi in 4 minutes is impossible'
);
assert.equal(
  impossibleTravel(CHENNAI, DELHI, 4 * 60 * MIN, policy.maxPlausibleKmH),
  false,
  'Chennai to Delhi in 4 hours is a flight, not an attack'
);
assert.equal(
  impossibleTravel(CHENNAI, MADURAI, 8 * 60 * MIN, policy.maxPlausibleKmH),
  false,
  'Chennai to Madurai overnight is a drive'
);
console.log(`  ✓ travel maths: Chennai-Delhi ${Math.round(chennaiDelhi)}km, 4min impossible, 4h fine`);

// An unmeasurable situation is not evidence of anything.
assert.equal(impossibleTravel(null, DELHI, MIN, policy.maxPlausibleKmH), false, 'null origin');
assert.equal(impossibleTravel(CHENNAI, null, MIN, policy.maxPlausibleKmH), false, 'null target');
assert.equal(impossibleTravel(CHENNAI, DELHI, 0, policy.maxPlausibleKmH), false, 'zero elapsed');
assert.equal(impossibleTravel(CHENNAI, DELHI, -1, policy.maxPlausibleKmH), false, 'negative elapsed');
console.log('  ✓ an unplaceable or untimed request never fires the signal');

// ── 5. The honest limitation, asserted rather than claimed ────────────

assert.equal(
  geoForIp(normaliseSubnet('203.0.113.7')),
  null,
  'geoForIp is a deliberate stub — PRISM ships no geolocation source'
);
console.log('  ✓ geoForIp returns null by design, so IMPOSSIBLE_TRAVEL cannot fire in this build');

console.log('\nnetwork.test.ts: all assertions passed\n');
