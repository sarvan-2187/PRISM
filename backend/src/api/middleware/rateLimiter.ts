import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import redis from '../../utils/redis';

/**
 * API Gateway Rate Limiter
 * Backed by Redis for distributed enforcement across restarts.
 */
export const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    // @ts-expect-error — ioredis compatible
    sendCommand: (...args: string[]) => redis.call(...args),
  }),
  message: {
    error: 'Too many requests. Please try again later.',
  },
});
