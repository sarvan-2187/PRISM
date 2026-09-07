# Attack 07 — IDOR Across Users

Logged in as both seeded demo accounts, tries to read/act on the other
user's transaction, timeline, and credentials. Tests the
`payer_user_id !== req.userId` / `WHERE user_id = $2` ownership checks
throughout `backend/src/api/routes.ts`.

Run: `node attack.mjs` (needs `../.state.json` — run `npm run setup` first).

Full write-up: [`../../attack.md`](../../attack.md) §4, Attack 6.
