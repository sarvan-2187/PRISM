# Attack 05 — QR Replay (Double Redemption)

Issues one genuine signed QR, redeems it, then replays the identical token.
Tests the Redis GETSET single-use claim in `dynamicQr.redeem()`.

Run: `node attack.mjs` (needs `../.state.json` — run `npm run setup` first).

Full write-up: [`../../attack.md`](../../attack.md) §4, Attack 3b.
