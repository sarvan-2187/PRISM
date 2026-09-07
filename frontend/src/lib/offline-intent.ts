/**
 * Client-side port of the intent-hash contract — BLACKOUT (FC-01-A).
 *
 * Every other screen in PRISM never computes this: backend/src/utils/canonical.ts
 * says so outright, "the client never computes this online." Offline is the
 * one exception the whole card is about — there is no server to ask, so the
 * device must build the exact same canonical form and hash it itself, then
 * sign that hash locally.
 *
 * This file MUST stay byte-for-byte identical to the backend's algorithm:
 * same field list, same order, same separators, same encoding. A drift here
 * doesn't crash — it produces a hash the server recomputes differently on
 * redemption, which reads as TAMPER_BLOCKED on a perfectly honest payment.
 * See backend/src/utils/canonical.ts and its pinned vector in canonical.test.ts;
 * this port is checked against that exact vector — see the header comment on
 * LockedIntent below for the value.
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

/** Field order IS the hash. Copied verbatim from backend/src/utils/canonical.ts — do not reorder. */
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

const INTEGER_FIELDS: (keyof LockedIntent)[] = ['amountMinor', 'createdAt', 'expiresAt', 'lockVersion'];

/** Deterministic serialisation — must match backend canonicalJson() exactly. */
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

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The intent hash: base64url(sha256(canonicalJson)). This becomes the
 * WebAuthn challenge, exactly as it does online — see lib/webauthn-client.ts.
 * Uses window.crypto.subtle, which requires a secure context; PRISM already
 * requires one for WebAuthn itself, so nothing new is demanded here.
 */
export async function intentHash(intent: LockedIntent): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(intent));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toBase64Url(digest);
}
