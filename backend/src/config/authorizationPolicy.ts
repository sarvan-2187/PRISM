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

import { policy } from './policy';
import type { ContextSignals } from '../modules/context/fingerprint';
import type { TransactionRow } from '../db/types';

/** Bump when the rule set changes so a historical decision stays reconstructible. */
export const POLICY_VERSION = 1;

export type PolicyOutcome = 'ALLOW' | 'REQUIRE_SEMANTIC' | 'DENY' | 'DURESS_HOLD';

/** Single source for the high-value bar. See policy.highValueMinor. */
const HIGH_VALUE_MINOR = policy.highValueMinor;

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
  /** The payer has an ACTIVE PRISM Authenticator device paired. */
  hasAuthenticator: boolean;
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
    // An elevated score on a transaction that was NOT amended is a hard
    // refusal with a cited reason. 60 sits above "new payee" (NEW_PAYEE 30 +
    // NO_BASELINE 25 = 55, a normal first payment) and at-or-below "new
    // device" (NEW_DEVICE 35 + NO_BASELINE 25 = 60), which is the
    // second-browser / stolen-session case the demo shows being stopped.
    //
    // Applies only when the payer has NO second device. With one paired, the
    // rule below escalates instead of refusing.
    when: (c) => !c.isAmendment && !c.hasAuthenticator && (c.tx.risk_score ?? 0) >= 60,
  },
  {
    id: 'ELEVATED_RISK_SECOND_DEVICE',
    outcome: 'REQUIRE_SEMANTIC',
    reason: 'This payment needs approval from your paired phone.',
    /*
     * The same score, a different answer, because the account has somewhere
     * better to ask.
     *
     * A flat refusal dead-ends a genuine user and, worse, skips the only
     * control that addresses a payer who is real but being manipulated. With
     * a paired device the six digits are an HMAC over THIS transaction's
     * intent hash, produced on hardware the attacker does not hold, and read
     * against a payee and amount the attacker cannot redraw. A stolen laptop
     * scoring 90 still fails — one step later, because the thief does not
     * have the phone.
     *
     * Mutually exclusive with ELEVATED_RISK above: exactly one of the two can
     * match, so the stronger DENY never masks this escalation.
     */
    when: (c) => !c.isAmendment && c.hasAuthenticator && (c.tx.risk_score ?? 0) >= 60,
  },
  {
    id: 'NEW_PAYEE_LARGE_AMOUNT',
    outcome: 'DENY',
    reason: 'A first payment to a new recipient above ₹10,000 needs a paired phone.',
    // Only refuses outright when there is no second device to ask. With one
    // paired, HIGH_VALUE_AUTHENTICATOR escalates instead.
    when: (c) =>
      c.signals.newPayee && !c.hasAuthenticator && rupees(parseInt(c.tx.amount_minor, 10)) > 10_000,
  },
  {
    id: 'DAILY_LIMIT',
    outcome: 'DENY',
    reason: "This payment would take today's transfers over the ₹50,000 limit.",
    when: (c) =>
      !c.hasAuthenticator && rupees(c.settledTodayMinor + parseInt(c.tx.amount_minor, 10)) > 50_000,
  },
  {
    id: 'HIGH_VALUE_AUTHENTICATOR',
    outcome: 'REQUIRE_SEMANTIC',
    reason: 'Payments of ₹50,000 or more must be approved on your paired phone.',
    /*
     * The evidence required rises with what is at stake.
     *
     * Below the threshold a laptop passkey is the whole authorization. At or
     * above it the money is large enough that one coerced approval is not
     * recoverable, so PRISM demands a factor the laptop cannot produce: a code
     * derived on separate hardware from this transaction's own intent hash,
     * read against a payee and amount the attacker cannot redraw.
     */
    when: (c) => c.hasAuthenticator && parseInt(c.tx.amount_minor, 10) >= HIGH_VALUE_MINOR,
  },
  {
    id: 'HIGH_VALUE_NO_DEVICE',
    outcome: 'DENY',
    reason:
      'Payments of ₹50,000 or more need a paired phone. Pair one in Settings, then try again.',
    // The refusal names the remedy. A dead end with no way forward is the
    // failure mode the Authenticator exists to remove.
    when: (c) => !c.hasAuthenticator && parseInt(c.tx.amount_minor, 10) >= HIGH_VALUE_MINOR,
  },
  {
    id: 'NIGHT_NEW_PAYEE',
    // Was DENY. A flat refusal gave a genuine user at 1 AM no way through at
    // all, and it fired before the risk engine's step-up branch, so the
    // comprehension check could never run between 11 PM and 6 AM. Requiring
    // the check instead keeps the rule's intent — scam calls cluster at odd
    // hours, so a first payment to a stranger then deserves extra friction —
    // while leaving the user a path that a coached victim still cannot take
    // without reading the real amount aloud.
    outcome: 'REQUIRE_SEMANTIC',
    reason:
      'A first payment to a new recipient between 11 PM and 6 AM needs the amount confirmed.',
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
