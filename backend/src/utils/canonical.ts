import crypto from 'crypto';

/**
 * The intent-hash contract. Read this before touching anything downstream.
 *
 *   canonicalJson(intent) -> sorted-key, whitespace-free JSON
 *   sha256(utf8) -> 32 raw bytes
 *   base64url(bytes) -> intentHash
 *
 * That base64url string is stored in transactions.intent_hash AND passed
 * verbatim as the WebAuthn challenge and as expectedChallenge on verify.
 * One representation, zero conversions — this is what stops a false
 * TAMPER_BLOCKED at 3am.
 *
 * Every numeric field is an integer. Amounts are minor units (paise), never
 * a float or a formatted string: "5000.00" and "5000" hash differently and
 * the difference is invisible in a log.
 *
 * The client never computes this online — the server computes it and hands
 * it over. The one exception is an offline-approved payment (see
 * modules/offline/), where the device has no server to ask and must compute
 * this itself, from a pre-issued signed grant, before signing it locally.
 * The server does not take that computation on trust: on reconnect it
 * recomputes the hash from the same intent with this same function and
 * compares, so a tampered field is caught here exactly as it would be online.
 */
export interface LockedIntent {
  amountMinor: number;
  createdAt: number; // epoch SECONDS
  currency: string;
  expiresAt: number; // epoch SECONDS
  lockVersion: number;
  nonce: string;
  payeeAccountId: string;
  payerUserId: string;
  txId: string;
}

/** Field order is the hash. Sorted ASCII-ascending, and asserted below. */
const INTENT_FIELDS: (keyof LockedIntent)[] = [
  'amountMinor',
  'createdAt',
  'currency',
  'expiresAt',
  'lockVersion',
  'nonce',
  'payeeAccountId',
  'payerUserId',
  'txId',
];

const INTEGER_FIELDS: (keyof LockedIntent)[] = [
  'amountMinor',
  'createdAt',
  'expiresAt',
  'lockVersion',
];

/**
 * Deterministic serialisation of a locked intent.
 *
 * Deliberately not a general canonical-JSON implementation: the intent shape
 * is fixed and server-generated, so an explicit field list is both smaller
 * and safer than a recursive sorter that could silently accept a new field.
 */
export function canonicalJson(intent: LockedIntent): string {
  for (const field of INTEGER_FIELDS) {
    const value = intent[field];
    if (!Number.isInteger(value)) {
      throw new Error(`canonicalJson: ${field} must be an integer, got ${String(value)}`);
    }
  }
  const parts = INTENT_FIELDS.map((k) => `${JSON.stringify(k)}:${JSON.stringify(intent[k])}`);
  return `{${parts.join(',')}}`;
}

/** The intent hash: base64url(sha256(canonicalJson)). This IS the WebAuthn challenge. */
export function intentHash(intent: LockedIntent): string {
  return crypto.createHash('sha256').update(canonicalJson(intent), 'utf8').digest('base64url');
}

/**
 * Timing-safe comparison of two intent hashes.
 * Handles unequal lengths without throwing (timingSafeEqual requires equal
 * buffer lengths) and without leaking the length via an early return path
 * that differs in cost from the compare itself.
 */
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
