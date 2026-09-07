/**
 * Network micro-fingerprinting — pure functions, no I/O.
 *
 * Kept separate from fingerprint.ts because address arithmetic is fiddly
 * enough to deserve its own tests, and because the previous version of this
 * logic was one line that was wrong in both directions at once:
 *
 *     ipPrefix: (req.ip ?? '').split('.').slice(0, 2).join('.')
 *
 *   - 192.168.1.44 and 192.168.9.7 both became "192.168", so every private
 *     network collapsed to the same value and real drift was invisible;
 *   - splitting on '.' never matches IPv6, so a full v6 address was stored
 *     verbatim as its own "prefix" — while the module promised coarse,
 *     hashed, short-retention features;
 *   - and because it kept the interface identifier, IPv6 privacy extensions
 *     (which rotate that identifier routinely) tripped the drift signal on
 *     their own.
 *
 * Privacy boundary: nothing here is a tracking identifier. The subnet is
 * hashed before it is stored, because the only question ever asked of it is
 * "is this the same as last time?" — and equality does not need plaintext.
 */
import crypto from 'crypto';

export type AddressFamily = 'ipv4' | 'ipv6' | 'unknown';

export interface NetworkProfile {
  /** Human-readable subnet, e.g. "192.168.1.0/24". For logs and tests only. */
  subnet: string;
  family: AddressFamily;
  /**
   * Loopback, RFC1918, link-local, CGNAT. Callers must treat a private
   * address as *no network evidence* rather than as a network: on localhost
   * every request looks identical, and identical is not the same as trusted.
   */
  isPrivate: boolean;
  /** What actually gets stored. Salted per-deployment via the caller's hash. */
  networkId: string;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** `::ffff:127.0.0.1` is how Node commonly reports v4 clients on a dual stack. */
function unwrapMapped(ip: string): string {
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  return m ? m[1] : ip;
}

function isPrivateV4(o: number[]): boolean {
  const [a, b] = o;
  return (
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 169 && b === 254) || // link-local
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a === 0
  );
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  return (
    s === '::1' || // loopback
    s === '::' ||
    s.startsWith('fe80:') || // link-local
    /^f[cd]/.test(s) // unique local fc00::/7
  );
}

/** Expand an IPv6 address to eight 16-bit groups so slicing is unambiguous. */
function expandV6(ip: string): string[] | null {
  const s = ip.split('%')[0].toLowerCase(); // strip zone index
  if (!/^[0-9a-f:]+$/.test(s) || !s.includes(':')) return null;

  const [head, tail, ...rest] = s.split('::');
  if (rest.length) return null; // more than one "::" is malformed

  const left = head ? head.split(':').filter(Boolean) : [];
  const right = tail !== undefined ? (tail ? tail.split(':').filter(Boolean) : []) : [];

  let groups: string[];
  if (tail === undefined) {
    groups = left; // no "::" — must already be full
  } else {
    const gap = 8 - left.length - right.length;
    if (gap < 0) return null;
    groups = [...left, ...Array(gap).fill('0'), ...right];
  }
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, '0'));
}

/**
 * Reduce an address to the coarsest thing that still detects a real move.
 *
 * IPv4 → /24: narrow enough to notice a change of network, coarse enough that
 * it does not single out a household.
 * IPv6 → /48: deliberately above the /64 where privacy extensions rotate, so
 * an ordinary client does not look like it is hopping networks every hour.
 */
export function normaliseSubnet(rawIp: string | null | undefined): NetworkProfile {
  const ip = unwrapMapped(String(rawIp ?? '').trim());

  const v4 = IPV4.exec(ip);
  if (v4) {
    const o = v4.slice(1, 5).map(Number);
    if (o.every((n) => n >= 0 && n <= 255)) {
      const subnet = `${o[0]}.${o[1]}.${o[2]}.0/24`;
      return { subnet, family: 'ipv4', isPrivate: isPrivateV4(o), networkId: hash(subnet) };
    }
  }

  const groups = expandV6(ip);
  if (groups) {
    const subnet = `${groups[0]}:${groups[1]}:${groups[2]}::/48`;
    return { subnet, family: 'ipv6', isPrivate: isPrivateV6(ip), networkId: hash(subnet) };
  }

  // Unparseable. Treated as private so it can never masquerade as evidence.
  return { subnet: 'unknown', family: 'unknown', isPrivate: true, networkId: hash('unknown') };
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Did the payer's network genuinely change?
 *
 * Returns false whenever either side is private. On localhost both sides are
 * `::1`: equal, but that equality is an artefact of the demo, not evidence
 * the payer stayed put — and a private-to-public comparison is a deployment
 * change, not a user moving.
 */
export interface NetworkMark {
  networkId?: string;
  isPrivate?: boolean;
}

export function networkChanged(baseline: NetworkMark | null, current: NetworkMark): boolean {
  // A baseline written before this field existed reads as unknown, not as
  // changed. Otherwise every session in flight at deploy time would trip the
  // signal at once.
  if (!baseline?.networkId || !current.networkId) return false;
  if (baseline.isPrivate || current.isPrivate) return false;
  return baseline.networkId !== current.networkId;
}

// ── Impossible travel ─────────────────────────────────────────────────────

export interface GeoPoint {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Was the account used from two places too far apart to travel between?
 *
 * Null at either end means we could not place the request, and an
 * unmeasurable situation is not evidence of anything — so it returns false.
 * That is the normal case here: see geoForIp() below.
 */
export function impossibleTravel(
  from: GeoPoint | null,
  to: GeoPoint | null,
  elapsedMs: number,
  maxPlausibleKmH: number
): boolean {
  if (!from || !to) return false;
  if (elapsedMs <= 0) return false;
  const hours = elapsedMs / 3_600_000;
  return distanceKm(from, to) / hours > maxPlausibleKmH;
}

/**
 * Locating an IP requires a geolocation database or a third-party service.
 *
 * We deliberately have neither. A lookup service would put an outbound call
 * on the payment path — latency, plus a hard failure if the venue wifi drops
 * mid-demo — and would mean sending user IPs to an outside party, which
 * contradicts the privacy boundary this design claims. An embedded database
 * would be inert here anyway, since the demo runs on loopback.
 *
 * So impossibleTravel() is implemented, unit-tested, and never fires. This is
 * a designed-not-active control, stated as such rather than presented as
 * working. Plugging in a source is this one function.
 */
export function geoForIp(_profile: NetworkProfile): GeoPoint | null {
  return null;
}
