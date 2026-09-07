/**
 * Plain English for the audit trail, ported from the web client so both
 * surfaces describe the same event the same way.
 *
 * One entry matters more than the rest: DEVICE_APPROVED must never read as a
 * passkey signature. The mobile path trades key custody for reach, and the
 * timeline is where that is admitted.
 */
export type Tone = 'ok' | 'warn' | 'danger' | 'plain';

export const EVENTS: Record<string, { label: string; tone: Tone }> = {
  INTENT_LOCKED: { label: 'Transaction frozen and hashed', tone: 'plain' },
  CHALLENGE_ISSUED: { label: 'Challenge issued, and it is the intent hash', tone: 'plain' },
  ASSERTION_VERIFIED: { label: 'Passkey signature verified against that hash', tone: 'ok' },
  DEVICE_APPROVED: { label: 'Approved on a paired device, not a passkey', tone: 'warn' },
  CONTEXT_EVALUATED: { label: 'Device, network and history examined', tone: 'plain' },
  RISK_EVALUATED: { label: 'Risk scored', tone: 'plain' },
  POLICY_DENIED: { label: 'A policy rule refused it', tone: 'danger' },
  STEP_UP_ISSUED: { label: 'Comprehension check issued', tone: 'warn' },
  STEP_UP_PASSED: { label: 'Comprehension check passed', tone: 'ok' },
  STEP_UP_FAILED: { label: 'Comprehension check failed', tone: 'danger' },
  SETTLEMENT_AUTHORIZED: { label: 'Authorized to settle', tone: 'plain' },
  PAYMENT_SETTLED: { label: 'Money moved, exactly once', tone: 'ok' },
  PAYMENT_BLOCKED: { label: 'Payment refused', tone: 'danger' },
  LOGIN_SUCCEEDED: { label: 'Signed in', tone: 'ok' },
  LOGIN_FAILED: { label: 'Sign-in refused', tone: 'danger' },
  QR_ISSUED: { label: 'Signed payment request created', tone: 'plain' },
  QR_REDEEMED: { label: 'Payment request scanned', tone: 'plain' },
};

/** Unknown events fall through to their raw name rather than being dropped. */
export function describeEvent(event: string): { label: string; tone: Tone } {
  return EVENTS[event] ?? { label: event, tone: 'plain' };
}

const TERMINAL = new Set(['SETTLED', 'BLOCKED', 'EXPIRED']);
export const isTerminal = (status: string) => TERMINAL.has(status);

export function statusTone(status: string): Tone {
  if (status === 'SETTLED') return 'ok';
  if (status === 'BLOCKED' || status === 'EXPIRED') return 'danger';
  if (status === 'STEP_UP_REQUIRED') return 'warn';
  return 'plain';
}

export const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Awaiting approval',
  STEP_UP_REQUIRED: 'Needs review',
  AUTHORIZED: 'Authorized',
  SETTLED: 'Settled',
  BLOCKED: 'Blocked',
  EXPIRED: 'Expired',
};

/** Plain English for the documented failure codes. Unknown codes never crash. */
export const FAILURE_TEXT: Record<string, string> = {
  TAMPER_BLOCKED: 'The details changed after this payment was locked.',
  REPLAY_BLOCKED: 'This payment was already settled once.',
  INTENT_EXPIRED: 'The approval window closed. Start a new payment.',
  RISK_BLOCKED: 'The signals for this payment were too strong to allow.',
  POLICY_DENIED: 'A payment policy refused this transaction.',
  STEP_UP_FAILED: 'The verification was not passed.',
  AUTH_FAILED: 'That code did not match this payment.',
  QR_EXPIRED: 'That code has expired. Ask for a new one.',
  QR_ALREADY_USED: 'That code was already paid. Codes are single-use.',
  QR_INVALID_SIGNATURE: 'That code was not issued by PRISM.',
};

export function describeFailure(code: string | null): string {
  if (!code) return 'The payment did not go through.';
  return FAILURE_TEXT[code] ?? `The payment was refused (${code}).`;
}
