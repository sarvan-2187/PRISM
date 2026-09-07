import Redis from 'ioredis';
import { config } from '../config/env';

/**
 * Shared Redis client.
 * Used by: rate limiter, nonce/replay cache, challenge cache, session store.
 * Never instantiate Redis elsewhere — import this singleton.
 */
const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err));

export default redis;
