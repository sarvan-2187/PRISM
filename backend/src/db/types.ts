/**
 * Shared TypeScript interfaces for all database row types.
 * These mirror the SQL schema exactly — used by all modules.
 */

export type TransactionStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'BLOCKED'
  | 'STEP_UP_REQUIRED'
  | 'EXPIRED'
  | 'SETTLED';

export type LedgerStatus = 'SUCCESS' | 'FAILED' | 'REVERTED';

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CredentialRow {
  id: string;            // WebAuthn credential ID
  user_id: string;
  public_key: Buffer;
  webauthn_id: string;
  counter: bigint;
  device_type: string;
  backed_up: boolean;
  transports: string[] | null;
  created_at: Date;
  last_used_at: Date;
}

export interface TransactionRow {
  id: string;
  user_id: string;
  recipient_id: string;
  amount: string;        // pg returns NUMERIC as string
  currency: string;
  intent_hash: string;
  nonce: string;
  expires_at: Date;
  status: TransactionStatus;
  risk_score: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface LedgerEntryRow {
  id: string;
  transaction_id: string;
  amount: string;
  status: LedgerStatus;
  settled_at: Date;
}

export interface AuditLogRow {
  id: string;
  transaction_id: string | null;
  event_type: string;
  event_data: Record<string, any>;
  created_at: Date;
}
