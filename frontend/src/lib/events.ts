/**
 * Plain English for the audit trail, shared by the full timeline and the live
 * log so the two can never disagree about what an event means.
 *
 * The event names are the server's own (modules/audit/logger.ts). Unknown
 * ones fall through to the raw name rather than being dropped: a Future Card
 * may introduce an event at midnight and the trail still has to read.
 */

export type Tone = 'ok' | 'warn' | 'danger' | 'plain';

export const EVENTS: Record<string, { label: string; tone: Tone }> = {
  USER_REGISTERED: { label: 'Account created', tone: 'plain' },
  PASSKEY_REGISTERED: { label: 'Passkey registered on this device', tone: 'ok' },
  LOGIN_SUCCEEDED: { label: 'Signed in with a passkey', tone: 'ok' },
  LOGIN_FAILED: { label: 'Sign-in refused', tone: 'danger' },
  INTENT_LOCKED: { label: 'Transaction frozen and hashed', tone: 'plain' },
  CHALLENGE_ISSUED: { label: 'Challenge issued, and it is the intent hash', tone: 'plain' },
  ASSERTION_VERIFIED: { label: 'Passkey signature verified against that hash', tone: 'ok' },
  CONTEXT_EVALUATED: { label: 'Device, network and history examined', tone: 'plain' },
  RISK_EVALUATED: { label: 'Risk scored', tone: 'plain' },
  STEP_UP_ISSUED: { label: 'Comprehension check issued', tone: 'warn' },
  STEP_UP_PASSED: { label: 'Comprehension check passed', tone: 'ok' },
  STEP_UP_FAILED: { label: 'Comprehension check failed', tone: 'danger' },
  QR_ISSUED: { label: 'Signed payment request created', tone: 'plain' },
  QR_REDEEMED: { label: 'Payment request scanned', tone: 'plain' },
  PAYMENT_SETTLED: { label: 'Money moved, exactly once', tone: 'ok' },
  PAYMENT_BLOCKED: { label: 'Payment refused', tone: 'danger' },
  CREDENTIAL_REVOKED: { label: 'Passkey revoked', tone: 'warn' },
  // Offline authorization (BLACKOUT / FC-01-A)
  OFFLINE_GRANT_ISSUED: { label: 'Device armed for offline approval', tone: 'plain' },
  OFFLINE_VOUCHER_REDEEMED: { label: 'Offline voucher redeemed and settled', tone: 'ok' },
  OFFLINE_VOUCHER_REJECTED: { label: 'Offline voucher rejected', tone: 'danger' },
};

export function describeEvent(event: string): { label: string; tone: Tone } {
  return EVENTS[event] ?? { label: event, tone: 'plain' };
}

/**
 * The fields worth surfacing from an event's payload. Everything else stays
 * folded away: this is progressive disclosure, not a JSON dump.
 */
export function summarise(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (key: string, label: string) => {
    if (data[key] !== undefined && data[key] !== null) out.push(`${label}: ${String(data[key])}`);
  };

  push('failureCode', 'code');
  push('score', 'score');
  push('decision', 'decision');
  push('attemptsUsed', 'attempts used');

  if (Array.isArray(data.firedRuleIds) && data.firedRuleIds.length) {
    out.push(`rules: ${(data.firedRuleIds as string[]).join(', ')}`);
  }
  if (Array.isArray(data.reasons) && data.reasons.length) {
    out.push(...(data.reasons as string[]));
  }
  if (data.challengeIsIntentHash) out.push('challenge = intent hash');

  // Context flags only appear when true, so an absent flag reads as absent
  // rather than as a wall of "false".
  const flags: Array<[string, string]> = [
    ['newDevice', 'device not seen before'],
    ['newPayee', 'recipient never paid before'],
    ['amountAnomaly', 'amount above the usual range'],
    ['amountExtreme', 'amount far above anything sent before'],
    ['hastyApproval', 'approved unusually fast'],
    ['networkChanged', 'different network than usual'],
    ['noBaseline', 'no established pattern yet'],
  ];
  for (const [key, text] of flags) if (data[key] === true) out.push(text);

  // Device + network detail, present only on CONTEXT_EVALUATED. These are the
  // coarse, hashed values PRISM stored — shown so the "examined" step is
  // legible, not just a claim. `deviceFingerprint` is the marker for the set.
  if (typeof data.deviceFingerprint === 'string') {
    out.push(`device fingerprint: ${data.deviceFingerprint}`);
    if (typeof data.acceptLanguage === 'string' && data.acceptLanguage) {
      out.push(`language: ${data.acceptLanguage}`);
    }
    if (typeof data.networkSubnet === 'string') {
      const note =
        data.networkPrivate === true ? ' (private — carries no network evidence)' : '';
      out.push(`network: ${data.networkSubnet}${note}`);
    }
    if (typeof data.networkId === 'string') {
      out.push(`network id: ${data.networkId}`);
    }
    if (typeof data.payerHistoryCount === 'number') {
      const n = data.payerHistoryCount;
      const usual =
        typeof data.usualAmountMinor === 'number' && data.usualAmountMinor > 0
          ? `, usual ~₹${Math.round(data.usualAmountMinor / 100).toLocaleString('en-IN')}`
          : '';
      out.push(`payer history: ${n} settled payment${n === 1 ? '' : 's'}${usual}`);
    }
  }

  if (typeof data.deliberationMs === 'number') {
    out.push(`considered for ${Math.round(data.deliberationMs / 100) / 10}s`);
  }
  if (data.offline === true) out.push('signed with no network connection');
  return out;
}

/** Statuses after which nothing more will happen, so polling can stop. */
const TERMINAL = new Set(['SETTLED', 'BLOCKED', 'EXPIRED']);

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

/** Badge tone for a transaction status. Always rendered next to its word. */
export function statusTone(status: string): Tone {
  if (status === 'SETTLED') return 'ok';
  if (status === 'BLOCKED' || status === 'EXPIRED') return 'danger';
  if (status === 'STEP_UP_REQUIRED') return 'warn';
  return 'plain';
}

/** The same mapping, in the Badge component's variant vocabulary. */
export type BadgeVariant = 'success' | 'warning' | 'destructive' | 'info' | 'default';

const TONE_TO_VARIANT: Record<Tone, BadgeVariant> = {
  ok: 'success',
  warn: 'warning',
  danger: 'destructive',
  plain: 'default',
};

export function statusBadge(status: string): BadgeVariant {
  return TONE_TO_VARIANT[statusTone(status)];
}

/** Text colour for an event label in the timeline and the live log. */
export function toneClass(tone: Tone): string {
  if (tone === 'ok') return 'text-success';
  if (tone === 'warn') return 'text-warning';
  if (tone === 'danger') return 'text-destructive';
  return 'text-foreground';
}

/** Dot colour for the timeline rail. Non-text, so the saturated mark is right. */
export function toneDot(tone: Tone): string {
  if (tone === 'ok') return 'bg-success-mark';
  if (tone === 'warn') return 'bg-warning-mark';
  if (tone === 'danger') return 'bg-destructive-mark';
  return 'bg-muted-foreground';
}

/** Human labels for the status enum, so the UI never shows SCREAMING_CASE. */
export const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Awaiting approval',
  STEP_UP_REQUIRED: 'Requires review',
  AUTHORIZED: 'Authorized',
  SETTLED: 'Settled',
  BLOCKED: 'Blocked',
  EXPIRED: 'Expired',
};
