/**
 * Audit + Alerts Module
 * Structured, immutable event logging for every PRISM decision.
 * Every approve/block/step-up/error writes a row to audit_logs.
 */
import { query } from '../../db/pool';
import { AuditLogRow } from '../../db/types';

export class AuditModule {

  /**
   * Write a structured audit event to PostgreSQL.
   * This is fire-and-forget from the caller's perspective — errors are swallowed
   * to prevent audit failures from blocking payment flows.
   */
  async log(
    eventType: string,
    transactionId: string | null,
    eventData: Record<string, any>
  ): Promise<void> {
    try {
      // TODO: INSERT INTO audit_logs (event_type, transaction_id, event_data)
      //       VALUES ($1, $2, $3)
      //       using query(sql, [eventType, transactionId, JSON.stringify(eventData)])
    } catch (err) {
      // Audit failures must never crash the main flow
      console.error('[Audit] Failed to write audit log:', err);
    }
  }

  /**
   * Retrieve audit trail for a specific transaction.
   */
  async getAuditTrail(transactionId: string): Promise<AuditLogRow[]> {
    // TODO: SELECT * FROM audit_logs WHERE transaction_id = $1 ORDER BY created_at ASC
    throw new Error('Not implemented');
  }
}
