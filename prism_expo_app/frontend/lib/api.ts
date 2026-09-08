/**
 * Typed client for the PRISM App API (prism_expo_app/backend, :4100).
 *
 * Two rules this file exists to enforce, mirroring the web client:
 *  1. The session travels as a Bearer token from secure storage, never in a
 *     body and never as a user id the client picks.
 *  2. Every failure surfaces as an ApiError carrying the server's
 *     `failureCode`, so screens switch on the documented catalogue instead of
 *     matching on prose.
 */
import { getApiBase, getToken } from './store';

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
  const base = await getApiBase();
  if (!base) throw new ApiError(0, 'NO_SERVER', 'No PRISM server address is set.');
  const token = await getToken();

  let res: Response;
  try {
    res = await fetch(`${base}/app/v1${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers ?? {}),
      },
    });
  } catch {
    // A phone drops off Wi-Fi constantly; say something a person can act on.
    throw new ApiError(0, 'UNREACHABLE', `Could not reach PRISM at ${base}.`);
  }

  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (body as { failureCode?: string }).failureCode ?? 'UNKNOWN',
      (body as { message?: string }).message ?? `HTTP ${res.status}`,
      (body as { details?: Record<string, unknown> }).details
    );
  }
  return body as T;
}

// ── Shapes the server returns ────────────────────────────────────────────

export interface Me {
  userId: string;
  email: string;
  displayName: string;
  handle: string;
  balanceMinor: number;
  balanceFormatted: string;
}

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
  stepUpMode?: 'SEMANTIC' | 'AUTHENTICATOR' | null;
}

export interface StatementEntry extends TransactionView {
  direction: 'SENT' | 'RECEIVED';
  counterpartyName: string;
  counterpartyHandle: string;
}

export interface Payee {
  accountId: string;
  displayName: string;
  handle: string;
  knownPayee: boolean;
}

export interface TimelineEvent {
  at: string;
  event: string;
  data: Record<string, unknown>;
}

export type AuthorizeResult =
  | {
      decision: 'APPROVED';
      authorizedVia: 'DEVICE';
      score: number;
      reasons: string[];
      settledAt: string;
      balanceMinor: number;
      balanceFormatted: string;
    }
  | {
      decision: 'STEP_UP';
      mode: 'SEMANTIC';
      score: number;
      reasons: string[];
      challenge: { prompt: string; attemptsRemaining: number; expiresInSeconds: number };
    };

export const api = {
  /** Step 1 of sign-in: a server-chosen challenge the code is derived from. */
  challenge: (email: string) =>
    request<{ challenge: string; expiresInSeconds: number }>('/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  login: (email: string, code: string) =>
    request<{ token: string; userId: string; displayName: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }),

  me: () => request<Me>('/me'),
  payees: () => request<Payee[]>('/payees'),
  history: () => request<StatementEntry[]>('/transactions'),
  timeline: (txId: string) =>
    request<{ transaction: TransactionView; events: TimelineEvent[] }>(
      `/transactions/${txId}/timeline`
    ),

  initiate: (payeeAccountId: string, amountMinor: number) =>
    request<TransactionView>('/payment/initiate', {
      method: 'POST',
      body: JSON.stringify({ payeeAccountId, amountMinor }),
    }),
  /** Server-authoritative details. The Review screen renders ONLY this. */
  payment: (txId: string) => request<TransactionView>(`/payment/${txId}`),

  /**
   * `code` is HMAC(device_secret, intentHash) — bound to this transaction and
   * worthless against any other. `biometric` records that the phone verified
   * a person; the server labels it as claimed, because it cannot check it.
   */
  authorize: (txId: string, code: string, biometric: boolean) =>
    request<AuthorizeResult>(`/payment/${txId}/authorize`, {
      method: 'POST',
      body: JSON.stringify({ code, biometric }),
    }),
  /**
   * `answer` is the six-digit transaction code for a paired account, or the
   * two-digit quiz answer for one with no phone. One route, one attempt cap.
   */
  stepUp: (txId: string, answer: string) =>
    request<{ ok: true; next: 'REAUTHORIZE' }>(`/payment/${txId}/step-up`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    }),
  /** Re-open the 60s acceptance window. Buys time, never extra attempts. */
  stepUpWindow: (txId: string) =>
    request<{ expiresInSeconds: number }>(`/payment/${txId}/step-up/window`, { method: 'POST' }),

  requestQr: (amountMinor: number) =>
    request<{ token: string; expiresInSeconds: number }>('/qr/request', {
      method: 'POST',
      body: JSON.stringify({ amountMinor }),
    }),
  scanQr: (token: string) =>
    request<TransactionView>('/qr/scan', { method: 'POST', body: JSON.stringify({ token }) }),

  device: () =>
    request<{ paired: boolean; device: { id: string; confirmedAt: string | null } | null }>(
      '/device'
    ),
  /**
   * Is a step-up waiting on this account from a payment made on the WEB
   * PORTAL? Polled while the app is open so it can raise a local
   * notification the instant one appears, instead of the user having to
   * notice and go scan a QR by hand.
   */
  devicePending: () =>
    request<
      | { pending: false }
      | { pending: true; txId: string; token: string; expiresInSeconds: number }
    >('/device/pending'),
  policy: () =>
    request<{
      intentTtlSeconds: number;
      qrTtlSeconds: number;
      stepUpMaxAttempts: number;
      highValueMinor: number;
      riskThresholds: { stepUpThreshold: number; blockThreshold: number };
    }>('/policy'),
};
