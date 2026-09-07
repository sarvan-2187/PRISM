# Attack 03 — Expired Intent Reuse

Locks an intent, waits ~95s for the 90-second window to close, then
attempts authorize. Tests `intentLock.isExpired()` (routes.ts authorize
step 2). Real clock wait — takes ~95s to run.

Run: `node attack.mjs` (needs `../.state.json` — run `npm run setup` first).

Full write-up: [`../../attack.md`](../../attack.md) §4, Attack 5.
