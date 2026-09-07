# Attack 02 — Replay of an Already-Settled Transaction

Fires 10 concurrent `authorize` calls at a transaction seed.ts already
settled. Tests the `transactions.status` check (routes.ts authorize step 1)
— the first of PRISM's three independent replay defences.

Run: `node attack.mjs` (needs `../.state.json` — run `npm run setup` first).

Full write-up: [`../../attack.md`](../../attack.md) §4, Attack 2.
