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
  | 'EXPIRED';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

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
  risk_score: number | null;
  risk_reasons: string[];
  failure_code: string | null;
  settled_at: Date | null;
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
