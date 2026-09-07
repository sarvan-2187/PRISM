/**
 * Policy Firewall module — turns the declarative rules in
 * config/authorizationPolicy.ts into a decision, resolving the runtime inputs
 * (today's settled total, the server hour) that the pure rules need.
 *
 * Sits in the authorize pipeline as the POLICY_EVALUATED chain stage, between
 * CONTEXT_VERIFIED and RISK_APPROVED. Its decision is recorded on the chain and
 * its firing rules flow to the UI and the receipt verbatim.
 */
import { query } from '../../db/pool';
import type { ContextSignals } from '../context/fingerprint';
import type { TransactionRow } from '../../db/types';
import {
  evaluatePolicy,
  PolicyDecision,
  POLICY_RULES,
  POLICY_VERSION,
} from '../../config/authorizationPolicy';

export interface FirewallInput {
  tx: TransactionRow;
  signals: ContextSignals;
  isDuressCredential: boolean;
}

export class PolicyFirewallModule {
  /** Rule metadata, for a public /policy-style listing. */
  rules(): { id: string; outcome: string; reason: string }[] {
    return POLICY_RULES.map((r) => ({ id: r.id, outcome: r.outcome, reason: r.reason }));
  }

  version(): number {
    return POLICY_VERSION;
  }

  async evaluate(input: FirewallInput): Promise<PolicyDecision> {
    const { tx } = input;

    // Total the payer has already settled today (server day). Used by the
    // daily-limit rule. DURESS_HELD is deliberately excluded — quarantined
    // money has not reached anyone.
    const { rows } = await query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::text AS total
         FROM transactions
        WHERE payer_user_id = $1
          AND status = 'SETTLED'
          AND settled_at >= date_trunc('day', NOW())`,
      [tx.payer_user_id]
    );

    return evaluatePolicy({
      tx,
      signals: input.signals,
      isDuressCredential: input.isDuressCredential,
      isAmendment: tx.amended_from !== null,
      settledTodayMinor: parseInt(rows[0].total, 10),
      hour: new Date().getHours(),
    });
  }
}

export const policyFirewall = new PolicyFirewallModule();
