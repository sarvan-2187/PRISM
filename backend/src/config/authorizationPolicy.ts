/**
 * Payment Policy Firewall — declarative authorization rules.
 *
 * The risk engine produces a score; this produces a *decision with a citation*.
 * "Blocked: NEW_PAYEE_LARGE_AMOUNT and DAILY_LIMIT" is an answer a judge (or a
 * user) can act on; "risk score 82" is not.
 *
 * Kept in its own file rather than config/policy.ts (S2's) to avoid a merge
 * collision. Every rule is a pure function of a PolicyContext, so a Future Card
 * that adds a constraint is one array entry.
 *
 * Precedence when several rules fire:  DURESS_HOLD > DENY > REQUIRE_SEMANTIC > ALLOW
 * The strongest outcome wins, and every firing rule is recorded on the chain.
 */
import type { ContextSignals } from '../modules/context/fingerprint';
import type { TransactionRow } from '../db/types';

/** Bump when the rule set changes so a historical decision stays reconstructible. */
export const POLICY_VERSION = 1;

export type PolicyOutcome = 'ALLOW' | 'REQUIRE_SEMANTIC' | 'DENY' | 'DURESS_HOLD';

export interface PolicyContext {
  tx: TransactionRow;
  signals: ContextSignals;
  /** The assertion that authorized this attempt was signed with a duress passkey. */
  isDuressCredential: boolean;
  /** This transaction supersedes an earlier one (an amendment). */
  isAmendment: boolean;
  /** Total minor units this payer has settled today (for the daily cap). */
  settledTodayMinor: number;
  /** Server clock hour, 0-23, for the night-window rule. */
  hour: number;
}

export interface PolicyRule {
  id: string;
  outcome: Exclude<PolicyOutcome, 'ALLOW'>;
  /** Human sentence for the UI and the receipt. */
  reason: string;
  when: (c: PolicyContext) => boolean;
}

const rupees = (paise: number): number => paise / 100;

/**
 * Order is documentation only — the evaluator collects every firing rule and
 * resolves by outcome strength, not array position.
 */
export const POLICY_RULES: PolicyRule[] = [
  {
    id: 'DURESS_CREDENTIAL',
    outcome: 'DURESS_HOLD',
    reason: 'Approved with a duress credential — routed to quarantine.',
    when: (c) => c.isDuressCredential,
  },
  {
    id: 'AMENDED_INTENT',
    outcome: 'REQUIRE_SEMANTIC',
    reason: 'The transaction was changed after it was first locked.',
    when: (c) => c.isAmendment,
  },
  {
    id: 'ELEVATED_RISK',
    outcome: 'DENY',
    reason: 'The device and account signals for this payment are too strong to allow.',
    // The digits fallback for high-risk-but-unchanged transactions was removed
    // (it was bypassable and looped forever). Instead: an elevated score on a
    // transaction that was NOT amended is a hard refusal with a cited reason.
    // 60 sits above "new payee" (NEW_PAYEE 30 + NO_BASELINE 25 = 55, a normal
    // first payment) and at-or-below "new device" (NEW_DEVICE 35 + NO_BASELINE
    // 25 = 60), which is the second-browser / stolen-session case the demo
    // shows being stopped.
    when: (c) => !c.isAmendment && (c.tx.risk_score ?? 0) >= 60,
  },
  {
    id: 'NEW_PAYEE_LARGE_AMOUNT',
    outcome: 'DENY',
    reason: 'A first payment to a new recipient above ₹10,000 is not allowed.',
    when: (c) => c.signals.newPayee && rupees(parseInt(c.tx.amount_minor, 10)) > 10_000,
  },
  {
    id: 'DAILY_LIMIT',
    outcome: 'DENY',
    reason: "This payment would take today's transfers over the ₹50,000 limit.",
    when: (c) => rupees(c.settledTodayMinor + parseInt(c.tx.amount_minor, 10)) > 50_000,
  },
  {
    id: 'NIGHT_NEW_PAYEE',
    outcome: 'DENY',
    reason: 'New recipients cannot be paid between 11 PM and 6 AM.',
    when: (c) => c.signals.newPayee && (c.hour >= 23 || c.hour < 6),
  },
];

const STRENGTH: Record<PolicyOutcome, number> = {
  ALLOW: 0,
  REQUIRE_SEMANTIC: 1,
  DENY: 2,
  DURESS_HOLD: 3,
};

export interface PolicyDecision {
  outcome: PolicyOutcome;
  firedRules: { id: string; outcome: PolicyOutcome; reason: string }[];
  policyVersion: number;
}

/** Evaluate every rule; the strongest outcome wins. Pure. */
export function evaluatePolicy(ctx: PolicyContext): PolicyDecision {
  const fired = POLICY_RULES.filter((r) => r.when(ctx)).map((r) => ({
    id: r.id,
    outcome: r.outcome as PolicyOutcome,
    reason: r.reason,
  }));
  const outcome = fired.reduce<PolicyOutcome>(
    (acc, r) => (STRENGTH[r.outcome] > STRENGTH[acc] ? r.outcome : acc),
    'ALLOW'
  );
  return { outcome, firedRules: fired, policyVersion: POLICY_VERSION };
}
