/**
 * Demo-only session capture — a controlled operator facility, not a
 * production feature and not a security bypass.
 *
 * The Live Attack Lab's session-dependent scenarios (tamper, forged
 * assertion, JWT tamper, step-up brute force) genuinely need the payer's
 * real session to act against a real live transaction, because that is the
 * actual threat model being demonstrated: a stolen or copied session cookie.
 * This module lets a device reveal ITS OWN current session so an operator
 * can copy it to the Attack Lab console — it can never reveal anyone else's
 * session, and it never touches the production session code path in
 * api/routes.ts or api/middleware/session.ts.
 *
 * Two independent gates, both required, deliberately layered so no single
 * flag can leave this reachable in a real deployment:
 *   1. NODE_ENV === 'production' → 404 before anything else runs. A code-level
 *      gate, not an env toggle someone could forget to flip.
 *   2. ATTACK_LAB_DEMO_ENABLED=true → required in addition to (1). Off by
 *      default even in development, so a plain `npm run dev` never exposes it.
 * Only once both pass does the ordinary, unmodified `requireSession`
 * middleware apply, and even then this returns only the caller's own cookie.
 */
import { Router } from 'express';
import { config } from '../../config/env';
import { requireSession } from '../../api/middleware/session';
import { SESSION_COOKIE } from '../../api/middleware/session';

const router = Router();

function demoLabEnabled(): boolean {
  return config.nodeEnv !== 'production' && process.env.ATTACK_LAB_DEMO_ENABLED === 'true';
}

router.use((req, res, next) => {
  if (!demoLabEnabled()) {
    res.status(404).end();
    return;
  }
  next();
});

router.get('/my-session', requireSession, (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ failureCode: 'AUTH_FAILED', message: 'No active session on this device.' });
    return;
  }
  res.json({ cookieHeader: `${SESSION_COOKIE}=${token}` });
});

/** Cheap existence probe the frontend uses to decide whether to show the demo button at all. */
router.get('/enabled', (_req, res) => {
  res.json({ enabled: true });
});

export default router;
export { demoLabEnabled };
