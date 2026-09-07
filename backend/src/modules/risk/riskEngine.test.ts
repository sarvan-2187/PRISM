/**
 * Risk engine decision ladder.   Run: npm run test:risk        OWNER: S2
 *
 * The demo needs four different outcomes from one rule set. This asserts all
 * four, so a threshold change that quietly breaks the semantic-verification
 * demo fails here instead of on stage.
 *
 * Baseline is the 90th percentile of Asha's seeded history (~₹1,800).
 * Anomaly fires above 3x that; extreme above 50x.
 */
import assert from 'node:assert/strict';
import redis from '../../utils/redis';
import pool from '../../db/pool';
import { scoreSignals, RiskSignals, RULES } from './riskEngine';
import { policy } from '../../config/policy';

const SEEDED_USUAL_MINOR = 180_000; // p90 of the seeded history, ~₹1,800

/** Asha's normal: known device, known payee, ordinary amount, unhurried. */
const normal: RiskSignals = {
  amountMinor: 500_000, // ₹5,000 — the worked example from the explainer
  newDevice: false,
  noBaseline: false,
  newPayee: false,
  amountAnomaly: false,
  amountExtreme: false,
  hastyApproval: false,
  networkChanged: false,
  impossibleTravel: false,
  deliberationMs: 8_000, // unhurried: read the screen, then approved
  payerHistoryCount: 20,
  usualAmountMinor: SEEDED_USUAL_MINOR,
};

const scenario = (name: string, over: Partial<RiskSignals>) => {
  const result = scoreSignals({ ...normal, ...over });
  console.log(
    `  ${result.decision.padEnd(8)} ${String(result.score).padStart(3)}  ${name}` +
      (result.firedRuleIds.length ? `\n           ${result.firedRuleIds.join(', ')}` : '')
  );
  return result;
};

console.log('\nRisk decision ladder');
console.log(
  `  thresholds: STEP_UP >= ${policy.risk.stepUpThreshold}, BLOCK >= ${policy.risk.blockThreshold}\n`
);

// ── 1. The happy path must stay invisible ─────────────────────────────
// If a routine payment ever demands step-up, users approve reflexively and
// the control stops meaning anything.
assert.equal(
  scenario('₹5,000 to Priya, usual device — the happy path', {}).decision,
  'APPROVE'
);

// A first payment in a fresh session has no stored baseline yet. That alone
// must not add friction, or every demo run starts with a challenge.
assert.equal(
  scenario('first payment of the session, no baseline yet', { noBaseline: true }).decision,
  'APPROVE'
);

// ── 2. Scam call: genuine user, genuine device, manipulated ───────────
// This MUST be STEP_UP, not BLOCK. Semantic verification is novelty N2 and
// the only defence against this fraud class — blocking here means the demo
// never shows it. This is the scenario that pins blockThreshold.
assert.equal(
  scenario('scam call: own device, stranger, ₹48,000, approved in a hurry', {
    newPayee: true,
    amountAnomaly: true,
    hastyApproval: true,
    amountMinor: 4_800_000,
  }).decision,
  'STEP_UP'
);

// ── 3. Second browser profile: unrecognised device ────────────────────
// Drives the step-up demo on one laptop. Moderate amount so it lands on
// STEP_UP and the semantic screen is reachable.
assert.equal(
  scenario('second browser profile, new payee, ordinary amount', {
    newDevice: true,
    newPayee: true,
  }).decision,
  'STEP_UP'
);

// ── 4. Stolen device: everything wrong at once ────────────────────────
assert.equal(
  scenario('stolen device: new device + stranger + ₹48,000', {
    newDevice: true,
    newPayee: true,
    amountAnomaly: true,
    networkChanged: true,
    amountMinor: 4_800_000,
  }).decision,
  'BLOCK'
);

// ── 5. The demo ladder, driven by payee + amount on ONE device ────────
// These three are what the jury sees, chosen from the payee list without
// switching browser profiles.
assert.equal(
  scenario('menu: known payee, ordinary amount', {}).decision,
  'APPROVE'
);
assert.equal(
  scenario('menu: stranger, moderately large (3x-50x)', {
    newPayee: true,
    amountAnomaly: true,
  }).decision,
  'STEP_UP'
);
assert.equal(
  scenario('menu: stranger, vastly larger than ever before (>50x)', {
    newPayee: true,
    amountExtreme: true,
  }).decision,
  'BLOCK'
);

// A large payment to someone already trusted is checked, not refused.
assert.equal(
  scenario('known payee, vastly larger than usual', { amountExtreme: true }).decision,
  'STEP_UP'
);

// ── Invariants that outlive any retuning ──────────────────────────────

// Every rule must be reachable: a rule that can never fire is dead weight
// pretending to be a control.
for (const rule of RULES) {
  const only = scoreSignals({
    ...normal,
    newDevice: false,
    noBaseline: false,
    newPayee: false,
    amountAnomaly: false,
    amountExtreme: false,
    hastyApproval: false,
    networkChanged: false,
    impossibleTravel: false,
    ...({ [ruleSignal(rule.id)]: true } as Partial<RiskSignals>),
  });
  assert.ok(only.firedRuleIds.includes(rule.id), `rule ${rule.id} never fires`);
}

/** Maps a rule id to the signal that triggers it. Keep in step with RULES. */
function ruleSignal(id: string): keyof RiskSignals {
  const map: Record<string, keyof RiskSignals> = {
    NEW_DEVICE: 'newDevice',
    NO_BASELINE: 'noBaseline',
    NEW_PAYEE: 'newPayee',
    AMOUNT_ANOMALY: 'amountAnomaly',
    AMOUNT_EXTREME: 'amountExtreme',
    HASTY_APPROVAL: 'hastyApproval',
    NETWORK_CHANGED: 'networkChanged',
    IMPOSSIBLE_TRAVEL: 'impossibleTravel',
  };
  const signal = map[id];
  assert.ok(signal, `rule ${id} has no signal mapping — add it to ruleSignal()`);
  return signal;
}

// Every decision must be explainable. A block with no stated reason is
// exactly the black-box behaviour the design rejects (novelty N6).
const blocked = scoreSignals({
  ...normal,
  newDevice: true,
  newPayee: true,
  amountAnomaly: true,
});
assert.ok(blocked.reasons.length > 0, 'a non-zero score must carry reasons');
assert.equal(blocked.reasons.length, blocked.firedRuleIds.length);

// Thresholds must leave a usable STEP_UP band. If they ever meet, the
// semantic-verification path becomes unreachable.
assert.ok(
  policy.risk.blockThreshold > policy.risk.stepUpThreshold,
  'BLOCK threshold must sit above STEP_UP or nothing can step up'
);

console.log('\nriskEngine.test.ts: all assertions passed\n');

// scoreSignals is pure, but importing the engine pulls in Redis and Postgres
// through the module graph. Close them or the process never exits.
void pool.end();
redis.disconnect();
