/**
 * Typed client for the PRISM backend.
 *
 * Two rules this file exists to enforce:
 *  1. `credentials: 'include'` on every call — the session lives in an
 *     httpOnly cookie, and no user id is ever sent in a body.
 *  2. Every failure surfaces as an ApiError carrying the server's
 *     `failureCode`, so the UI switches on the documented catalogue instead
 *     of parsing prose.
 */

import type { startRegistration, startAuthentication } from '@simplewebauthn/browser';

/*
 * Empty by default so every request is relative ("/api/v1/...") and travels
 * through the Vite proxy. That keeps the app on ONE origin, which is what
 * makes it work over a tunnel: a hardcoded localhost:4000 would point at the
 * visitor's own machine, and a second origin would break the session cookie.
 * Override only if you deliberately want to hit a different backend.
 */
const API_URL = import.meta.env.VITE_API_URL ?? '';

/** Option shapes are derived from the library so they cannot drift out of sync. */
export type RegistrationOptions = Parameters<typeof startRegistration>[0];
export type AuthenticationOptions = Parameters<typeof startAuthentication>[0];

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly failureCode: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body.failureCode ?? 'UNKNOWN',
      body.message ?? `HTTP ${res.status}`,
      body.details
    );
  }
  return body as T;
}

// ── Shapes the server actually returns ────────────────────────────────

export interface TransactionView {
  txId: string;
  payeeName: string;
  payeeHandle: string;
  amountMinor: number;
  amountFormatted: string;
  currency: string;
  status: string;
  intentHash: string;
  expiresAt: string;
  secondsRemaining: number;
  riskScore: number | null;
  riskReasons: string[];
  failureCode: string | null;
  /** Server-recorded entry point; QR requests get an extra safety explanation. */
  origin: 'MANUAL' | 'QR';
  /** Which challenge a stepped-up transaction is waiting on. */
  stepUpMode?: 'SEMANTIC' | 'AUTHENTICATOR' | null;
}

/**
 * A history row. `direction` says which way the money went and
 * `counterparty` is whoever is at the other end, so the UI never has to work
 * out whether payeeName means "them" or "me".
 */
export interface StatementEntry extends TransactionView {
  direction: 'SENT' | 'RECEIVED';
  counterpartyName: string;
  counterpartyHandle: string;
}

export interface AuthenticatorDevice {
  id: string;
  label: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface Payee {
  accountId: string;
  displayName: string;
  handle: string;
  knownPayee: boolean;
}

export interface StepUpChallenge {
  prompt: string;
  payeeName: string;
  amountFormatted: string;
  expiresInSeconds: number;
  /** 3, 2, 1. At 0 the transaction is terminally blocked — there is no retry. */
  attemptsRemaining: number;
}

export interface TimelineEvent {
  at: string;
  event: string;
  data: Record<string, unknown>;
}

export type AuthorizeResult =
  | {
      decision: 'APPROVED';
      score: number;
      reasons: string[];
      settledAt: string;
      balanceMinor: number;
      balanceFormatted: string;
    }
  | {
      /** STEP_UP: risk engine. CONFIRM_CHANGE: policy REQUIRE_SEMANTIC. */
      decision: 'STEP_UP' | 'CONFIRM_CHANGE';
      score: number;
      reasons: string[];
      changes?: unknown;
      challenge: StepUpChallenge;
    };

export const api = {
  // Identity
  registerOptions: (email: string) =>
    request<RegistrationOptions>('/auth/register/options', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  registerVerify: (email: string, response: unknown) =>
    request<{ userId: string; displayName: string }>('/auth/register/verify', {
      method: 'POST',
      body: JSON.stringify({ email, response }),
    }),
  loginOptions: (email: string) =>
    request<AuthenticationOptions>('/auth/login/options', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  loginVerify: (email: string, response: unknown) =>
    request<{ userId: string; displayName: string }>('/auth/login/verify', {
      method: 'POST',
      body: JSON.stringify({ email, response }),
    }),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
  me: () =>
    request<{
      userId: string;
      email: string;
      displayName: string;
      balanceMinor: number;
      balanceFormatted: string;
    }>('/me'),

  // Payment
  payees: () => request<Payee[]>('/payees'),
  initiate: (payeeAccountId: string, amountMinor: number) =>
    request<TransactionView>('/payment/initiate', {
      method: 'POST',
      body: JSON.stringify({ payeeAccountId, amountMinor }),
    }),
  /** Server-authoritative details. The review screen renders ONLY this. */
  payment: (txId: string) => request<TransactionView>(`/payment/${txId}`),
  /** Options whose `challenge` IS the intent hash — the core binding. */
  challenge: (txId: string) =>
    request<AuthenticationOptions>(`/payment/${txId}/challenge`, { method: 'POST' }),
  authorize: (txId: string, assertion: unknown) =>
    request<AuthorizeResult>(`/payment/${txId}/authorize`, {
      method: 'POST',
      body: JSON.stringify({ assertion }),
    }),
  /** The signed challenge the PRISM Authenticator scans. AUTHENTICATOR mode only. */
  stepUpToken: (txId: string) =>
    request<{ token: string; expiresInSeconds: number }>(`/payment/${txId}/step-up/token`),
  stepUp: (txId: string, answer: string) =>
    request<{ ok: true; next: 'REAUTHORIZE' }>(`/payment/${txId}/step-up`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    }),

  // QR — payee mints a request, payer scans it
  /** Payee side: a signed, single-use, 60s payment request to show as a QR. */
  requestQr: (amountMinor: number) =>
    request<{ token: string; expiresInSeconds: number }>('/qr/request', {
      method: 'POST',
      body: JSON.stringify({ amountMinor }),
    }),
  /** Payer side: scanning returns a fully locked transaction of the payer's own. */
  scanQr: (token: string) =>
    request<TransactionView>('/qr/scan', { method: 'POST', body: JSON.stringify({ token }) }),

  // Audit
  timeline: (txId: string) =>
    request<{ transaction: TransactionView; events: TimelineEvent[] }>(
      `/transactions/${txId}/timeline`
    ),
  /** Statement: money out at any status, money in once settled. */
  history: () => request<StatementEntry[]>('/transactions'),

  // Devices
  credentials: () =>
    request<{ id: string; deviceType: string; createdAt: string; lastUsedAt: string | null }[]>(
      '/credentials'
    ),
  revoke: (id: string) => request<{ ok: true }>(`/credentials/${id}/revoke`, { method: 'POST' }),

  policy: () =>
    request<{
      intentTtlSeconds: number;
      qrTtlSeconds: number;
      stepUpMaxAttempts: number;
      riskThresholds: { stepUpThreshold: number; blockThreshold: number };
      disabledControls: string[];
    }>('/policy'),

  // ── Authenticator (paired second device) ─────────────────────────────

  /** Is there an active paired phone? Drives the Settings tab. */
  authenticator: () =>
    request<{ paired: boolean; device: AuthenticatorDevice | null }>('/authenticator'),

  /**
   * Mint a PENDING device and its secret.
   *
   * The secret is returned so the browser can DRAW it as a QR. It is never
   * sent back from the phone: on a plain-HTTP LAN a returned secret would be
   * readable on the wire. Same shape as an otpauth:// enrolment URI.
   */
  pairStart: () =>
    request<{ deviceId: string; secret: string; expiresAt: string; expiresInSeconds: number }>(
      '/authenticator/pair/start',
      { method: 'POST' }
    ),

  /**
   * Activate the pending device.
   *
   * Called from the PORTAL, not the phone: the route requires a session and
   * the phone has no cookie. The user confirms here after scanning.
   */
  pairConfirm: (deviceId: string) =>
    request<{ ok: true }>('/authenticator/pair/confirm', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    }),

  /** Lost phone. One-way, exactly like revoking a passkey. */
  authenticatorRevoke: () =>
    request<{ ok: true }>('/authenticator/revoke', { method: 'POST' }),

  // ── Cards ───────────────────────────────────────────────────────────
  // PENDING BACKEND (requested from S1). Both calls 404 until the cards
  // table and the payeeCardNumber branch of /payment/initiate exist, which
  // is exactly how the UI detects the feature: see cardsEnabled below.

  /** The signed-in user's own cards, for display. Doubles as the probe. */
  cards: () => request<CardView[]>('/cards'),

  /**
   * Send to a card number.
   *
   * The card is a POINTER, exactly like a QR code: the server resolves it to
   * an account and the returned transaction names the real recipient, which
   * the review screen then reads back. The intent hash binds the resolved
   * payeeAccountId, never the card number, so a card that resolves somewhere
   * unexpected is visible before approval rather than after.
   */
  initiateByCard: (payeeCardNumber: string, amountMinor: number) =>
    request<TransactionView>('/payment/initiate', {
      method: 'POST',
      body: JSON.stringify({ payeeCardNumber, amountMinor }),
    }),
};

export interface CardView {
  cardId: string;
  last4: string;
  network: string;
  holderName: string;
}

/**
 * Is card sending available on this build?
 *
 * Probed rather than assumed, so the tab is honest before the backend lands
 * and lights up on its own the moment it does, with no frontend change.
 */
export async function cardsEnabled(): Promise<boolean> {
  try {
    await api.cards();
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    // A 401 means signed out, not unsupported. Anything else is a real
    // outage, and treating it as "off" is the safe read either way.
    return false;
  }
}
