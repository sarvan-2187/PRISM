import crypto from 'crypto';

/**
 * Crypto Utilities
 * Used primarily by the Intent-Lock Module.
 */

/**
 * Generate a cryptographically secure random nonce (hex string).
 */
export function generateNonce(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString('hex');
}

/**
 * Compute SHA-256 hash of a string.
 * Used to bind transaction details to the WebAuthn challenge.
 */
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
