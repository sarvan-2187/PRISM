/**
 * Audit + Alerts Module
 *
 * Append-only security event log. Every decision PRISM makes — approve,
 * step-up, block, expire, replay — writes exactly one row here.
 *
 * Two rules:
 *  1. Nothing ever UPDATEs or DELETEs this table. That is a discipline
 *     enforced by code review, not a database grant; the README says so
 *     rather than claiming a stronger guarantee than we implement.
 *  2. Audit failures never break a payment. A logging outage must not
 *     become an outage of the thing being logged.
 */
import { query } from '../../db/pool';
import { AuditLogRow } from '../../db/types';

/** Canonical event names. Kept as a union so a typo fails at compile time. */
export type AuditEvent =
  | 'USER_REGISTERED'
  | 'PASSKEY_REGISTERED'
  | 'LOGIN_SUCCEEDED'
  | 'LOGIN_FAILED'
  | 'INTENT_LOCKED'
  | 'CHALLENGE_ISSUED'
  | 'ASSERTION_VERIFIED'
  | 'CONTEXT_EVALUATED'
  | 'RISK_EVALUATED'
  | 'STEP_UP_ISSUED'
  | 'STEP_UP_PASSED'
  | 'STEP_UP_FAILED'
  | 'QR_ISSUED'
  | 'QR_REDEEMED'
  | 'PAYMENT_SETTLED'
  | 'PAYMENT_BLOCKED'
  | 'CREDENTIAL_REVOKED'
  // Proof-carrying authorization (002)
  | 'CHAIN_STEP_RECORDED'
  | 'SETTLEMENT_AUTHORIZED'
  | 'CHAIN_VERIFICATION_FAILED'
  | 'POLICY_DENIED'
  | 'DURESS_TRIGGERED'
  | 'DURESS_RELEASED'
  | 'INTENT_AMENDED';

export class AuditModule {
  async log(
    eventType: AuditEvent,
    opts: {
      transactionId?: string | null;
      userId?: string | null;
      data?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    try {
      await query(
        `INSERT INTO audit_logs (transaction_id, user_id, event_type, event_data)
         VALUES ($1, $2, $3, $4)`,
        [opts.transactionId ?? null, opts.userId ?? null, eventType, JSON.stringify(opts.data ?? {})]
      );
    } catch (err) {
      console.error('[Audit] write failed (payment flow continues):', (err as Error).message);
    }
  }

  /** Feeds the user-facing security timeline. */
  async trail(transactionId: string): Promise<AuditLogRow[]> {
    const { rows } = await query<AuditLogRow>(
      `SELECT * FROM audit_logs WHERE transaction_id = $1 ORDER BY created_at ASC, id ASC`,
      [transactionId]
    );
    return rows;
  }
}

export const audit = new AuditModule();
