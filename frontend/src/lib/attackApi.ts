/**
 * Typed client for the Attack Simulation Dashboard's backend routes
 * (/api/v1/attacks/*). Mirrors the conventions of api-client.ts, with one
 * addition: every call carries the X-Attack-Token operator header, since
 * these routes see across accounts and PRISM has no admin session system.
 *
 * The token is never persisted to localStorage — only sessionStorage (cleared
 * when the tab closes) — and it is sent to nowhere but this backend.
 */
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'prism_attack_token';

export class AttackApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly failureCode: string,
    message: string
  ) {
    super(message);
    this.name = 'AttackApiError';
  }
}

export function getAttackToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAttackToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // ignore — worst case the operator re-enters it
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}/api/v1/attacks${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Attack-Token': getAttackToken(),
    },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AttackApiError(res.status, body.failureCode ?? 'UNKNOWN', body.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export type ScenarioCategory =
  | 'Transaction Integrity'
  | 'Replay & Ledger'
  | 'Authorization / IDOR'
  | 'Identity (WebAuthn)'
  | 'Session Forgery'
  | 'Social Engineering / Brute Force';

export interface ScenarioDefinition {
  id: string;
  name: string;
  category: ScenarioCategory;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  whatItIs: string;
  howItAffectsTheModel: string;
  attackerGoal: string;
  expectedDetectionLayer: string;
  expectedDetectionFiles: string[];
  preconditions: string[];
  expectedOutcome: string;
  mechanism: string;
  attackerDevice: string;
  targetDescription: string;
  networkHonestyNote?: string;
  usesVictimSession: boolean;
  usesAttackerSession: boolean;
  assumptions: string[];
  limitations: string[];
}

export interface TargetUser {
  userId: string;
  email: string;
  displayName: string;
  balanceFormatted: string;
}

export interface LiveTransaction {
  id: string;
  payer_user_id: string;
  payer_email: string;
  payer_name: string;
  payee_name: string;
  payee_handle: string;
  amount_minor: string;
  status: string;
  created_at: string;
  settled_at: string | null;
}

export type RunStatus = 'RUNNING' | 'COMPLETE' | 'ERROR';
export type RunOutcome =
  | 'SIMULATED'
  | 'DETECTED'
  | 'BLOCKED'
  | 'PARTIALLY_MITIGATED'
  | 'SUCCEEDED'
  | 'PROTECTION_UNAVAILABLE';

export interface AttackRun {
  id: string;
  scenario_id: string;
  attacker_label: string;
  target_user_id: string | null;
  target_transaction_id: string | null;
  status: RunStatus;
  outcome: RunOutcome | null;
  summary: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export type EventActor = 'ATTACKER' | 'LEGITIMATE' | 'PRISM' | 'SYSTEM';
export type PrismLayer =
  | 'IDENTITY'
  | 'INTENT'
  | 'CONTEXT'
  | 'RISK'
  | 'SEMANTIC'
  | 'AUTHORIZATION'
  | 'LEDGER'
  | 'NETWORK'
  | 'NONE';

export interface AttackRunEvent {
  id: string;
  run_id: string;
  seq: number;
  ts: string;
  actor: EventActor;
  prism_layer: PrismLayer | null;
  message: string;
  detail: Record<string, unknown>;
}

export interface RunDetail {
  run: AttackRun;
  events: AttackRunEvent[];
}

export interface LaunchParams {
  transactionId?: string;
  targetUserId?: string;
  attackerLabel: string;
  victimSessionCookie?: string;
  attackerSessionCookie?: string;
}

export const attackApi = {
  scenarios: () => request<ScenarioDefinition[]>('/scenarios'),
  scenario: (id: string) => request<ScenarioDefinition>(`/scenarios/${id}`),
  targets: () => request<TargetUser[]>('/targets'),
  liveTransactions: () => request<LiveTransaction[]>('/live-transactions'),
  launch: (scenarioId: string, params: LaunchParams) =>
    request<{ runId: string }>(`/scenarios/${scenarioId}/launch`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  launchLegitPayment: (targetUserId: string, deviceLabel: string, opts: { amountMinor?: number; useNeverPaidPayee?: boolean } = {}) =>
    request<{ runId: string }>('/legit-payment/launch', {
      method: 'POST',
      body: JSON.stringify({ targetUserId, deviceLabel, ...opts }),
    }),
  run: (id: string) => request<RunDetail>(`/runs/${id}`),
  runs: () => request<AttackRun[]>('/runs'),
};
