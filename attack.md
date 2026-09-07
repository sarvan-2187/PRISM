# PRISM S3 Attack & Security Validation Guide

## 1. Scope

**S3** (PLAN.md §4) owns `attacks/**`, `scripts/**`, `docs/**`, and
`README.md` — the adversarial-verification and documentation track that
produces PRISM's "attack-then-defend" evidence independently of whether
the React frontend is finished (Rules §2.F names this a scored criterion
in its own right).

This document maps every security protection **actually implemented** in
the current backend (`backend/src/**`, verified by reading the code, not
assumed from PLAN.md's description) to the single best attack from the
attached threat-model playbook (`PRISM_Threat_Model_and_Pentest_Playbook.md`)
for validating it, and documents the results of actually running each one.

**What is being tested:** the Express monolith at `backend/src/**` — the
Identity (WebAuthn), Intent-Lock, Dynamic QR, Context, Risk Engine,
Semantic Verification, Payment Ledger, Key Management, and API/session
layers described in PLAN.md §3.5. Not tested: the React frontend (S4's
tree) directly, or anything about the physical WebAuthn ceremony's
biometric UX (out of scope for automated testing — see §7).

**Everything here targets our own local instance only** (`localhost:4000`
backend, `localhost:5173` frontend). `attacks/lib/api.mjs` and
`attacks/lib/webauthn.mjs` both hard-refuse to run against any host other
than `localhost`/`127.0.0.1`. This matches Rules §2.D and PLAN.md §10.

## 2. S3 Security Protections

Only protections verified present in the current code. Each row names the
exact file and check.

| Protection | Implementation | Security Goal | Best Attack | Expected Result |
|---|---|---|---|---|
| Claimed-hash tamper check | `intentLock.verifyHash()`, `routes.ts` authorize step 4 | A client-supplied intent hash can never substitute for the server's own recomputed record | Attack 1 — Transaction Tampering | `403 TAMPER_BLOCKED` |
| Transaction-status replay guard | `routes.ts` authorize step 1 (`tx.status === 'SETTLED'`) | A settled payment can never be re-authorized, concurrently or otherwise | Attack 2 — Replay of a Settled Transaction | `409 REPLAY_BLOCKED` on all attempts |
| Redis nonce state machine | `intentLock.nonceState()`/`consumeNonce()`, RESERVED→CONSUMED, never deleted | REPLAY_BLOCKED stays distinct from INTENT_EXPIRED (fixes scaffold bug C7) | (exercised by Attack 2; see §7 for why it isn't tested in isolation) | n/a |
| Ledger `UNIQUE(transaction_id, direction)` | `settlement.ts`, Postgres constraint | Even a forged approval that reached settlement cannot post twice | (exercised by Attack 2's concurrency; DB-level, not independently scriptable without a real assertion — see §7) | n/a |
| 90-second intent expiry | `intentLock.isExpired()`, `routes.ts` authorize step 2 | A stale approval can never be honoured after the window closes | Attack 5 — Expired Intent Reuse | `410 INTENT_EXPIRED` |
| QR Ed25519 signature verification | `keyManager.verifyQrToken()` — explicit `algorithms: ['EdDSA']` allowlist | A printed/forged QR (incl. classic `alg:none`) cannot be redeemed | Attack 3a — Forged/Unsigned QR | `403 QR_INVALID_SIGNATURE` |
| QR single-use (Redis GETSET) | `dynamicQr.redeem()` | A screenshotted/relayed QR cannot be redeemed twice | Attack 3b — QR Replay | `409 QR_ALREADY_USED` |
| QR 60-second expiry | JWS `exp` claim + matching Redis TTL | A stale QR cannot be redeemed after expiry | Attack 3c — Expired QR Reuse | `410 QR_EXPIRED` |
| Ownership checks (IDOR) | `payer_user_id !== req.userId` throughout `routes.ts`; `WHERE id=$1 AND user_id=$2` on credential revoke | A user can never read or act on another user's transactions/credentials by editing an id (closes scaffold bug C10) | Attack 6 — Cross-User IDOR | `404 NOT_FOUND` on every attempt |
| Session cookie integrity (HS256 JWT) | `keyManager.verifySession()` — explicit `algorithms: ['HS256']` allowlist | A forged or algorithm-confused session cookie is never accepted | Attack 7 — Session Cookie Forgery | `401 AUTH_FAILED` |
| Rate limiting on auth/step-up | `strictLimiter` (`rateLimiter.ts`), 20 req / 5 min, Redis-backed | Login and step-up endpoints cannot be hammered without limit | Attack 8 — Login Rate-Limit Brute Force | `429` after the configured max |
| Semantic step-up attempt cap | `semantic.verify()`, `policy.stepUp.maxAttempts = 3` | A 2-digit answer cannot be brute-forced (100 tries otherwise) | Attack 9 — Semantic Step-Up Brute Force | `403 STEP_UP_FAILED`, exhausted at 3 |
| Credential revocation | `identity.revokeCredential()` | A stolen/compromised passkey can be killed and then refused | *(covered by Attack 6's IDOR sub-case; a dedicated positive-path revoke test is P2 in PLAN.md and not separately scripted here)* | — |

Not included: the risk engine's signal set and the WYSIWYS/biometric-bypass
story are **behavioural** claims that need a live, correctly-signed payment
to reach — see §7 for exactly why that currently can't be exercised, and
why that's a separate, already-flagged issue rather than a gap in this
suite's coverage of what *can* be reached.

## 3. Attack Environment

**Prerequisites**

- Backend running: `cd backend && npm run dev` (listens on `:4000`)
- Frontend running: `cd frontend && npm run dev` (listens on `:5173` — WebAuthn is bound to this origin)
- Postgres + Redis: `docker compose up postgres redis -d`, then `cd backend && npm run db:migrate && npm run db:seed`
- Node.js ≥ 20 (uses the built-in global `fetch`; nothing in the attack scripts needs Node's `--experimental-fetch` flag on 20+)

**Attack suite install**

```bash
cd attacks
npm install                      # installs playwright (the only dependency)
npx playwright install chromium  # one-time browser binary download
```

**Environment variables** (all optional, default to the local dev ports):

| Variable | Default | Used by |
|---|---|---|
| `PRISM_BACKEND_URL` | `http://localhost:4000` | all scripts (`lib/api.mjs`, `lib/webauthn.mjs`) |
| `PRISM_FRONTEND_URL` | `http://localhost:5173` | `lib/webauthn.mjs` (WebAuthn origin) |

Both are validated against a `localhost`/`127.0.0.1` allowlist regex at
import time — the scripts throw immediately rather than run against
anything else.

**Test accounts/data:** the two seeded demo accounts from `backend/src/db/seed.ts`
— `asha@prism.demo` (20 synthetic settled payments, ₹1,20,000 balance) and
`priya@prism.demo` (₹8,000 balance, receives payments but is never a
payer). These are the *only* accounts the API can authenticate — there is
no user-creation endpoint, so "fake test accounts" here means these two
explicitly-demo seeded identities, never a production account. All amounts
used by the attack scripts are small paise values against these accounts;
nothing leaves PRISM's closed-loop internal ledger.

**Required external tools:** none beyond Node.js and the Chromium binary
Playwright downloads. The playbook's heavier tools (Burp, ZAP, sqlmap,
jwt_tool, k6/Locust) were deliberately not added — see the per-protection
rationale in §4 for why a purpose-built ~40-line script tests each
protection at least as precisely, with a scriptable PASS/FAIL exit code
CI or a demo can rely on. `npm audit` (dependency hygiene) can be run
directly in `backend/` and `frontend/` and needs no new tooling either.

## 4. Attack-by-Attack Procedures

### Attack: Transaction Tampering (claimed-hash substitution)

**Protection tested:** `intentLock.verifyHash()`, invoked at
`backend/src/api/routes.ts` authorize step 4.

**Why this attack:** PLAN.md names amount/recipient tampering as PRISM's N1
novelty and "the single most important test to demo" (§10, playbook §3
"Amount/recipient tampering post-hash"). The real API has no
`amountMinor` field on `/authorize` to edit directly — the amount is
immutable once locked — so the realistic version of this attack against
*this exact implementation* is claiming a hash captured from a cheap,
genuinely-locked transaction belongs to an expensive one. This is a
stronger test than a malformed hash: it proves the server recomputes from
its own record rather than ever trusting a client-supplied value,
regardless of whether that value is well-formed.

**Threat model:** an attacker who intercepted a genuine approval for a
small amount tries to redirect that approval onto a transaction moving far
more money.

**Prerequisites:** backend running, `npm run setup` completed.

**Target endpoint/flow:** `POST /api/v1/payment/:id/authorize`

**Attack steps:**
```text
1. Log in as Asha (real passkey, from setup).
2. Lock intent A: ₹5.00 to a known payee.
3. Lock intent B: ₹50,000.00 to the same payee.
4. POST /payment/{B.txId}/authorize with body { intentHash: A.intentHash }
   (no real assertion needed — the tamper check runs before signature verification)
5. Observe the response.
6. Sanity check: flip one character of a real hash and retry.
```

**Command:**
```bash
cd attacks && node 01-transaction-tampering/attack.mjs
```

**Attack code:** [`attacks/01-transaction-tampering/attack.mjs`](attacks/01-transaction-tampering/attack.mjs)

**Expected vulnerable behaviour:**
```text
201/200 — transaction B settles at ₹50,000 using a hash that was never
actually computed for it.
```

**Expected secure behaviour:**
```text
403 TAMPER_BLOCKED — "Transaction details do not match what was approved."
```

**PASS condition:** both the cross-transaction substitution and the
single-character corruption return `403 TAMPER_BLOCKED`.

**FAIL / vulnerability condition:** either attempt returns `200`/`202`.

**What this proves:** the server never trusts a client-supplied intent
hash — it always recomputes from the immutable DB record and does a
timing-safe compare. This is the mechanism that makes a captured signature
worthless for authorizing anything other than the exact transaction it was
signed over.

**Verified result (this run):** ✅ **PASS** — both cases returned
`403 TAMPER_BLOCKED`.

---

### Attack: Replay of an Already-Settled Transaction

**Protection tested:** the `transactions.status === 'SETTLED'` check,
`routes.ts` authorize step 1 — the first of PRISM's three independent
replay defences (status check, Redis nonce state machine, ledger `UNIQUE`
constraint; PLAN.md §3.2–§3.4, §10).

**Why this attack:** the playbook's §7 "double-spend via concurrent
requests" is explicitly "the single best test for proving... exactly
once." Firing many requests *concurrently* (not sequentially) is what
actually exercises whether the guard holds under contention, rather than
just under a single retry. Because the status check runs before signature
verification, this can be tested honestly and deterministically against a
transaction seed.ts already settled directly in the database — no live
payment or real WebAuthn assertion required, which makes it fast and
100% reproducible rather than timing-sensitive.

**Threat model:** an attacker who captured a settled payment's approval
request replays it, hoping to drain the account via repeated settlement.

**Prerequisites:** backend running, `npm run setup` completed.

**Target endpoint/flow:** `POST /api/v1/payment/:id/authorize`

**Attack steps:**
```text
1. Log in as Asha.
2. Pick one of her 20 seeded SETTLED transactions.
3. Fire 10 concurrent POST /authorize requests at it.
4. Count how many succeed vs. are refused.
5. Confirm the transaction's status/settledAt is unchanged afterward.
```

**Command:**
```bash
cd attacks && node 02-replay-settled-transaction/attack.mjs
```

**Attack code:** [`attacks/02-replay-settled-transaction/attack.mjs`](attacks/02-replay-settled-transaction/attack.mjs)

**Expected vulnerable behaviour:**
```text
Any of the 10 concurrent attempts returns 200 — money moves again.
```

**Expected secure behaviour:**
```text
409 REPLAY_BLOCKED on all 10, every time.
```

**PASS condition:** 10/10 attempts return `409 REPLAY_BLOCKED`; the
transaction's state is unchanged after.

**FAIL / vulnerability condition:** any attempt returns `200`.

**What this proves:** a settled transaction cannot be re-authorized, full
stop — not "usually," not "except under a race." This is the invariant
PLAN.md closes on: "a failed payment never moves money... Step 11 is the
only place either happens, and it is atomic."

**Verified result (this run):** ✅ **PASS** — 10/10 `409 REPLAY_BLOCKED`.

---

### Attack: Expired Intent Reuse

**Protection tested:** `intentLock.isExpired()`, `routes.ts` authorize
step 2 — the 90-second intent-lock window (`policy.ts intentTtlSeconds`).

**Why this attack:** playbook §3 "TOCTOU... fire two settlement requests"
and §4's expired-QR pattern both point at the same underlying question for
the intent side: does a stale approval attempt get refused deterministically
once the clock has run out? This is a real, unmanipulated wait rather than
a simulated clock — PLAN.md's `PRISM_DISABLE=expiryGuard` kill switch
exists specifically to demonstrate the *vulnerable* half of this attack
honestly, and using it here to skip the wait would test nothing.

**Threat model:** an attacker delays submitting a captured approval,
hoping the server accepts it after the review window a legitimate user
would have seen has closed.

**Prerequisites:** backend running, `npm run setup` completed. Takes ~95s.

**Target endpoint/flow:** `POST /api/v1/payment/:id/authorize`

**Attack steps:**
```text
1. Log in as Asha.
2. Lock a ₹10 intent (90s window).
3. Wait 95s.
4. POST /authorize (placeholder assertion — the expiry check runs before
   signature verification).
5. Observe the response and the transaction's final status.
```

**Command:**
```bash
cd attacks && node 03-expired-intent/attack.mjs
```

**Attack code:** [`attacks/03-expired-intent/attack.mjs`](attacks/03-expired-intent/attack.mjs)

**Expected vulnerable behaviour:**
```text
200 — a stale approval settles after the window has closed.
```

**Expected secure behaviour:**
```text
410 INTENT_EXPIRED; transaction status flips to EXPIRED.
```

**PASS condition:** `410 INTENT_EXPIRED`, transaction status `EXPIRED`.

**FAIL / vulnerability condition:** `200`.

**What this proves:** PLAN.md's 90-second review window is enforced
server-side, on the server's own clock, not just rendered as a countdown
the client could ignore.

**Verified result (this run):** ✅ **PASS** — `410 INTENT_EXPIRED` after a
94s wait; final status `EXPIRED`.

---

### Attack: Forged / Unsigned QR Redemption (incl. alg:none)

**Protection tested:** `keyManager.verifyQrToken()`, called from
`dynamicQr.redeem()` — Ed25519 JWS verification with an explicit
`algorithms: ['EdDSA']` allowlist.

**Why this attack:** this is PLAN.md's QR-manipulation threat by name
("QR manipulation → Ed25519-signed QR... QR_INVALID_SIGNATURE") and the
playbook's §10 alg-confusion bug in the one place PRISM actually signs a
JOSE token besides the session cookie. Testing both a plain garbage
signature *and* the classic `alg:none` header in one script covers the two
most realistic forgery shapes an attacker would actually try against a
printed/screenshotted QR, without needing `jwt_tool` — jose's allowlist
enforcement is a one-parameter check, and a 15-line script demonstrates it
exactly as precisely.

**Threat model:** an attacker prints a fake QR sticker, or crafts a token
claiming `alg:none` to bypass verification entirely, hoping the server
trusts the payload without checking the signature.

**Prerequisites:** backend running, `npm run setup` completed.

**Target endpoint/flow:** `POST /api/v1/qr/redeem`

**Attack steps:**
```text
1. Log in as Asha, lock a real ₹25 intent (for a plausible tx/hash pair).
2. Craft token A: valid-looking header, garbage signature bytes.
3. Craft token B: header claims alg:none, empty signature segment.
4. POST both to /qr/redeem.
```

**Command:**
```bash
cd attacks && node 04-qr-forged-signature/attack.mjs
```

**Attack code:** [`attacks/04-qr-forged-signature/attack.mjs`](attacks/04-qr-forged-signature/attack.mjs)

**Expected vulnerable behaviour:**
```text
200 — either forged token is accepted and returns real transaction details.
```

**Expected secure behaviour:**
```text
403 QR_INVALID_SIGNATURE for both.
```

**PASS condition:** both variants return `403 QR_INVALID_SIGNATURE`.

**FAIL / vulnerability condition:** either returns `200`.

**What this proves:** PRISM's QR is demoted from bearer instrument to
authenticated pointer exactly as designed — a QR that isn't genuinely
signed by the server's Ed25519 key, in the exact algorithm the server
expects, is worthless.

**Verified result (this run):** ✅ **PASS** — both `403 QR_INVALID_SIGNATURE`
(garbage: "signature verification failed"; alg:none: "\"alg\" (Algorithm)
Header Parameter value not allowed").

---

### Attack: QR Replay (Double Redemption)

**Protection tested:** the Redis GETSET single-use claim in
`dynamicQr.redeem()` (`qr:{jti}`, ISSUED→CONSUMED, atomic).

**Why this attack:** this is PLAN.md's N3 novelty claim stated directly
("prevents screenshot reuse") and the playbook's §4 "QR replay" row in
its simplest, most deterministic form. No wait, no concurrency needed —
just redeem once, then again.

**Threat model:** a scammer photographs or relays a victim's legitimate,
still-valid QR and tries to redeem it a second time.

**Prerequisites:** backend running, `npm run setup` completed.

**Target endpoint/flow:** `POST /api/v1/qr/redeem`

**Attack steps:**
```text
1. Log in as Asha, lock a real ₹30 intent.
2. GET /qr/{txId} — issue a genuine signed token.
3. POST /qr/redeem with it — expect success.
4. POST /qr/redeem again with the identical token.
```

**Command:**
```bash
cd attacks && node 05-qr-replay/attack.mjs
```

**Attack code:** [`attacks/05-qr-replay/attack.mjs`](attacks/05-qr-replay/attack.mjs)

**Expected vulnerable behaviour:**
```text
200 twice — the same QR pays out (or is treated as valid) more than once.
```

**Expected secure behaviour:**
```text
First: 200. Second: 409 QR_ALREADY_USED.
```

**PASS condition:** exactly as above.

**FAIL / vulnerability condition:** the second redemption also returns `200`.

**What this proves:** single-use is enforced atomically (GETSET, not a
read-then-write race), which is what a screenshot or a QR-relay attack
actually needs to defeat.

**Verified result (this run):** ✅ **PASS** — first `200`, second
`409 QR_ALREADY_USED`.

---

### Attack: Expired QR Reuse

**Protection tested:** the QR's 60-second `exp` claim plus the matching
Redis `qr:{jti}` TTL, both in `dynamicQr`/`keyManager`.

**Why this attack:** playbook §4 "expired QR reuse" — deterministic,
real-clock, and the direct counterpart to Attack 05 for the *time* axis
rather than the *reuse-count* axis.

**Threat model:** an attacker holds onto an old QR (e.g. from a
screenshot) and tries to redeem it well after it should have gone stale.

**Prerequisites:** backend running, `npm run setup` completed. Takes ~65s.

**Target endpoint/flow:** `POST /api/v1/qr/redeem`

**Attack steps:**
```text
1. Log in as Asha, lock a real ₹15 intent.
2. GET /qr/{txId} (60s TTL).
3. Wait 65s.
4. POST /qr/redeem.
```

**Command:**
```bash
cd attacks && node 06-qr-expired/attack.mjs
```

**Attack code:** [`attacks/06-qr-expired/attack.mjs`](attacks/06-qr-expired/attack.mjs)

**Expected vulnerable behaviour:**
```text
200 — a QR older than its stated lifetime is still honoured.
```

**Expected secure behaviour:**
```text
410 QR_EXPIRED.
```

**PASS condition:** `410 QR_EXPIRED`.

**FAIL / vulnerability condition:** `200`.

**What this proves:** the QR's short lifetime is a real, enforced boundary
on the server side, not merely a UI countdown.

**Verified result (this run):** ✅ **PASS** — `410 QR_EXPIRED` ("\"exp\"
claim timestamp check failed") after a 65s wait.

---

### Attack: Cross-User IDOR

**Protection tested:** the `payer_user_id !== req.userId` ownership check
repeated on every transaction-scoped route in `routes.ts`, and the
`WHERE id = $1 AND user_id = $2` clause on credential revocation.

**Why this attack:** the playbook calls IDOR "one of the highest-value,
lowest-effort tests in all of web security" (§9), and it directly
validates the fix for scaffold bug C10 (PLAN.md §2.7: "client passes its
own userId in every request — trivial impersonation... session JWT in
httpOnly cookie; userId never read from a request body"). This is the
single test that proves that fix actually landed everywhere it needed to,
not just on the route the bug report happened to name.

**Threat model:** an authenticated but unprivileged user edits a
transaction/credential id in their own requests to reach another user's
records.

**Prerequisites:** backend running, `npm run setup` completed (two real
sessions — Asha and Priya).

**Target endpoint/flow:** `GET /payment/:id`, `GET /transactions/:id/timeline`,
`POST /credentials/:id/revoke`

**Attack steps:**
```text
1. Log in as both Asha and Priya (setup does this already).
2. As Priya, GET /payment/{Asha's settled txId}.
3. As Priya, GET /transactions/{same id}/timeline.
4. As Asha, POST /credentials/{Priya's credential id}/revoke.
5. Confirm Priya's credential is still active afterward.
```

**Command:**
```bash
cd attacks && node 07-idor-cross-user/attack.mjs
```

**Attack code:** [`attacks/07-idor-cross-user/attack.mjs`](attacks/07-idor-cross-user/attack.mjs)

**Expected vulnerable behaviour:**
```text
200 — Priya can read Asha's private transaction/timeline, or Asha can
revoke Priya's passkey.
```

**Expected secure behaviour:**
```text
404 NOT_FOUND on every cross-user attempt; no state changes.
```

**PASS condition:** all four checks return `404 NOT_FOUND` (or, for the
revoke, `404` and the credential verified still active).

**FAIL / vulnerability condition:** any `200`, or the credential shows as
revoked afterward.

**What this proves:** authorization is scoped server-side by the session's
`userId`, on every route that touches per-user data — not by anything the
client can influence via a path parameter.

**Verified result (this run):** ✅ **PASS** — all cross-user reads
`404 NOT_FOUND`; the credential revoke attempt also `404 NOT_FOUND`, and
Priya's credential confirmed still active afterward.

*(Note: seed.ts only ever makes Asha the payer in the synthetic history —
Priya is a payee, never a payer — so this run tests the direction the seed
data actually supports. The ownership check in the code is symmetric
either way; see the script's own comment.)*

---

### Attack: Session Cookie Forgery (JOSE alg-confusion / payload tamper)

**Protection tested:** `keyManager.verifySession()` — explicit
`algorithms: ['HS256']` allowlist passed to jose's `jwtVerify`.

**Why this attack:** the playbook's §10 names `alg=none` / algorithm
confusion as "a classic JOSE/JWT bug" and calls checking it "low-risk...
good to run once and check off" — exactly right for PRISM, which uses a
modern, actively-maintained JOSE library (`jose`) with an explicit
algorithm allowlist rather than a permissive default. A weak/guessable
HMAC secret dictionary attack (the playbook's other §10 suggestion) is
not meaningfully testable here without knowing `JWT_SECRET` is
32-byte-random (it is — see `.env.example`), so this suite tests the
structural bug class instead, which is the one an attacker could actually
attempt without prior access to the server's environment.

**Threat model:** an attacker who has a genuine session cookie (e.g. via
XSS, despite the cookie being httpOnly, or a leaked log line) tries to
either strip its signature requirement or repurpose it as a different
user's session.

**Prerequisites:** backend running, `npm run setup` completed.

**Target endpoint/flow:** `GET /api/v1/me` (any `requireSession` route)

**Attack steps:**
```text
1. Take a real session cookie from setup.
2. Decode it; re-encode with header.alg = "none", empty signature.
3. Decode it; swap payload.sub to a different user's id, keep the
   ORIGINAL (now stale) signature.
4. GET /me with each forged cookie.
5. Confirm the real, unmodified cookie still authenticates normally.
```

**Command:**
```bash
cd attacks && node 09-session-jwt-tamper/attack.mjs
```

**Attack code:** [`attacks/09-session-jwt-tamper/attack.mjs`](attacks/09-session-jwt-tamper/attack.mjs)

**Expected vulnerable behaviour:**
```text
200 — the alg:none or payload-swapped cookie authenticates as if genuine.
```

**Expected secure behaviour:**
```text
401 AUTH_FAILED for both forged variants; 200 for the untouched original.
```

**PASS condition:** exactly as above.

**FAIL / vulnerability condition:** either forged cookie returns `200`.

**What this proves:** session identity cannot be forged or reassigned by
an attacker who obtains a cookie value but not the server's HMAC secret,
and the server is not vulnerable to the classic alg-confusion bug class.

**Verified result (this run):** ✅ **PASS** — both forgeries
`401 AUTH_FAILED`; the real cookie's control request `200`.

---

### Attack: Login Rate-Limit Brute Force

**Protection tested:** `strictLimiter` (`backend/src/api/middleware/rateLimiter.ts`),
applied to `/auth/login/options` — `policy.rateLimit.strictMax = 20`
requests per 5-minute window, Redis-backed (survives process restarts).

**Why this attack:** the playbook's §8 "brute force / credential stuffing"
— the most direct test that the limiter actually engages, not just that
it's configured. Testing against `/auth/login/options` with a nonexistent
email is deliberately chosen: the limiter middleware runs before the route
handler even checks whether the email exists, so this tests rate limiting
in complete isolation from account-enumeration concerns.

**Threat model:** an attacker scripts rapid login attempts (credential
stuffing, or probing which emails exist) hoping for no throttling.

**Prerequisites:** backend running. No session needed. **Run this attack
last** in any sequence — see §3 / the script's own README for why.

**Target endpoint/flow:** `POST /api/v1/auth/login/options`

**Attack steps:**
```text
1. Fire 25 rapid POST requests with distinct nonexistent emails.
2. Count how many are processed vs. rejected with 429.
```

**Command:**
```bash
cd attacks && node 08-rate-limit-bruteforce/attack.mjs
```

**Attack code:** [`attacks/08-rate-limit-bruteforce/attack.mjs`](attacks/08-rate-limit-bruteforce/attack.mjs)

**Expected vulnerable behaviour:**
```text
All 25 requests processed (404 for nonexistent email each time); no 429 ever.
```

**Expected secure behaviour:**
```text
Requests processed up to the configured window, then 429 RATE_LIMITED.
```

**PASS condition:** at least one `429` observed before the 25 requests
finish.

**FAIL / vulnerability condition:** zero `429`s across all 25.

**What this proves:** the login endpoint cannot be hammered without limit
— a necessary backstop given passkey login has no password to rate-limit
in the traditional sense, but the options/challenge endpoints themselves
are still a resource an attacker could otherwise abuse.

**Verified result (this run):** ✅ **PASS** — 429s began after 12 requests
in this run (the strict-limit bucket is shared, by client IP, across every
`/auth/*` and `/payment/:id/step-up` call — including the ones `npm run
setup` itself made moments earlier in the same 5-minute window; see the
script's own printed note). The mechanism engaging correctly is what's
being verified, not the exact trip point.

---

### Attack: Semantic Step-Up Brute Force

**Protection tested:** `semantic.verify()` — single-use, 180s TTL, capped
at `policy.stepUp.maxAttempts = 3` wrong answers.

**Why this attack:** playbook §6 names ambiguous-answer fuzzing, but
PRISM's semantic challenge is a fixed two-digit numeric answer (PLAN.md
C5: "last two digits... it is the documented novelty and rate-limitable"),
so the meaningful test is the attempt cap the module's own docstring
names directly: "without the cap a two-digit answer is guessable in 100
tries."

**Threat model:** an attacker who has already passed identity + device
checks (e.g. a coached/pressured victim, or a stolen unlocked device) hits
the semantic step-up and tries to guess past it rather than answer
honestly.

**Prerequisites:** backend and frontend running (WebAuthn origin). Does
**not** need `npm run setup` — it drives its own fresh passkey. Opens a
Chromium window (headless by default in the script; see `lib/webauthn.mjs`).

**Target endpoint/flow:** `POST /api/v1/payment/:id/step-up`

**Attack steps:**
```text
1. Register + log in a fresh passkey for Asha via a virtual authenticator.
2. Lock a ₹48,000 intent to a never-paid payee (PLAN.md's own worked
   "second profile" example for reliably tripping STEP_UP).
3. Complete a REAL signed authorize (challenge -> sign -> authorize).
4. If the live decision is STEP_UP, submit 4 wrong two-digit guesses.
5. Observe attemptsRemaining and the final transaction status.
```

**Command:**
```bash
cd attacks && node 10-semantic-stepup-bruteforce/attack.mjs
```

**Attack code:** [`attacks/10-semantic-stepup-bruteforce/attack.mjs`](attacks/10-semantic-stepup-bruteforce/attack.mjs)

**Expected vulnerable behaviour:**
```text
A brute-forced guess (or a 5th+ attempt) succeeds and the payment settles.
```

**Expected secure behaviour:**
```text
403 STEP_UP_FAILED for all wrong guesses; attemptsRemaining reaches 0 and
the challenge is destroyed at the 3rd wrong answer.
```

**PASS condition:** every guess returns `403 STEP_UP_FAILED`, none
returns `200`.

**FAIL / vulnerability condition:** any guess returns `200`.

**What this proves (when it can run):** the two-digit challenge cannot be
brute-forced within any practically fast window.

**Verified result (this run):** ⚠️ **SKIPPED (blocked by a separate,
documented issue)** — the real signed assertion in step 3 fails
`403 SIG_INVALID` before the risk engine (and therefore STEP_UP) is ever
reached. This is **not** a failure of the step-up attempt cap — it's a
challenge-encoding mismatch in the payment-approval path itself. See §7.

## 5. Recommended Demo Attacks

Ranked for a live hackathon demo — visually clear, fast, and directly tied
to PRISM's stated novelties (PLAN.md §2.5, §10):

1. **Attack 01 — Transaction Tampering.** PRISM's core thesis (N1) in one
   screen: two hashes side by side, one byte's worth of difference, instant
   `TAMPER_BLOCKED`. No wait, no setup drama, immediately legible to a judge.
2. **Attack 02 — Replay of a Settled Transaction.** Fire 10 requests at
   once, watch all 10 die identically. Visually dramatic (a wall of
   `REPLAY_BLOCKED`) and it's the concurrency story the playbook calls out
   as the single best double-spend test.
3. **Attack 04 — Forged/Unsigned QR (incl. alg:none).** The "sticker
   attack dying on signature" moment PLAN.md's own attack table names —
   two forged QR variants, two instant rejections, easy to narrate live.
4. **Attack 07 — Cross-User IDOR.** Fast, classic, and it's the fix for a
   real scaffold bug (C10) that the judges can be told about directly:
   "the scaffold trusted a client-supplied user id; here's proof it no
   longer does."

Skip the two clock-based attacks (03, 06) for a live demo unless there's
time to fill — 90–95 seconds of a terminal counting down is correct
behaviour to prove, but it's dead air on stage. Show their output as a
pre-recorded clip or a screenshot instead (PLAN.md §9 already plans for a
recorded video backup).

## 6. Test Matrix

| ID | Protection | Attack | Tool | Script | Expected Result | Status |
|----|---|---|---|---|---|---|
| 1 | Claimed-hash tamper check | Transaction Tampering | Node (fetch) | `attacks/01-transaction-tampering/attack.mjs` | `403 TAMPER_BLOCKED` | **PASS** (verified) |
| 2 | Transaction-status replay guard | Replay of Settled Transaction | Node (fetch, 10x concurrent) | `attacks/02-replay-settled-transaction/attack.mjs` | `409 REPLAY_BLOCKED` x10 | **PASS** (verified) |
| 3 | 90s intent expiry | Expired Intent Reuse | Node (fetch) | `attacks/03-expired-intent/attack.mjs` | `410 INTENT_EXPIRED` | **PASS** (verified) |
| 4 | QR Ed25519 signature | Forged/Unsigned QR + alg:none | Node (fetch) | `attacks/04-qr-forged-signature/attack.mjs` | `403 QR_INVALID_SIGNATURE` x2 | **PASS** (verified) |
| 5 | QR single-use | QR Replay | Node (fetch) | `attacks/05-qr-replay/attack.mjs` | `409 QR_ALREADY_USED` | **PASS** (verified) |
| 6 | QR 60s expiry | Expired QR Reuse | Node (fetch) | `attacks/06-qr-expired/attack.mjs` | `410 QR_EXPIRED` | **PASS** (verified) |
| 7 | Ownership checks (IDOR) | Cross-User IDOR | Node (fetch, 2 sessions) | `attacks/07-idor-cross-user/attack.mjs` | `404 NOT_FOUND` x3 | **PASS** (verified) |
| 8 | Session cookie integrity | Session Cookie Forgery | Node (fetch) | `attacks/09-session-jwt-tamper/attack.mjs` | `401 AUTH_FAILED` x2 | **PASS** (verified) |
| 9 | Rate limiting (strictLimiter) | Login Rate-Limit Brute Force | Node (fetch, 25x) | `attacks/08-rate-limit-bruteforce/attack.mjs` | `429` after configured max | **PASS** (verified) |
| 10 | Semantic step-up attempt cap | Semantic Step-Up Brute Force | Node + Playwright (virtual authenticator) | `attacks/10-semantic-stepup-bruteforce/attack.mjs` | `403 STEP_UP_FAILED` x3, exhausted | **BLOCKED — see §7** (cannot reach STEP_UP; not a failure of the cap itself) |

All PASS rows above reflect an actual run against a live local instance on
2026-09-07, output captured in the corresponding "Verified result" in §4 —
not assumed from reading the code.

## 7. Known Limitations

**Critical, out-of-scope finding: the payment-approval WebAuthn challenge
encoding is currently broken for every real payment, not just this
suite's tests.**

`identity.paymentChallenge()` (`backend/src/modules/identity/webauthn.ts`)
calls `generateAuthenticationOptions({ challenge: intentHash, ... })`.
`@simplewebauthn/server` v9, when given a **string** `challenge`, encodes
it as `base64url(UTF8(intentHash))` for the wire — verified directly:

```
$ node -e "generateAuthenticationOptions({challenge: '190FB1t...'}).then(o => console.log(o.challenge))"
"MTkwRkIx..."   // a second layer of base64url on top of the already-base64url intentHash
```

The real frontend (`@simplewebauthn/browser`'s `startAuthentication`,
confirmed from its own bundled source: `base64URLStringToBuffer(requestOptionsJSON.challenge)`)
decodes that wire value **once** and signs over it — so the resulting
`clientDataJSON.challenge` round-trips back to the same *wrapped* 59-char
string. But `identity.verifyPaymentAssertion()` then calls
`verifyAssertion(userId, response, intentHash)`, passing the **raw,
unwrapped** 43-char `intentHash` as `expectedChallenge`.
`verifyAuthenticationResponse` compares these with a plain string equality
(confirmed from its source: `if (challenge !== expectedChallenge) throw ...`)
— the two values can never match. **Every genuine, correctly-signed
payment approval fails `403 SIG_INVALID`, unconditionally**, reproduced
live against the running backend with a real CDP virtual-authenticator
signature (see the transcript in Attack 10's write-up above).

This is exactly the risk PLAN.md's §3.1 and §13 name by title — "the
single most important test to demo," "the challenge encoding... do this
first" — and its own status tracker lists the authorize pipeline as
"⚠️ written, never run end to end." That end-to-end run is what this
suite's construction of Attack 10 actually performed, for the first time,
and it surfaces a real defect in the M1 gate (PLAN.md §13: "one payment
settles end to end in a browser... nothing else counts until this does").

**Per the user's explicit direction, this was documented rather than
fixed** — `backend/src/modules/identity/webauthn.ts` is S1's sole-editor
file (PLAN.md §4), outside this suite's scope (`attacks/**`, `scripts/**`,
`docs/**`, `README.md`). **The fix, for whoever owns that file:** either
pass the already-wire-encoded challenge as `expectedChallenge` (fetch it
back from `options.challenge` rather than reusing the raw `intentHash`
string), or pass `challenge` to `generateAuthenticationOptions` as a
`Uint8Array` of the *decoded* hash bytes (matching how the value is
described in `db/types.ts`/`canonical.ts`) instead of as a raw string, so
neither call re-wraps it. Whichever fix lands, `npm test`
(`canonical.test.ts`) will not catch it — that test only pins the hash
function itself, not this downstream encoding step — so add a
regression check alongside the fix.

**Downstream consequences for this suite, stated plainly:**

- Attack 10 (semantic step-up brute force) cannot currently reach a real
  `STEP_UP_REQUIRED` transaction and is marked `SKIPPED`, not `PASS` — see
  §4 and §6. Once the encoding bug above is fixed, rerunning
  `npm run attack:stepup` should reach a live decision.
- The risk engine's actual behavioural signals (`NEW_DEVICE`, `NEW_PAYEE`,
  `AMOUNT_ANOMALY`, etc.) and the full happy-path settlement flow are
  therefore also **not independently verified end-to-end by this suite**
  — they were read from the code (§2 of PLAN.md, `riskEngine.ts`) but a
  live signed payment currently cannot complete to exercise them. This is
  a real gap in current end-to-end coverage, not a gap in this suite's
  design.
- The ledger's `UNIQUE(transaction_id, direction)` constraint and the
  Redis nonce state machine's `RESERVED`→`CONSUMED` transition are
  exercised only indirectly (via Attack 02 against pre-seeded settled
  data, which was inserted directly into Postgres by `seed.ts`, not
  through a live signed settlement). A live-settlement double-spend race
  (playbook §7's `k6`-style concurrent-settle test) is blocked by the same
  encoding issue and is not separately scripted here.

**Other limitations, by design rather than by defect:**

- **QR relay ("quisher") attack** (playbook §4) — PLAN.md itself names
  this "the hardest PRISM attack to fully close" and a "known limitation."
  Not scripted: it's a real-time human-relay scenario, not something a
  deterministic pass/fail script demonstrates meaningfully.
- **Device fingerprint spoofing via headless browser automation**
  (playbook §2) — the context module (`fingerprint.ts`) deliberately
  weights device/session/transaction signals over IP/UA for exactly the
  reason PLAN.md gives (a same-machine second profile shares IP/UA
  family); a headless-Chromium fingerprint-spoofing script wouldn't test
  anything the design doesn't already discount.
- **SQL injection** (playbook §9) — every query in `backend/src/**` uses
  parameterized `pg` queries (`query('... WHERE id = $1', [id])`); there
  is no raw string concatenation anywhere in the codebase to target.
  `sqlmap` was deliberately not added as a dependency for this reason —
  running it against an all-parameterized API would only produce a clean
  report, not new information the code review didn't already establish.
- **Weak/hardcoded JWT secret brute-force** (playbook §10) — `.env.example`
  documents `JWT_SECRET` as a 32-byte random value generated with
  `crypto.randomBytes(32)`; a dictionary attack against it is not a
  meaningful test of this specific deployment's secret. The alg-confusion
  half of the same threat class *is* tested (Attack 07).
- **Redis cache poisoning/eviction abuse** (playbook §7) — an
  infra/ops-configuration concern (eviction policy, persistence config),
  not an application-logic bug; out of scope for a code-level attack
  script and not scripted here.
- **XSS / CSRF / clickjacking** (playbook §11) — every state-changing
  action requires a WebAuthn gesture bound to the exact transaction
  (PLAN.md explicitly notes this "largely already mitigates" CSRF/
  clickjacking for the payment flow), and there is no user-controlled
  rich-text field anywhere in the current schema to inject through. Not
  scripted; would need dedicated tooling (ZAP) disproportionate to what
  the current attack surface actually offers.
- **Basic DoS / resource exhaustion** (playbook §8) — a capacity/
  availability question, not a security-control validation; out of scope
  for "protection → attack" mapping as framed by this document.
