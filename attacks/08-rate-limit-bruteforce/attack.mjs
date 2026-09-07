/**
 * Attack: Brute force / credential-stuffing against the login endpoint
 *
 * Protection under test: backend/src/api/middleware/rateLimiter.ts strictLimiter,
 * applied to POST /auth/login/options (and /auth/register/options,
 * /auth/[register|login]/verify, /payment/:id/step-up) — policy.rateLimit.strictMax = 20
 * requests per 5-minute window, backed by Redis (rate-limit-redis) so the
 * counter survives process restarts and is shared across instances.
 *
 * No session or real account is needed for this one: the limiter runs
 * before the route handler even looks at whether the email exists, so we
 * hammer it with a nonexistent address and just count how many requests get
 * through before 429s start.
 */
import { post } from '../lib/api.mjs';
import * as p from '../lib/print.mjs';

const REQUESTS = 25; // policy.rateLimit.strictMax is 20 — this should trip it

async function main() {
  p.section('Brute Force Against Login (rate-limit enforcement)');
  p.target('POST', '/api/v1/auth/login/options');
  p.step(`Firing ${REQUESTS} rapid requests (limit is configured at 20 / 5 minutes)`);
  p.info(
    'Note: express-rate-limit keys by client IP by default, and strictLimiter is shared ' +
      'across every /auth/* and /step-up route — earlier attack scripts or app usage from this ' +
      'machine count against the same 5-minute window, so the trip point below may be under 20.'
  );

  const results = [];
  for (let i = 0; i < REQUESTS; i++) {
    const res = await post('/api/v1/auth/login/options', { email: `nobody-${i}@prism.demo` });
    results.push(res.status);
  }

  const allowed = results.filter((s) => s !== 429).length;
  const limited = results.filter((s) => s === 429).length;
  console.log(`    -> ${allowed} requests processed, ${limited} rejected with 429`);
  console.log(`    -> status sequence: ${results.join(',')}`);

  if (limited > 0) {
    p.pass(`rate limiting engaged after ${allowed} requests (configured max: 20)`);
    p.finish('PASS');
  } else {
    p.vulnerability(`All ${REQUESTS} requests were processed with no rate limiting observed.`);
    p.finish('VULNERABILITY');
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exitCode = 2;
});
