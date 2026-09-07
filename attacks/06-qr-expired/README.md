# Attack 06 — Expired QR Reuse

Issues a QR, waits ~65s past its 60-second TTL, then attempts redemption.
Tests the `exp` claim on the signed JWS and the matching Redis TTL. Real
clock wait — takes ~65s to run.

Run: `node attack.mjs` (needs `../.state.json` — run `npm run setup` first).

Full write-up: [`../../attack.md`](../../attack.md) §4, Attack 3c.
