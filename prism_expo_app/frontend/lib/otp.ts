/**
 * The PRISM Authenticator primitive.
 *
 * MUST stay byte-identical to backend/src/modules/authenticator/otp.ts.
 * Both files assert the same fixture in their tests, so a change to one
 * without the other fails the build rather than silently rejecting every
 * code a user types.
 *
 *   code = HMAC-SHA256(device_secret, binding)
 *        -> low 31 bits via dynamic truncation (RFC 4226 section 5.3)
 *        -> % 1_000_000
 *        -> zero-padded to 6 digits
 *
 * There is deliberately NO time counter. TOTP's 30-second window exists
 * because a login has no other source of freshness; PRISM's flows already
 * have one — the intent nonce and its TTL, or the WebAuthn challenge. Leaving
 * the counter out removes clock skew as a failure mode (a phone whose clock
 * drifted cannot break the demo) and makes the code deterministic per
 * transaction, which is what lets the phone work with no network at all.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** Domain separation for the "this isn't me" code, matching the HKDF info-string convention in keyManager.ts. */
export const DENY_SUFFIX = ':deny';

const DIGITS = 6;
const MODULUS = 1_000_000;

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * @param secret the device secret, raw bytes as stored at pairing
 * @param binding what is being authorized: an intent hash, an intent hash
 *        plus DENY_SUFFIX, or a WebAuthn login challenge
 */
export function derive(secret: Uint8Array, binding: string): string {
  const mac = hmac(sha256, secret, utf8(binding));

  // RFC 4226 section 5.3: the low 4 bits of the last byte choose where to
  // read, so the digits depend on the whole MAC rather than a fixed slice.
  const offset = mac[mac.length - 1] & 0x0f;
  const truncated =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];

  return String(truncated % MODULUS).padStart(DIGITS, '0');
}

/** The code that approves a payment. */
export function approvalCode(secret: Uint8Array, intentHash: string): string {
  return derive(secret, intentHash);
}

/**
 * The code that refuses one.
 *
 * Looks identical to an approval code, which is the point: a victim being
 * coached through a transfer can read this out and quarantine the payment
 * instead of authorizing it, with nothing on screen to give it away.
 */
export function denialCode(secret: Uint8Array, intentHash: string): string {
  return derive(secret, intentHash + DENY_SUFFIX);
}

/** The code that completes a portal sign-in. */
export function loginCode(secret: Uint8Array, challenge: string): string {
  return derive(secret, challenge);
}

// ── base64url, for the secret as it travels through the pairing QR ──────

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
