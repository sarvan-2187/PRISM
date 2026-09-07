import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import redis from '../../utils/redis';
import { policy } from '../../config/policy';

/**
 * Rate limiting, enforced at the single API entrance.
 *
 * Two tiers, because the threat differs. The strict one guards anything an
 * attacker would guess at — the two-digit semantic answer above all. Without
 * it, a 3-attempt cap on one challenge means nothing if you can request a
 * thousand challenges.
 */
function limiter(windowMs: number, max: number, prefix: string) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: ((...args: string[]) =>
        redis.call(...(args as [string, ...string[]]))) as never,
    }),
    message: { failureCode: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
  });
}

export const defaultLimiter = limiter(
  policy.rateLimit.defaultWindowMs,
  policy.rateLimit.defaultMax,
  'default'
);

export const strictLimiter = limiter(
  policy.rateLimit.strictWindowMs,
  policy.rateLimit.strictMax,
  'strict'
);
