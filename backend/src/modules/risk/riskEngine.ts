/**
 * Adaptive Risk Engine — the one decision point.
 *
 * Rules-first, never a model. Every decision must be able to state exactly
 * which conditions fired, because in a financial system an unexplainable
 * block is nearly as damaging as a missed fraud: it cannot be audited,
 * contested, or debugged.
 *
 * FUTURE CARD: adding a rule is one entry in RULES below. No engine change,
 * no schema change, no UI change — the reason string flows through to the
 * timeline on its own.
 */
import { ContextSignals } from '../context/fingerprint';
import { policy, isDisabled } from '../../config/policy';
import { audit } from '../audit/logger';
import { query } from '../../db/pool';

export type RiskDecision = 'APPROVE' | 'STEP_UP' | 'BLOCK';

export interface RiskSignals extends ContextSignals {
  amountMinor: number;
}

export interface RiskRule {
  id: string;
  points: number;
  when: (s: RiskSignals) => boolean;
  /** Shown to the user and written to the audit log. Plain English. */
  reason: string;
}

/** Each rule is independent, pure, and readable aloud to a judge. */
export const RULES: RiskRule[] = [
  {
    id: 'NEW_DEVICE',
    points: 35,
    when: (s) => s.newDevice,
    reason: 'This device has not been used for payments before',
  },
  {
    id: 'NO_BASELINE',
    points: 25,
    when: (s) => s.noBaseline,
    reason: 'No established pattern for this session yet',
  },
  {
    id: 'NEW_PAYEE',
    points: 30,
    when: (s) => s.newPayee,
    reason: 'You have never paid this recipient before',
  },
  {
    id: 'AMOUNT_ANOMALY',
    points: 30,
    when: (s) => s.amountAnomaly,
    reason: 'Amount is far larger than your usual payments',
  },
  {
    id: 'HASTY_APPROVAL',
    points: 15,
    when: (s) => s.hastyApproval,
    reason: 'Payment approved unusually quickly after the details appeared',
  },
  {
    id: 'NETWORK_CHANGED',
    points: 10,
    when: (s) => s.networkChanged,
    reason: 'Connecting from a different network than usual',
  },
];

export interface RiskResult {
  score: number;
  decision: RiskDecision;
  reasons: string[];
  firedRuleIds: string[];
}

export class RiskEngineModule {
  async evaluate(txId: string, userId: string, signals: RiskSignals): Promise<RiskResult> {
    const fired = isDisabled('riskEngine') ? [] : RULES.filter((r) => r.when(signals));
    const score = Math.min(
      100,
      fired.reduce((sum, r) => sum + r.points, 0)
    );

    const decision: RiskDecision =
      score >= policy.risk.blockThreshold
        ? 'BLOCK'
        : score >= policy.risk.stepUpThreshold
          ? 'STEP_UP'
          : 'APPROVE';

    const reasons = fired.map((r) => r.reason);

    await query('UPDATE transactions SET risk_score = $2, risk_reasons = $3 WHERE id = $1', [
      txId,
      score,
      JSON.stringify(reasons),
    ]);

    await audit.log('RISK_EVALUATED', {
      transactionId: txId,
      userId,
      data: { score, decision, firedRuleIds: fired.map((r) => r.id) },
    });

    return { score, decision, reasons, firedRuleIds: fired.map((r) => r.id) };
  }
}

export const riskEngine = new RiskEngineModule();
