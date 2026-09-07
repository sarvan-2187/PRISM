# Attack 04 — Forged / Unsigned QR (incl. alg:none)

Submits (a) a garbage-signature JWS and (b) an `alg:none` JWS, both
pointing at a real transaction, to `/qr/redeem`. Tests
`keyManager.verifyQrToken()`'s explicit `algorithms: ['EdDSA']` allowlist.

Run: `node attack.mjs` (needs `../.state.json` — run `npm run setup` first).

Full write-up: [`../../attack.md`](../../attack.md) §4, Attack 3a.
