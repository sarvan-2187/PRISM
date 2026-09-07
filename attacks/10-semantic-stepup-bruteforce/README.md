# Attack 10 — Semantic Step-Up Brute Force

Drives its own virtual-authenticator passkey to complete one REAL signed
payment approval to a never-paid payee, then brute-forces the last-two-
digits challenge if the risk engine lands on `STEP_UP`. Tests
`semantic.verify()`'s 3-attempt cap.

**Known limitation:** this is currently the one attack in the suite that
cannot complete — the payment-approval path has a challenge-encoding bug
(unrelated to any control this suite tests) that makes every real signed
assertion fail `SIG_INVALID` before the risk engine runs. The script
detects this specific failure and reports it as `SKIPPED` with a clear
explanation rather than a false pass/fail. See `attack.md` §7 "Known
Limitations".

Run: `node attack.mjs` (opens its own browser; no `npm run setup` needed).

Full write-up: [`../../attack.md`](../../attack.md) §4, Attack 9, and §7.
