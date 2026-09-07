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

  /** Semantic step-up: "enter the last two digits of the amount". */
  stepUp: {
    ttlSeconds: 180,
    maxAttempts: 3,
  },

  /** Adaptive risk engine. Score is additive points from the rules below. */
  risk: {
    stepUpThreshold: 40,
    blockThreshold: 75,
  },

  rateLimit: {
    // Generous default so the demo never trips on itself.
    defaultWindowMs: 15 * 60 * 1000,
    defaultMax: 300,
    // Strict where an attacker would brute-force: two-digit answers, auth.
    strictWindowMs: 5 * 60 * 1000,
    strictMax: 20,
  },

  /**
   * Demo-only kill switches for the attack-then-defend "before" state.
   * Set PRISM_DISABLE=intentLock,replayGuard to show the vulnerable behaviour.
   * Refused entirely when NODE_ENV=production — see disabledControls().
   */
  disableableControls: ['intentLock', 'replayGuard', 'expiryGuard', 'qrSignature', 'riskEngine'] as const,
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
