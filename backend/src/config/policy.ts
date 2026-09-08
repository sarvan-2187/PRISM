/**
 * PRISM Security Policy — the single place every tunable lives.
 *
 * Future Card rule: if you are about to type a number into a module,
 * it belongs here instead. Adapting to a new constraint should be an
 * edit to this file, not a hunt through nine modules.
 */

export const policy = {
  /** Intent lock window. Explainer §5: 60–90s. */
  intentTtlSeconds: 90,

  /** Nonce record outlives the intent so REPLAY_BLOCKED stays distinguishable
   *  from INTENT_EXPIRED. See docs: nonce state machine. */
  nonceTtlSeconds: 900,

  /** Signed QR token lifetime. */
  qrTtlSeconds: 60,

  /** WebAuthn challenge freshness. */
  challengeTtlSeconds: 120,
  regChallengeTtlSeconds: 300,

  /** Context baseline retention. */
  contextBaselineTtlSeconds: 86400,

  currency: 'INR',

  /**
   * Below this, an approval counts as reflexive rather than considered.
   * Measured server-side from the CHALLENGE_ISSUED audit row — never from a
   * value the client sends, which would let an attacker opt out of the signal.
   */
  hastyApprovalMs: 1500,

  /**
   * Amount deviation, graded rather than binary.
   *
   * A payment 4x the payer's usual is odd; one 60x their usual is a different
   * kind of event, and collapsing both into one signal meant a stranger could
   * never be blocked on amount alone no matter how large the sum. Multiples
   * are of the payer's largest settled payment, so they mean nothing until
   * there is history — which is why the seed provides some.
   */
  amountAnomalyMultiple: 3,
  amountExtremeMultiple: 50,

  /**
   * Fastest plausible ground/air travel between two authentications, km/h.
   * 900 is roughly a commercial jet: below it, two sightings are explainable;
   * above it, one of them was not the account holder.
   *
   * Only used when both requests can be located. See geoForIp() in
   * modules/context/network.ts — we deliberately ship no geolocation source,
   * so this threshold is correct and currently unreachable.
   */
  maxPlausibleKmH: 900,

  /**
   * Semantic step-up: "enter the last two digits of the amount".
   *
   * maxAttempts is counted PER TRANSACTION, not per issued challenge. That
   * distinction is the whole control: a two-digit answer is guessable in 100
   * tries, so a cap that resets whenever a fresh challenge is issued caps
   * nothing. attemptTtlSeconds therefore outlives the intent window, so the
   * counter cannot be aged out faster than the transaction it guards.
   */
  stepUp: {
    ttlSeconds: 180,
    maxAttempts: 3,
    attemptTtlSeconds: 900,
    /*
     * How long a PRISM Authenticator code is accepted for.
     *
     * Deliberately shorter than the 180s semantic window. The six digits are
     * read aloud off a phone screen, which is exactly the moment a coached
     * victim is most exposed, so the window in which a relayed code is worth
     * anything stays small. Enforced server-side against an issued-at record,
     * NOT by a clock on the phone: the code itself is derived from the intent
     * hash alone, so a drifted phone clock can never break the demo.
     */
    authenticatorTtlSeconds: 60,
  },

  /*
   * At or above this, a payment cannot be approved by the laptop alone: the
   * paired phone must produce a code. Above it the loss from one coerced
   * approval stops being recoverable, so the evidence bar rises with the
   * amount rather than staying flat.
   */
  highValueMinor: 5_000_000,

  /**
   * Adaptive risk engine. Score is additive points from the rules in
   * modules/risk/riskEngine.ts.
   *
   * blockThreshold is 85, not 75, and the reason is load-bearing: a genuine
   * user on a genuine device being talked into paying a stranger scores 75
   * (NEW_PAYEE + AMOUNT_ANOMALY + HASTY_APPROVAL). At a threshold of 75 that
   * blocks outright — which sounds safe but is wrong twice over. It skips
   * semantic verification, the only control that addresses manipulation of a
   * genuine user, and it refuses a payment that may well be legitimate
   * without ever asking the person.
   *
   * 85 leaves a real step-up band: manipulation gets a comprehension check,
   * while a stolen device (which also trips NEW_DEVICE) still blocks.
   * riskEngine.test.ts asserts all four outcomes — run it after any change.
   */
  risk: {
    stepUpThreshold: 40,
    blockThreshold: 85,
  },

  rateLimit: {
    // Generous default so the demo never trips on itself.
    defaultWindowMs: 15 * 60 * 1000,
    defaultMax: 300,
    // Strict where an attacker would brute-force: two-digit answers, auth.
    // Raised from 20 for the multi-laptop demo: several people registering
    // and retrying on one network exhausted 20/5min in normal use. A
    // two-digit code needs up to 100 guesses, so 60 still trips before it
    // can be exhausted, and the semantic check's own 3-attempt-per-payment
    // cap is the primary defence regardless. Restore 20 after the demo.
    strictWindowMs: 5 * 60 * 1000,
    strictMax: 60,
  },

  /**
   * Demo-only kill switches for the attack-then-defend "before" state.
   * Set PRISM_DISABLE=intentLock,replayGuard to show the vulnerable behaviour.
   * Refused entirely when NODE_ENV=production — see disabledControls().
   */
  disableableControls: ['intentLock', 'replayGuard', 'expiryGuard', 'qrSignature', 'riskEngine'] as const,

  /**
   * BLACKOUT (FC-01-A): pre-positioned offline authorization.
   *
   * Before a blackout, the device is handed a signed, capped grant — a small
   * number of pre-reserved single-use slots, a per-payment amount ceiling,
   * and a fixed payee whitelist. The device cannot widen any of these:
   * doing so breaks a MAC it has no key for. Blast radius of a fully
   * compromised offline device is therefore bounded and statable up front:
   * slots * maxAmountMinor, to already-known payees only, inside one window.
   */
  offline: {
    /** Per-payment cap while offline — well under AMOUNT_ANOMALY, so a stolen device cannot make it look ordinary either. */
    maxAmountMinor: 500000, // ₹5,000
    /** How long after arming the device may still approve a payment offline. Bounds a stolen armed device. */
    windowSeconds: 900, // 15 minutes
    /**
     * Extra time, after the grant window closes, in which a voucher already
     * produced may still be submitted.
     *
     * This is the knob that replaces intentTtlSeconds for an offline
     * approval, and it has to exist: the intent window is 90 seconds, which
     * no real blackout respects. A voucher redeemed here is deliberately
     * allowed to reference an intent whose own window closed — the grant
     * window is what bounds it instead, and the lag is recorded on the
     * authorization chain rather than hidden.
     */
    redeemGraceSeconds: 900, // 15 minutes
  },
} as const;

export type DisableableControl = (typeof policy.disableableControls)[number];

/**
 * Which controls are switched off for a demo.
 * Always empty in production — a shipped build cannot be weakened by an env var.
 */
export function disabledControls(): Set<string> {
  if (process.env.NODE_ENV === 'production') return new Set();
  const raw = process.env.PRISM_DISABLE ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

export function isDisabled(control: DisableableControl): boolean {
  return disabledControls().has(control);
}
