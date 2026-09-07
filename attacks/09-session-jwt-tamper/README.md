# Attack 09 — Session Cookie Forgery (JOSE alg-confusion)

Forges an `alg:none` variant and a payload-swapped-but-stale-signature
variant of a real session cookie. Tests `keyManager.verifySession()`'s
explicit `algorithms: ['HS256']` allowlist.

Run: `node attack.mjs` (needs `../.state.json` — run `npm run setup` first).

Full write-up: [`../../attack.md`](../../attack.md) §4, Attack 7.
