/**
 * Row types mirroring 001_initial_schema.sql exactly.
 *
 * BIGINT columns come back from `pg` as strings by default, so anything
 * money-shaped is typed as string here and converted at the edge with a
 * single helper. Silently treating a BIGINT as a JS number is how you end
 * up hashing "5000" and 5000 as different intents.
 */

export type TransactionStatus =
  | 'PENDING'
  | 'STEP_UP_REQUIRED'
  | 'AUTHORIZED'
  | 'SETTLED'
  | 'BLOCKED'
  | 'EXPIRED'
  | 'SUPERSEDED' // replaced by an amendment (002)
  | 'DURESS_HELD'; // settled to quarantine under duress (002)

export type LedgerDirection = 'DEBIT' | 'CREDIT';

/** Ordered authorization stages (002). */
export type AuthorizationStage =
  | 'INTENT_LOCKED'
  | 'WEBAUTHN_APPROVED'
  /** Approved with a paired-device code instead of a passkey (PRISM App). */
  | 'DEVICE_APPROVED'
  | 'CONTEXT_VERIFIED'
  | 'POLICY_EVALUATED'
  | 'RISK_APPROVED'
  | 'SEMANTIC_VERIFIED'
  | 'SETTLEMENT_AUTHORIZED';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  created_at: Date;
}

export interface AccountRow {
  id: string;
  user_id: string | null;
  display_name: string;
  handle: string;
  balance_minor: string; // BIGINT
  opening_balance_minor: string; // BIGINT (002): balance = opening + net(ledger)
  is_external: boolean;
  created_at: Date;
}

export interface CredentialRow {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: string; // BIGINT
  device_type: string;
  backed_up: boolean;
  transports: string[] | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  is_duress: boolean; // (002) signing with this credential raises duress
}

export interface TransactionRow {
  id: string;
  payer_user_id: string;
  payer_account_id: string;
  payee_account_id: string;
  amount_minor: string; // BIGINT
  currency: string;
  intent_hash: string;
  nonce: string;
  lock_version: number;
  created_at: Date;
  expires_at: Date;
  status: TransactionStatus;
  /** How the payer started this server-locked intent (migration 004). */
  origin: 'MANUAL' | 'QR';
  risk_score: number | null;
  risk_reasons: string[];
  /** Which challenge a stepped-up transaction is waiting on (migration 003). */
  step_up_mode: 'SEMANTIC' | 'AUTHENTICATOR' | null;
  failure_code: string | null;
  settled_at: Date | null;
  amended_from: string | null; // (002) this tx supersedes that one
  risk_decision: string | null; // (002) APPROVE | STEP_UP | BLOCK, durable
  fired_rule_ids: string[] | null; // (002) machine ids, not prose
  policy_version: number | null; // (002) which policy ruleset decided
}

/** authorization_steps row (002). */
export interface AuthorizationStepRow {
  id: string;
  transaction_id: string;
  attempt: number;
  seq: number;
  stage: AuthorizationStage;
  payload: Record<string, unknown>;
  prev_hash: string;
  row_hash: string;
  mac: string;
  recorded_at: Date;
}

/** settlement_capabilities row (002). */
export interface SettlementCapabilityRow {
  id: string;
  transaction_id: string;
  attempt: number;
  intent_hash: string;
  chain_tip_hash: string;
  required_stages: string[];
  mode: 'NORMAL' | 'DURESS';
  mac: string;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

/** duress_alerts row (002). */
export interface DuressAlertRow {
  id: string;
  transaction_id: string;
  user_id: string;
  raised_at: Date;
  released_at: Date | null;
  release_note: string | null;
}

export interface LedgerEntryRow {
  id: string;
  transaction_id: string;
  account_id: string;
  direction: LedgerDirection;
  amount_minor: string; // BIGINT
  settled_at: Date;
}

export interface AuditLogRow {
  id: string;
  transaction_id: string | null;
  user_id: string | null;
  event_type: string;
  event_data: Record<string, unknown>;
  created_at: Date;
}

/** BIGINT string -> number. Safe: paise amounts are far below 2^53. */
export function toMinor(value: string | number): number {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isSafeInteger(n)) throw new Error(`unsafe minor-unit value: ${value}`);
  return n;
}

/** 500000 -> "₹5,000.00" — display only, never anywhere near a hash. */
export function formatMinor(minor: string | number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(
    toMinor(minor) / 100
  );
}
