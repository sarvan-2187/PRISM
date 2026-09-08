/**
 * Ed25519 verification of a web-portal step-up token.
 *
 * Ported from auth_expo_app/lib/verify.ts: this app now doubles as the
 * PRISM Authenticator for its own account, since it already holds the same
 * pairing secret (see lib/store.ts). Why this is not optional: the app shows
 * the payee and amount from the scanned or polled token so the user can
 * compare them against what the portal claims. If the token were unsigned,
 * anyone who can render a QR (or answer a poll) controls that display — which
 * is exactly the fraud PRISM exists to stop.
 *
 * Verification needs only the public key, so this whole check — and the code
 * derivation that follows it — runs with no network at all.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { fromBase64Url } from './otp';

export interface StepUpToken {
  txId: string;
  intentHash: string;
  payee: string;
  payeeIsNew?: boolean;
  amountMinor: number;
  currency: string;
  score?: number;
  reasons?: string[];
  /** Unix seconds. The portal's own countdown; shown, never trusted for auth. */
  exp?: number;
}

export type VerifyResult = { ok: true; token: StepUpToken } | { ok: false; reason: string };

/**
 * Parse and verify a compact JWS-style token: base64url(header).base64url(payload).base64url(sig)
 * signed with Ed25519, matching keyManager.signQrToken on the server.
 */
export function verifyToken(compact: string, publicKeyJwk: string): VerifyResult {
  const parts = compact.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'This is not a PRISM code.' };

  let pub: Uint8Array;
  try {
    const jwk = JSON.parse(publicKeyJwk) as { x?: string };
    if (!jwk.x) return { ok: false, reason: 'Stored server key is unusable. Pair again.' };
    pub = fromBase64Url(jwk.x);
  } catch {
    return { ok: false, reason: 'Stored server key is unusable. Pair again.' };
  }

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let good = false;
  try {
    good = ed25519.verify(fromBase64Url(parts[2]), signed, pub);
  } catch {
    good = false;
  }
  if (!good) {
    // The single most important error in the app. Say what it means, not
    // what failed: a wrong signature here IS the attack.
    return { ok: false, reason: 'This code was not issued by PRISM. Do not trust it.' };
  }

  try {
    const token = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as StepUpToken;
    if (!token.intentHash) return { ok: false, reason: 'This code is missing its transaction.' };
    return { ok: true, token };
  } catch {
    return { ok: false, reason: 'This code is damaged. Ask for a fresh one.' };
  }
}

/** Rupees from paise, grouped the Indian way. */
export function formatMinor(minor: number, currency = 'INR'): string {
  const symbol = currency === 'INR' ? '₹' : '';
  return symbol + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

/** Fetch and cache the server's signing key. Called once, at pairing. */
export async function fetchServerKey(apiBase: string): Promise<string | null> {
  try {
    const res = await fetch(`${apiBase}/.well-known/prism-keys`);
    if (!res.ok) return null;
    const body = (await res.json()) as { keys?: { jwk?: unknown }[] };
    const jwk = body.keys?.[0]?.jwk;
    return jwk ? JSON.stringify(jwk) : null;
  } catch {
    return null;
  }
}
