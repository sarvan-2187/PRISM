/**
 * The failure catalogue.
 *
 * Every refusal in PRISM has a code, and the code names the attack it stops.
 * The frontend switches on these; the attack scripts assert on them; the audit
 * log records them. One vocabulary, three consumers.
 */
export class PrismError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly failureCode: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PrismError';
  }
}

/** Documented failures, with the attack each one blocks. */
export const FAILURES = {
  AUTH_FAILED: [401, 'Authentication failed.'],
  ORIGIN_MISMATCH: [403, 'Request origin does not match the registered credential.'],
  QR_INVALID_SIGNATURE: [403, 'This QR is not a valid PRISM payment code.'],
  QR_EXPIRED: [410, 'This QR code has expired.'],
  QR_ALREADY_USED: [409, 'This QR code has already been used.'],
  USER_CANCELLED: [200, 'Payment cancelled.'],
  RISK_BLOCKED: [403, 'This payment was blocked as high risk.'],
  STEP_UP_FAILED: [403, 'Verification failed.'],
  TAMPER_BLOCKED: [403, 'Transaction details do not match what was approved.'],
  INTENT_EXPIRED: [410, 'This payment request has expired.'],
  REPLAY_BLOCKED: [409, 'This payment has already been processed.'],
  SIG_INVALID: [403, 'Signature verification failed.'],
  INSUFFICIENT_FUNDS: [402, 'Insufficient balance.'],
  INVALID_AMOUNT: [400, 'Invalid amount.'],
  NOT_FOUND: [404, 'Not found.'],
  // Emitted by the rate limiter and the global error handler respectively.
  // Listed here so FailureCode is complete and all three consumers can switch
  // on the same vocabulary.
  RATE_LIMITED: [429, 'Too many requests. Please slow down.'],
  INTERNAL_ERROR: [500, 'Internal server error.'],
} as const;

export type FailureCode = keyof typeof FAILURES;

/** Throw a catalogued failure. */
export function fail(code: FailureCode, details?: Record<string, unknown>): never {
  const [status, message] = FAILURES[code];
  throw new PrismError(status as number, code, message as string, details);
}
