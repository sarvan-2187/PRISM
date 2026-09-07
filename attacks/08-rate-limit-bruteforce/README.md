# Attack 08 — Login Rate-Limit Brute Force

Fires 25 rapid `POST /auth/login/options` requests with no session at all.
Tests `strictLimiter` (`backend/src/api/middleware/rateLimiter.ts`),
policy-configured at 20 requests / 5 minutes, Redis-backed.

**Run this one last** (or via `npm run attack:all`, which already orders it
last) — it shares its rate-limit bucket with `10-semantic-stepup-bruteforce`'s
login step.

Run: `node attack.mjs` (no setup required — doesn't need a session).

Full write-up: [`../../attack.md`](../../attack.md) §4, Attack 8.
