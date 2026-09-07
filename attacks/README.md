# PRISM Attack Suite (S3)

Adversarial test scripts that validate the security protections PRISM's
backend actually implements. See the root [`attack.md`](../attack.md) for
the full protection→attack mapping, procedures, and known limitations —
this file is just how to run things.

**Every script targets `http://localhost:4000` only** (see `lib/api.mjs`,
which refuses to run against anything but `localhost`/`127.0.0.1`). Nothing
here touches a remote host, another team's instance, or the event network.

## One-time setup

```bash
cd attacks
npm install
npx playwright install chromium   # downloads a local Chromium binary
npm run setup                     # registers/logs in the two seeded demo accounts
```

`npm run setup` is the only step that opens a browser. It drives a real
WebAuthn ceremony against a Chrome DevTools Protocol **virtual
authenticator** (the same mechanism the threat-model playbook names in its
§1 "Virtual authenticator abuse" row) to register a fresh passkey for
`asha@prism.demo` and `priya@prism.demo`, logs both in, and saves their
session cookies plus a few real ids (a settled transaction, a known payee,
a never-paid payee) to `.state.json` (gitignored).

Requires the backend (`localhost:4000`) and frontend (`localhost:5173`) dev
servers already running — WebAuthn is bound to the frontend's origin.

## Running attacks

```bash
npm run attack:tamper      # 01 — transaction tampering (instant)
npm run attack:replay      # 02 — replay a settled transaction (instant)
npm run attack:idor        # 07 — cross-user IDOR (instant)
npm run attack:qr-forged   # 04 — forged/unsigned QR + alg:none (instant)
npm run attack:qr-replay   # 05 — QR double redemption (instant)
npm run attack:jwt         # 09 — session cookie forgery (instant)
npm run attack:expiry      # 03 — expired intent (~95s, real clock wait)
npm run attack:qr-expired  # 06 — expired QR (~65s, real clock wait)
npm run attack:stepup      # 10 — semantic step-up brute force (opens a browser)
npm run attack:ratelimit   # 08 — login rate limiting — RUN THIS LAST, see below
npm run attack:all         # everything, in a safe order, with a summary at the end
```

Each script exits `0` if the attack was correctly blocked, `1` if it found
a real vulnerability, `2` if the script itself couldn't complete (e.g. the
backend isn't running, or `.state.json` is stale — rerun `npm run setup`).

**Run `08-rate-limit-bruteforce` last**, or use `npm run attack:all` (which
already orders it last). It deliberately exhausts the strict rate limiter,
which `express-rate-limit` keys by client IP and shares across every
`/auth/*` and `/payment/:id/step-up` route — running it early will make
`10-semantic-stepup-bruteforce`'s login attempt fail with `RATE_LIMITED`
for the rest of that 5-minute window.

## Layout

```
attacks/
├── README.md              — this file
├── package.json            — one devDependency: playwright (for setup/ only)
├── lib/
│   ├── api.mjs              — plain fetch() wrapper, localhost-only guard
│   ├── webauthn.mjs         — CDP virtual-authenticator WebAuthn ceremonies
│   ├── state.mjs            — reads/writes .state.json
│   └── print.mjs            — shared [ATTACK]/[PASS]/[VULNERABILITY] output
├── setup/
│   └── provision.mjs        — registers + logs in the two demo accounts
├── 01-transaction-tampering/
├── 02-replay-settled-transaction/
├── 03-expired-intent/
├── 04-qr-forged-signature/
├── 05-qr-replay/
├── 06-qr-expired/
├── 07-idor-cross-user/
├── 08-rate-limit-bruteforce/
├── 09-session-jwt-tamper/
├── 10-semantic-stepup-bruteforce/
└── run_all.mjs             — runs everything in order, prints a summary
```

Nine of the ten scripts are plain HTTP (`fetch`, zero dependencies) —
most of PRISM's protections are enforced **before** WebAuthn signature
verification runs in the authorize pipeline (ownership, status, expiry,
replay, tamper — see `backend/src/api/routes.ts`), so they can be tested
honestly without a real passkey signature. Only `setup/provision.mjs` and
`10-semantic-stepup-bruteforce` need a browser, because reaching a real
risk-engine decision requires a real signed assertion.
