import { Request, Response, NextFunction } from 'express';

/**
 * Global error handler.
 * Catches all errors propagated via next(err).
 * Avoids leaking stack traces in production.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  console.error('[Error]', err.message, err.stack);

  const statusCode = (err as any).statusCode ?? 500;
  const message =
    process.env.NODE_ENV === 'production' && statusCode === 500
      ? 'Internal server error'
      : err.message;

  res.status(statusCode).json({ error: message });
}
