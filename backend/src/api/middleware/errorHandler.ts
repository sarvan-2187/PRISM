import { Request, Response, NextFunction } from 'express';
import { PrismError } from '../errors';

/**
 * Global error handler. Emits one uniform shape — { failureCode, message } —
 * because the frontend, the attack scripts and the audit log all read it.
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  if (err instanceof PrismError) {
    res.status(err.statusCode).json({
      failureCode: err.failureCode,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  // Unexpected: log it in full, tell the caller nothing useful to an attacker.
  console.error('[Error]', err.message, err.stack);
  res.status(500).json({
    failureCode: 'INTERNAL_ERROR',
    message:
      process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
}
