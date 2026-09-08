/**
 * The PRISM Authenticator primitive.   OWNER: S2
 *
 * MUST stay byte-identical to auth_expo_app/lib/otp.ts. Both files assert the
 * same fixture (see otp.test.ts), so a change to one without the other fails
 * the test rather than silently rejecting every code a user types.
 *
 *   code = HMAC-SHA256(device_secret, binding)
 *        -> low 31 bits via dynamic truncation (RFC 4226 section 5.3)
 *        -> % 1_000_000
 *        -> zero-padded to 6 digits
 *
 * There is deliberately NO time counter. TOTP's 30-second window exists
 * because a login has no other source of freshness; PRISM's flows already
 * have one — the intent nonce and its TTL (policy.stepUp.ttlSeconds), or the
 * WebAuthn challenge. Leaving the counter out removes clock skew as a failure
 * mode and makes the code deterministic per transaction, which is what lets
 * the phone verify with no network at all.
 *
 * Pure: no I/O, no imports from the rest of the app. Secrets arrive as bytes
 * from devices.ts and are never logged.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Domain separation, matching the HKDF info-string convention in keyManager.ts. */
export const DENY_SUFFIX = ':deny';

const DIGITS = 6;
const MODULUS = 1_000_000;

/**
 * @param secret the device secret as stored in authenticator_devices.secret
 * @param binding what is being authorized: an intent hash, an intent hash
 *        plus DENY_SUFFIX, or a WebAuthn login challenge
 */
export function derive(secret: Buffer | Uint8Array, binding: string): string {
  const mac = createHmac('sha256', Buffer.from(secret)).update(binding, 'utf8').digest();

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

export function approvalCode(secret: Buffer | Uint8Array, intentHash: string): string {
  return derive(secret, intentHash);
}

/**
 * The code that refuses a payment.
 *
 * Indistinguishable from an approval code on screen, which is the point: a
 * victim being coached through a transfer can read this out and quarantine
 * the payment instead of authorizing it.
 */
export function denialCode(secret: Buffer | Uint8Array, intentHash: string): string {
  return derive(secret, intentHash + DENY_SUFFIX);
}

export function loginCode(secret: Buffer | Uint8Array, challenge: string): string {
  return derive(secret, challenge);
}

/**
 * Compare a submitted code against an expected one in constant time.
 *
 * The attempt cap (policy.stepUp.maxAttempts) is the real defence against
 * guessing, but a plain === leaks position-of-first-difference through timing,
 * and there is no reason to hand that away for free.
 */
export function codesMatch(submitted: string, expected: string): boolean {
  const a = Buffer.from(submitted.trim(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
