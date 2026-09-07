# Attack 01 — Transaction Tampering

Tries to settle an expensive transaction by claiming the intent hash of a
cheap one. Tests `intentLock.verifyHash()` (recompute-and-compare against
the DB record) in `backend/src/api/routes.ts` authorize step 4.

Run: `node attack.mjs` (needs `../.state.json` — run `npm run setup` first).

Full write-up: [`../../attack.md`](../../attack.md) §4, Attack 1.
