/**
 * Operator gate for the Attack Simulation Dashboard.
 *
 * PRISM has no admin/cross-user role (every normal route is scoped to
 * req.userId). The attack endpoints deliberately see across accounts, so
 * they are gated instead by a shared operator token — a judge/demo password,
 * not a user session. Required on every /api/v1/attacks/* route.
 */
import { Request, Response, NextFunction } from 'express';

const TOKEN_HEADER = 'x-attack-token';

export function requireAttackToken(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.ATTACK_ADMIN_TOKEN;
  if (!configured) {
    res.status(503).json({
      failureCode: 'ATTACK_DASHBOARD_DISABLED',
      message: 'ATTACK_ADMIN_TOKEN is not set on the server — the Attack Simulation Dashboard is disabled.',
    });
    return;
  }
  const provided = req.header(TOKEN_HEADER);
  if (provided !== configured) {
    res.status(401).json({ failureCode: 'ATTACK_AUTH_FAILED', message: 'Invalid or missing attack operator token.' });
    return;
  }
  next();
}
