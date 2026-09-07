# PRISM — 24h Implementation & Execution Plan

## Context

**Why this plan exists.** `S:\prism` already contains a committed scaffold (commit `3a7e2d7`, 07 Sep 10:03, inside the event window). It looks complete but **nothing works**: all 9 backend modules throw `Not implemented`, all 12 API routes return `501`, and the frontend is placeholder JSX. There is no running MVP to secure, and Phase 1 of the official plan ("build a working MVP") is the gate everything else depends on.

**Outcome we need by 09:00 on 08 Sep:** one payment that settles end to end with the intent hash as the WebAuthn challenge, four security controls that visibly block four scripted attacks against our own system, a Future Card adaptation, and a README disclosing AI assistance.

**Scope discipline.** The explainer PDF is a 16-page design document and says so itself: *"deliberately larger than what will be built during the hackathon."* This plan draws the line explicitly and labels every simplification.

---

## 1. Executive Summary

We are at roughly **hour 2 of 24**. The scaffold is a directory layout, not an implementation — treat it as a to-do list with good file names, which is genuinely valuable, but budget zero credit for it as working code.

Four decisions are now locked (confirmed with the team):

| Decision | Choice | Consequence |
|---|---|---|
| Money | **INR integer minor units (paise)** | `amount_minor BIGINT`; deterministic canonical hashing |
| QR signing | **Ed25519 JWS** | Matches novelty N3; `jose` already supports EdDSA, no new dependency |
| Risk demo | **Second browser / incognito** | Context module must lean on device/credential/session signals, *not* IP |
| Frontend | **Rewrite to React + Vite** | Deck fidelity; delete the Next.js app (it does not build today anyway) |

Five things block work **right now**, before any feature code:

1. **Docker daemon is not running.** Postgres and Redis are unavailable. Nothing runs until this is fixed.
2. **No `node_modules`** in either workspace.
3. `frontend/src/app/layout.tsx` imports `./globals.css`, **which does not exist** → build fails. (Moot after the Vite rewrite.)
4. `keyManager.ts` imports `importSecret` from `jose` — **that export does not exist in jose v5** → TypeScript compile error.
5. `db/migrate.ts` is a TODO, so `npm run db:migrate` prints "complete" and applies **nothing**. `db/seed.ts` is referenced by `package.json` but absent.

The single highest-value engineering decision in the whole build is the **intent-hash-to-WebAuthn-challenge encoding contract**. Get it wrong and every payment fails verification with a false `TAMPER_BLOCKED`; the team will lose hours to it at 03:00. Section 3 pins it exactly.

---

## 2. Requirements Analysis

### 2.1 MVP requirements (Dossier PS 01, "BUILD THE MVP")

> *"A working digital payment flow — pick a recipient, enter an amount, authenticate, complete the transaction."*

Exactly four capabilities. Nothing more is MVP:

| # | Requirement | Acceptance |
|---|---|---|
| M1 | Pick a recipient | Recipient list rendered from server data, selectable |
| M2 | Enter an amount | Amount input, server-side validation |
| M3 | Authenticate | Passkey prompt completes |
| M4 | Complete the transaction | Balances change, status `SETTLED`, receipt shown |

### 2.2 Security requirements (Dossier PS 01, "SECURE IT")

> *"Redesign the authentication step so it doesn't lean on a PIN, a static QR, or a single biometric alone. Verify person + device + transaction + context together... It has to survive QR manipulation, biometric bypass, a stolen device, and a replayed transaction."*

Four named threats that **must** be survivable. These map to our four demo attacks:

| Threat | Control | Failure code |
|---|---|---|
| QR manipulation | Ed25519-signed QR carrying only a reference; details fetched from server | `QR_INVALID_SIGNATURE`, `QR_EXPIRED` |
| Biometric bypass | Biometric is one signal; context + risk + semantic still run | `RISK_BLOCKED`, `STEP_UP_FAILED` |
| Stolen device | Context drift + step-up + revocation | `RISK_BLOCKED` |
| Replayed transaction | Nonce consumption + expiry + single settlement | `REPLAY_BLOCKED`, `INTENT_EXPIRED` |

Plus the mechanism the explainer names as the architectural core: **transaction tampering** must produce `TAMPER_BLOCKED`. Not in the dossier's four, but it is our N1 novelty and the strongest thing we can show a judge.

### 2.3 Future Card requirement

Rules PDF §1: *"Around the midpoint of the build, every team draws a Future Card that introduces a new constraint or threat. Adapting to it is mandatory and is part of the evaluation."* Dossier p.2: *"Design your Round-1 system to be adaptable, not just complete."*

Contents are unknown and **must not be guessed**. Requirement is architectural: adaptation must be cheap. Section 11 covers this.

### 2.4 Judging criteria (Rules §2.F)

Security depth and correctness · working MVP · attack-then-defend demonstration · Future Card adaptation · originality · clarity of explanation.

Two are process gates, not code: *"Teams must genuinely understand their own work and be able to explain any part of it on request"* and *"Any significant AI or external assistance must be disclosed."* Both are disqualification risks if ignored.

### 2.5 Minimum convincing demo

Ranked by judge impact per hour spent:

1. **Tamper demo** — same passkey signature, one rupee changed, `TAMPER_BLOCKED`. This *is* PRISM's thesis.
2. **Replay demo** — captured request replayed, `REPLAY_BLOCKED`.
3. **QR swap demo** — a plain printed QR rejected on signature.
4. **Happy path** — under 5 seconds, no friction, proving security is invisible when nothing is wrong.
5. **Step-up / semantic** — "type the last two digits", from a second browser profile.
6. **Security timeline** — the audit trail rendered per transaction; makes everything above self-evidencing.

### 2.6 Deferred (documented as design, not built)

Straight from the explainer's own "Designed but not built" list, plus our additions:

- HSM key custody (env config instead) · notification service (email/SMS/push) · full micro-fingerprint signal set · cross-device revocation · key rotation workflows
- **Ours:** camera QR scanning (link-based path is primary — the explainer already flags in-browser camera as the least predictable component); impossible-travel/ASN reputation; ML risk scoring; multi-currency; account recovery; `qr_tokens` / `context_snapshots` / `risk_assessments` / `semantic_challenges` tables (Redis + `audit_logs` cover the demo)

### 2.7 Contradictions and ambiguities found

**Between documents and scaffold** — resolved by this plan:

| # | Conflict | Resolution |
|---|---|---|
| C1 | Intent TTL: explainer 60–90s, deck workflow 90s, scaffold `300` | **90s**, in `policy.ts` |
| C2 | Currency: explainer INR/paise, scaffold `NUMERIC(12,2)` USD | **INR minor units** (confirmed) |
| C3 | Hash input: explainer `SHA-256(canonical_JSON)`, scaffold pipe-delimited string | **Canonical JSON** per explainer |
| C4 | QR alg: explainer/deck Ed25519, scaffold HS256 | **Ed25519** (confirmed) |
| C5 | Semantic challenge: explainer "last two digits", scaffold free-text `challengeText` | **Last two digits** — it is the documented novelty and rate-limitable |
| C6 | Stack: deck "React.js", scaffold Next.js | **React + Vite** (confirmed) |
| C7 | Scaffold `consumeNonce` **deletes** the key, so replayed and expired become indistinguishable | Mark `CONSUMED` with a longer TTL — see §3.4 |
| C8 | Settlement TODO references an `accounts` table **that does not exist**; there is no money to move | Add `accounts` table |
| C9 | `recipient_id TEXT` is not a foreign key | Becomes `payee_account_id UUID REFERENCES accounts(id)` |
| C10 | Client passes its own `userId` in every request (`apiClient.initiatePayment({userId})`) — trivial impersonation | Session JWT in httpOnly cookie; `userId` **never** read from a request body |
| C11 | `docker-compose.yml` builds `./backend` and `./frontend` but **no Dockerfiles exist** | Use compose for Postgres/Redis only; do not promise full-stack compose |

**Unresolvable here — must be verified with organizers:** see §14.

---

## 3. Architecture Plan

Modular monolith, exactly as the documents specify. One Express process, internal function calls, PostgreSQL for durable records, Redis for short-lived state. **No microservices, no message bus, no ORM.**

```
React SPA (Vite) ──HTTPS──> Express API (rate limit + session cookie)
                                  │
   ┌──────────────┬───────────────┼───────────────┬──────────────┐
Identity      Intent-Lock    Dynamic QR       Context         Audit
(WebAuthn)   (hash+nonce)   (Ed25519 JWS)  (drift score)   (append-only)
   └──────────────┴───────────────┼───────────────┴──────────────┘
                          Adaptive Risk Engine
                     approve │ step-up │ block
                                  │
                    Semantic Verification (step-up only)
                                  │
                          Payment Ledger (atomic)
                                  │
                    PostgreSQL          Redis
```

### 3.1 The hash contract (single most important interface — pin this first)

Every module and both agents building against it depend on these exact rules.

```ts
// backend/src/utils/canonical.ts  — OWNER: S1, hour 2, before anything else
intent = {
  amountMinor: 500000,        // integer paise, never a float or string
  createdAt:   1788160000,    // integer epoch SECONDS
  currency:    "INR",
  expiresAt:   1788160090,    // createdAt + 90
  lockVersion: 1,
  nonce:       "<64 hex chars>",
  payeeAccountId: "<uuid>",
  payerUserId: "<uuid>",
  txId:        "<uuid>"
}
// canonicalJSON = JSON.stringify with keys sorted ASCII-ascending, no whitespace
// hashBytes = sha256(utf8(canonicalJSON))            -> 32 raw bytes
// intentHash = base64url(hashBytes)                  -> stored in DB, IS the challenge
```

Three rules that prevent the classic 03:00 debugging spiral:

1. **The client never computes the hash.** The server computes it and returns it. There is exactly one implementation.
2. **`transactions.intent_hash` stores the base64url form, and that string is passed verbatim as the WebAuthn challenge and as `expectedChallenge` on verification.** One representation, zero conversions. Display hex nowhere except a truncated UI label.
3. **All numbers are integers.** No `NUMERIC`, no floats, no locale formatting anywhere near the hash.

> *Simplification (labelled):* the explainer's canonical JSON is a general algorithm; we implement sorted-key `JSON.stringify` over a fixed flat object. Sufficient because the intent shape is fixed and server-generated.

### 3.2 Database (PostgreSQL)

Migration `001` is rewritten in place **before hour 3** (it has never been applied, so nothing is lost). After that, migrations are **append-only** — `002_*.sql`, `003_*.sql`. This is the rule that stops four agents corrupting each other's schema.

```sql
users            (id, email UNIQUE, display_name, created_at)
accounts         (id, user_id NULL, display_name, handle UNIQUE,
                  balance_minor BIGINT NOT NULL DEFAULT 0, is_external BOOL)
credentials      (id PK, user_id FK, public_key BYTEA, counter BIGINT,
                  device_type, backed_up, transports, created_at, last_used_at,
                  revoked_at TIMESTAMPTZ NULL)
transactions     (id, payer_user_id FK, payer_account_id FK, payee_account_id FK,
                  amount_minor BIGINT CHECK (> 0), currency TEXT DEFAULT 'INR',
                  intent_hash TEXT UNIQUE, nonce TEXT UNIQUE,
                  created_at, expires_at, status transaction_status,
                  risk_score INT, risk_reasons JSONB, failure_code TEXT)
ledger_entries   (id, transaction_id FK UNIQUE, account_id FK,
                  direction ('DEBIT'|'CREDIT'), amount_minor BIGINT, settled_at)
audit_logs       (id, transaction_id FK NULL, user_id FK NULL,
                  event_type TEXT, event_data JSONB, created_at)
```

Key integrity properties, enforced by the database rather than by application code:

- `ledger_entries.transaction_id UNIQUE` → **a transaction can settle at most once, ever.** This is replay defence layer 3 and it is a constraint, not a code path.
- `accounts.balance_minor BIGINT` → integer money throughout.
- `transactions.intent_hash UNIQUE` → identical intents cannot collide.
- `credentials.revoked_at` → supports the revocation half of the stolen-device story.

> *Simplification:* the explainer names 11 tables; we ship 6. `qr_tokens`, `context_snapshots`, `risk_assessments`, and `semantic_challenges` live in Redis (short-lived) with their decisions captured in `audit_logs` (durable). Say this out loud to judges — it is a defensible trade, not an omission.

### 3.3 Redis usage

| Key | Value | TTL | Purpose |
|---|---|---|---|
| `nonce:{nonce}` | `RESERVED` \| `CONSUMED` | 900s | Replay defence layer 1 |
| `challenge:reg:{userId}` | base64url challenge | 300s | Registration |
| `challenge:auth:{txId}` | `intent_hash` | 120s | Auth challenge freshness |
| `qr:{jti}` | `ISSUED` \| `CONSUMED` | 60s | Single-use QR |
| `ctx:baseline:{userId}` | JSON snapshot | 24h | Context baseline |
| `stepup:{txId}` | JSON `{token, expected, attempts}` | 180s | Semantic challenge |
| `rl:*` | counters | window | Rate limiting |

**Contingency:** every one of these is single-process state behind five operations (`get/set/setex/del/incr`). If Docker will not start, a ~20-line in-memory shim exposing the same interface removes Redis from the critical path in minutes. Keep Redis as the real design — the deck names it — and hold the shim as a documented fallback only.

### 3.4 Nonce state machine (fixes scaffold bug C7)

The scaffold deletes the nonce key on consumption, which makes a *replayed* nonce look identical to an *expired* one. The failure catalogue requires them to be distinct codes.

```
lockIntent()      -> SET nonce:{n} = RESERVED, EX 900
authorize()       -> GET nonce:{n}
                       missing   -> INTENT_EXPIRED   (410)
                       CONSUMED  -> REPLAY_BLOCKED   (409)
                       RESERVED  -> proceed
settle()          -> SET nonce:{n} = CONSUMED, EX 900   (never DEL)
```

Because `CONSUMED` outlives the 90-second intent window by an order of magnitude, a replay inside any plausible demo window reports `REPLAY_BLOCKED` correctly.

### 3.5 Module specification

Every module: one class, one file, plain internal function calls. No dependency injection framework, no interfaces with a single implementation.

---

**Identity Module** — `modules/identity/webauthn.ts` · **Owner S1**

- **Responsibility:** passkey registration and transaction-bound assertion verification.
- **In:** `{userId,email}` / `{txId, assertionResponse}`
- **Out:** WebAuthn options JSON / `{verified, credentialId}`
- **Tables:** `credentials`, `users`
- **Endpoints:** `POST /auth/register/options|verify`, `POST /auth/login/options|verify`, `POST /payment/:id/challenge`
- **Security:** RP ID + origin check (phishing); `userVerification: 'required'`; challenge freshness via Redis; counter stored but **not** trusted for clone detection (many platform authenticators return 0 — the explainer flags this and we must repeat the caveat rather than overclaim).
- **Depends on:** Redis, `db/pool`, `policy.ts`

**Intent-Lock Module** — `modules/intent/intentLock.ts` · **Owner S1**

- **Responsibility:** freeze the transaction, compute the hash, own the nonce lifecycle. **The heart of the system.**
- **In:** `{payerUserId, payeeAccountId, amountMinor}` from a session, never from a body-supplied user id
- **Out:** `{txId, intentHash, expiresAt}` — deliberately does **not** return the nonce to the client; it has no client-side use and returning it invites replay experiments
- **Endpoints:** `POST /payment/initiate`, `GET /payment/:id` (server-authoritative details)
- **Security:** amount/recipient immutable post-lock; any change creates a *new* transaction with a new id, nonce, and hash; 90-second expiry; timing-safe hash comparison.

**Dynamic QR Module** — `modules/qr/dynamicQr.ts` · **Owner S1**

- **In:** `txId` / signed compact JWS
- **Out:** `{token, expiresAt}` / `{txId, intentHash}`
- **Security:** Ed25519 JWS, payload `{v,tx,ih,n,exp,kid}` — **reference only, never amount or payee**; 60s expiry; `jti` single-use in Redis; verified server-side on redemption. Client fetches authoritative details via `GET /payment/:id`; the QR is a pointer, never a source of truth.
- **Endpoints:** `GET /qr/:txId`, `POST /qr/redeem`

**Context Module** — `modules/context/fingerprint.ts` · **Owner S1**

Adjusted for the second-browser demo choice. Incognito shares your IP and UA family, so IP-based drift would produce **nothing** on stage. Weight the deterministic signals instead:

| Signal | Fires in incognito? | Weight |
|---|---|---|
| Unrecognised/absent credential for this session | **Yes, always** | High |
| No context baseline for this browser profile | **Yes, always** | High |
| New payee (never paid before) | Yes, controllable | High |
| Amount far outside payer's history | Yes, controllable | Medium |
| Short deliberation time (screen shown → approve) | Yes, controllable | Medium |
| IP/ASN change | No, same machine | Low |

This makes the incognito demo **reliable rather than hopeful**. Seed synthetic history (§4, M0) so "unusual amount" and "new payee" have a baseline to deviate from — the explainer explicitly flags that behavioural signals need history.

- **Privacy boundary (state this to judges):** a consistency signal, not tracking. Coarse, hashed, short-retention. No canvas/audio fingerprinting, no browsing history, no raw biometrics.

**Adaptive Risk Engine** — `modules/risk/riskEngine.ts` · **Owner S1**

- **Responsibility:** the one decision point. `APPROVE` | `STEP_UP` | `BLOCK`.
- **Design:** an array of **pure rule functions** `(signals) => {points, reason} | null`. Rules-first, never ML — every decision must state which rules fired. Explainability is novelty N6 and is what makes adding a Future Card rule a one-file change.
- **Out:** `{score, decision, reasons[]}` — `reasons[]` is persisted and rendered in the UI. A judge asking "why was this blocked?" gets a literal answer.
- **Thresholds:** in `policy.ts`, not inline.

**Semantic Verification** — `modules/semantic/intentCheck.ts` · **Owner S1**

- **Challenge:** *"Enter the last two digits of the amount."* Server-derived from the locked record. Single-use, 180s, **max 3 attempts**, rate-limited — without the attempt cap a two-digit answer is guessable in 100 tries, which a judge will ask about.
- **On success:** requires a **fresh** transaction-bound assertion before settlement. The step-up does not itself authorize.

**Payment Ledger** — `modules/ledger/settlement.ts` · **Owner S1**

- **Responsibility:** move money correctly, exactly once.
- **How:** one DB transaction: `SELECT ... FOR UPDATE` on both accounts ordered by id (deadlock avoidance), balance check, two `ledger_entries` rows, `status → SETTLED`, `COMMIT`. Then mark nonce `CONSUMED`.
- **Guard:** `ledger_entries.transaction_id UNIQUE` makes double settlement impossible even under concurrent identical requests.

> `SELECT FOR UPDATE NOWAIT` from the scaffold's TODO would throw on contention rather than serialise. Use plain `FOR UPDATE` — blocking then failing the status check is the correct behaviour.

**Audit + Alerts** — `modules/audit/logger.ts` · **Owner S1**

- Append-only `audit_logs`. Every decision writes one row. Errors swallowed — audit must never break a payment.
- `GET /transactions/:id/timeline` feeds the security timeline UI. This endpoint is what makes the whole demo self-evidencing; build it early.

**Key Management** — `modules/keys/keyManager.ts` · **Owner S1**

- Only module reading key material. Ed25519 keypair for QR (EdDSA via `jose`), HMAC secret for session JWTs.
- **Fix the broken `importSecret` import first** — it does not exist in jose v5.
- Ed25519 keypair generated at boot if no PEM in env, logged with its `kid`. *Simplification: env/ephemeral instead of HSM — already declared in the explainer's scope boundary.*

**API layer** — `api/routes.ts` + `api/middleware/` · **Owner S1**

- `session.ts` (new): verifies the httpOnly JWT cookie, sets `req.userId`. **Closes C10.**
- Rate limits: strict on `/verify/step-up` and `/auth/*`, looser elsewhere.
- Uniform error shape `{failureCode, message}` — S2 and S3 both bind to this contract.

### 3.6 End-to-end authorize pipeline

```
POST /payment/:id/authorize   { assertion }
 1  session cookie -> userId                        401 AUTH_FAILED
 2  load tx, assert ownership + status PENDING      403 / 409
 3  expiry check                                    410 INTENT_EXPIRED
 4  nonce state check                               409 REPLAY_BLOCKED
 5  recompute hash from DB, timing-safe compare     403 TAMPER_BLOCKED
 6  verify assertion (challenge == intent_hash)     403 SIG_INVALID / ORIGIN_MISMATCH
 7  context snapshot -> drift signals
 8  risk engine -> APPROVE | STEP_UP | BLOCK        403 RISK_BLOCKED
 9  STEP_UP -> 202 + challenge (no money moves)
10  balance check                                   402 INSUFFICIENT_FUNDS
11  settle atomically; nonce -> CONSUMED
12  audit every branch above, always
```

**The invariant to state at judging:** *a failed payment never moves money and never consumes the nonce.* Step 11 is the only place either happens, and it is atomic.

---

## 4. Team Responsibility Matrix

Four agents, one repository. **File ownership is the mechanism that prevents overwrites** — not politeness, not coordination chatter.

| Path | Owner | Others |
|---|---|---|
| `backend/src/modules/**` | **S1** | read-only |
| `backend/src/db/**`, `config/**`, `utils/**` | **S1** | read-only |
| `backend/src/api/**` | **S1** | request changes |
| `frontend/src/pages/**`, `lib/**` | **S2** | read-only |
| `frontend/src/components/flow/**` | **S2** | read-only |
| `attacks/**` | **S3** | read-only |
| `backend/src/**/*.test.ts`, `scripts/smoke.mjs` | **S3** | read-only |
| `frontend/src/components/ui/**`, `styles/**` | **S4** | read-only |
| `frontend/src/pages/Landing.tsx`, `Timeline.tsx`, `Receipt.tsx` | **S4** | read-only |
| `README.md`, `docs/**` | **S4** | request changes |
| `docker-compose.yml`, `.env.example` | **S4** | request changes |

**Hot shared files** — `routes.ts`, `api-client.ts`, `db/types.ts`, `policy.ts`. Rule: only the owner edits; anyone else opens a one-line request in the team channel. `api-client.ts` is owned by S2 but its **shape is dictated by S1's routes** — agree it in writing at hour 2 and treat it as frozen.

S4 is deliberately given real product surface (landing, security timeline, receipt, the whole design system) plus infra and docs — **not** documentation alone. From hour 12 S4 is the Future Card implementation lead, because S4 is the only member without a critical-path dependency at that point.

---

## 5. Detailed Task Breakdown

Complexity: **S** ≈ <45min · **M** ≈ 1–2h · **L** ≈ 2–4h. Priority: **P0** = demo fails without it.

### M0 — Unblock (hour 2–3) · everyone, in parallel

| Task | Owner | Pri | Cx | Depends | Done when | Files | ∥ |
|---|---|---|---|---|---|---|---|
| Start Docker Desktop; `compose up postgres redis -d` | S4 | P0 | S | — | `docker ps` shows both healthy | — | ✓ |
| `npm install` both workspaces | S1,S2 | P0 | S | — | no install errors | `package.json` | ✓ |
| Rewrite migration 001 + implement `migrate.ts` | S1 | P0 | M | Docker | `npm run db:migrate` creates 6 tables | `db/migrations/001`, `db/migrate.ts` | ✗ |
| `seed.ts`: Asha, Priya, 2 known payees, 1 external, balances, ~20 synthetic past txns | S1 | P0 | S | migrate | risk baselines have history | `db/seed.ts` | ✗ |
| Delete Next.js app, scaffold Vite + React 18 + React Router | S2 | P0 | M | npm i | `npm run dev` serves a routed blank app | whole `frontend/` | ✓ |
| Fix `keyManager` jose import; Ed25519 keypair + session HMAC | S1 | P0 | S | npm i | `tsc` clean; sign/verify round-trips | `modules/keys/keyManager.ts` | ✓ |
| `policy.ts` — all tunables centralised | S1 | P0 | S | — | no magic numbers elsewhere | `config/policy.ts` | ✓ |
| `canonical.ts` + **self-check asserting a known vector** | S1 | P0 | S | — | `node --test` passes | `utils/canonical.ts` | ✓ |
| Agree API contract in writing | all | P0 | S | — | `docs/api-contract.md` merged | `docs/` | ✗ |

### M1 — Payment settles end to end (hour 3–8) · **critical path**

| Task | Owner | Pri | Cx | Depends | Done when | ∥ |
|---|---|---|---|---|---|---|
| Session cookie middleware | S1 | P0 | S | keyManager | `userId` never read from a body | ✓ |
| Passkey register + login | S1 | P0 | L | session | credential row persists; login sets cookie | ✗ |
| Intent lock + `GET /payment/:id` | S1 | P0 | M | canonical, migrate | hash stable across restarts | ✗ |
| Challenge = intent hash; assertion verify | S1 | P0 | L | identity, intent | **assertion verifies against the hash** | ✗ |
| Audit logger + timeline endpoint | S1 | P0 | S | migrate | every branch writes a row | ✓ |
| Ledger settlement | S1 | P0 | M | intent | balances move; second attempt rejected | ✗ |
| Register/login UI | S2 | P0 | M | contract | passkey registers in Chrome | ✓ |
| Payment composer (payee + amount) | S2 | P0 | M | contract | posts initiate, receives txId | ✓ |
| Review screen, **server-authoritative** + countdown | S2 | P0 | M | `GET /payment/:id` | renders **only** server values | ✓ |
| Passkey prompt + authorize | S2 | P0 | M | above | happy path completes in browser | ✗ |
| `scripts/smoke.mjs` end-to-end assertion | S3 | P0 | M | routes | one command proves the pipeline | ✓ |
| Design tokens, layout shell, receipt | S4 | P1 | M | Vite | consistent, readable, dark-safe | ✓ |
| Security timeline UI | S4 | P0 | M | timeline endpoint | shows every decision + reason | ✓ |

### M2 — Security layer (hour 8–14)

| Task | Owner | Pri | Cx | Depends | ∥ |
|---|---|---|---|---|---|
| Context module (device/session-weighted) | S1 | P0 | M | M1 | ✓ |
| Risk engine + rule array + reasons | S1 | P0 | M | context | ✗ |
| Semantic step-up (last two digits, 3 attempts, rate-limited) | S1 | P0 | M | risk | ✗ |
| Ed25519 QR issue + redeem | S1 | P0 | M | keyManager | ✓ |
| Rate limiting tightened per route | S1 | P1 | S | — | ✓ |
| Credential revocation endpoint | S1 | P2 | S | identity | ✓ |
| Step-up UI + failure-code screens | S2 | P0 | M | semantic | ✓ |
| QR display + link redemption page | S2 | P1 | M | QR | ✓ |
| **Attack 1 tamper · 2 replay · 3 QR swap · 4 expiry** | S3 | P0 | L | M2 | ✓ |
| `PRISM_DISABLE` control toggle (dev-only) | S3+S1 | P1 | S | policy | ✓ |
| Threat model doc mapping attack→control→code | S3 | P1 | M | — | ✓ |
| README: approach, **AI disclosure**, run steps | S4 | P0 | M | — | ✓ |

### M3 — Future Card (from draw time) · S4 leads, S1 supports, S2 UI, S3 re-tests

### M4 — Freeze, rehearse, submit (hour 21–24)

Regression via `smoke.mjs` + all attacks · three full demo rehearsals · screenshots · architecture diagram · final README · repo public and cloned-fresh verified.

### Critical path, bottlenecks, deferrals

- **Critical path (S1, ~9h serial):** migration → canonical hash → identity → intent lock → hash-as-challenge → authorize pipeline → ledger. This is one person's serial work and **cannot be parallelised** — the explainer says so and it is correct. S1 must not be given anything else.
- **Parallel from hour 2:** S2 frontend against the contract, S3 smoke/attack harness against stubs, S4 design system + docs + infra.
- **Integration bottlenecks:** (i) API contract at hour 2 — if it slips, S2 and S3 build against nothing; (ii) hour 8 first-integration; (iii) the WebAuthn challenge encoding, the single likeliest multi-hour sink.
- **Must precede reviews:** faculty → happy path settles; night → tamper + replay blocked live; jury → all four attacks + Future Card.
- **Deferrable without mercy:** camera scanning, revocation UI, animations, mobile layout, `PRISM_DISABLE`, extra risk signals.

---

## 6. Critical Path

```
Docker+deps ─> migration ─> canonical hash ─> identity ─> intent lock
     ─> hash-as-challenge ─> authorize pipeline ─> ledger ─> SETTLED
                                    │
     (parallel, non-blocking) ──────┼── S2 UI ── S3 attacks ── S4 design/docs
```

**Hour-10 abort rule**, taken directly from the explainer: *"If no payment settles end to end by hour 10, scope is cut immediately rather than pushed forward."* First cuts, in order: QR module → semantic step-up → context/risk (fall back to fixed thresholds on amount + new-payee only). Never cut: intent lock, hash-as-challenge, replay defence, ledger.

---

## 7. Implementation Timeline

Anchored to the **official** rules schedule (09:00 07 Sep → 09:00 08 Sep). Future Card time is disputed — see §14 — so we are **Future-Card-ready by 20:30**, the earliest of the three claimed times.

| Wall clock | Hr | Milestone |
|---|---|---|
| 09:00–11:00 | 0–2 | *(elapsed)* scaffold committed |
| **11:00–12:00** | **2–3** | **M0: Docker up, deps installed, schema applied, seed loaded, contract agreed** |
| 12:00–13:00 | 3–4 | Identity: registration works |
| 13:00–13:45 | — | Lunch (rotational) — build continues |
| 13:45–16:00 | 4–7 | Intent lock + hash-as-challenge + authorize |
| **16:00–17:00** | **7–8** | **M1: first payment settles end to end** |
| 17:00–18:00 | 8–9 | Timeline UI + smoke test green |
| **18:00–18:30** | **9** | **Mentor checkpoint / faculty review** |
| 18:30–20:30 | 9–11 | Context + risk + semantic + QR |
| **20:30** | **11** | **M2 complete — feature-frozen, Future-Card-ready** |
| 20:30–22:00 | 11–13 | Attacks 1–4 scripted and blocking |
| **21:00 / 22:00 / 00:00** | — | **Future Card — actual time disputed** |
| Draw → +4h | — | **M3: Future Card implemented, re-tested** |
| 02:00–05:00 | 17–20 | Hardening, polish, screenshots, docs |
| 05:00–06:00 | 20–21 | Full regression: smoke + 4 attacks + happy path |
| **06:00–06:30** | **21** | **Progress review 2 (official)** |
| 06:30–08:30 | 21–23 | **Three** full demo rehearsals, start to finish |
| 08:30–09:00 | 23–24 | Submission upload |
| **09:00** | **24** | **CODE FREEZE — hard** |
| 09:00–11:00 | — | **Jury: attack-then-defend** |

---

## 8. GitHub Workflow

Repo: `https://github.com/sarvan-2187/PRISM` (already remote, `main` only). Trunk-based, short-lived branches, small merges. **PR review ceremony is overhead at this scale** — ownership plus a green smoke test is the real gate.

**Branches:** `s1/intent-lock`, `s2/pay-composer`, `s3/attack-replay`, `s4/security-timeline` — one task, merged within ~2 hours. Never let a branch live overnight.

**Commits:** conventional — `feat(intent): hash-as-challenge binding`, `fix(qr): reject expired jti`. Scope = module name. This makes the git log double as the originality evidence the rules require.

**Merge rules:**
1. Before every push: `git pull --rebase origin main`.
2. Own-area changes → merge yourself once `npm run smoke` passes.
3. Hot shared files (`routes.ts`, `api-client.ts`, `db/types.ts`, `policy.ts`, `README.md`) → owner ack required.
4. **`main` must always run.** If a merge breaks it, revert first and fix on a branch. Never leave `main` broken while debugging.
5. **Never force-push `main`. Never squash or rebase away commit timestamps** — the timestamps are our proof that all code was written inside the event window (Rules §2.C).

**Merge order at integration points:** S1 schema/contract → S1 modules → S2 UI → S3 tests → S4 polish. Polish never merges ahead of the thing it polishes.

**Conflict prevention:** ownership table (§4) is the primary mechanism; migrations are append-only after hour 3; `.env` is never committed (`.env.example` is, and S4 owns it).

**Definition of runnable `main`:** `docker compose up postgres redis -d && npm run db:migrate && npm run db:seed && npm run dev` in backend, `npm run dev` in frontend, then `npm run smoke` exits 0.

---

## 9. Review Checkpoints

### Faculty review — post-lunch / 18:00 mentor checkpoint

- **Working:** register passkey, compose payment, review server-authoritative details, approve, settle. Balances change. Timeline shows the decision chain.
- **Demonstrate:** the happy path, then the tamper attempt if it is ready.
- **Evidence:** terminal showing `SETTLED`, timeline screenshot, `psql` row from `ledger_entries`.
- **Explain:** S1 — why the challenge *is* the hash; S2 — why the review screen never renders QR/URL values; S3 — what the smoke test asserts; S4 — the schema and the run instructions.
- **Not left unfinished:** a payment that settles. Without it there is no MVP and Phase 1 has failed.

### Night student-coordinators review 2

- **Working:** all of the above plus tamper, replay, QR-swap and expiry blocking with distinct failure codes.
- **Demonstrate:** attack scripts live, and the audit row each one writes.
- **Evidence:** four terminal captures with four distinct codes; timeline showing the block reason.
- **Explain:** S3 owns the attack narrative; S1 answers "why can't this be bypassed?"
- **Not left unfinished:** Future Card adaptation must be **underway** and describable.

### Review 3 — 09:00–11:00

This is **after code freeze**. No building. Rehearsed demo only.

### Jury / attack-then-defend

- **Working:** everything, from a clean `git clone`.
- **Demonstrate:** 5-second happy path → tamper blocked → replay blocked → QR swap blocked → step-up from a second browser → Future Card adaptation → timeline.
- **Evidence:** screenshots as backup, **plus a recorded video of the full demo** in case of live failure.
- **Explain:** every member must be able to explain **any** part, not just their own — Rules §2.C makes inability to explain a misconduct finding. Budget 20 minutes at 08:00 for a cross-brief.
- **Not left unfinished:** README with AI disclosure. It is a submission requirement, not a nicety.

---

## 10. Attack-Then-Defend Plan

All attacks run **only against our own localhost instance**, per Rules §2.D. No external systems, no event network, no other teams. The `PRISM_DISABLE=<control>` flag exists solely to show the "before" state honestly, is refused when `NODE_ENV=production`, and is off in the submitted build.

| # | Attack | Setup | Vulnerable behaviour (control off) | Defence | Blocked behaviour | Show the judges |
|---|---|---|---|---|---|---|
| 1 | **Amount tampering** | Lock ₹5,000, capture the assertion, resubmit with `amountMinor: 5000000` | Payment settles at ₹50,000 — the blank-cheque failure | Hash recomputed from DB; assertion signs the hash | `403 TAMPER_BLOCKED` | Both hashes side by side; one byte differs |
| 2 | **Recipient swap** | Same assertion, `payeeAccountId` changed to the attacker | Money reaches the attacker | Payee is inside the hash | `403 TAMPER_BLOCKED` | Payee never leaves the server record |
| 3 | **QR manipulation** | (a) plain unsigned QR; (b) valid QR for the attacker's own tx | (a) accepted; (b) UI shows the QR's claimed amount | (a) Ed25519 verify; (b) details fetched from server | (a) `403 QR_INVALID_SIGNATURE` (b) real payee shown → user cancels | The sticker attack dying on signature |
| 4 | **Replay** | Capture a settled authorize; resend ×10 | Account drained | Nonce `CONSUMED` → expiry → `ledger_entries` UNIQUE | `409 REPLAY_BLOCKED` | All 10 rejected; **three independent layers** |
| 5 | **Expired intent** | Lock, wait 95s, authorize | Stale approval honoured | 90s expiry | `410 INTENT_EXPIRED` | Countdown hitting zero |
| 6 | **Suspicious context** | Incognito profile, unregistered device, new payee, ₹48,000 | Settles silently — possession = proof | Context drift + risk engine | `202 STEP_UP_REQUIRED` or `403 RISK_BLOCKED` | **The listed reasons** — explainability as a security property |
| 7 | **Semantic failure** | Under step-up, answer wrong 3× | Reflexive approval succeeds | Last-two-digits, single-use, 3 attempts, rate-limited | `403 STEP_UP_FAILED` | Attempts exhausted, tx voided |

**Close on the invariant:** after all seven, query `ledger_entries` and `accounts` — no money moved on any blocked path, and every attempt has an audit row. That single query is the strongest 30 seconds of the demo.

**State the limits honestly** (the explainer already does, and judges reward it): a fully compromised device could display one transaction while signing another (WYSIWYS — unsolvable in software on general-purpose hardware); signature counters are unreliable on many platform authenticators; semantic verification is friction, not a cure; risk thresholds need production data to tune.

---

## 11. Future Card Strategy

Contents unknown; **do not guess**. Adaptability is structural, and most of it is already in the plan above.

**Loose coupling that matters:** the risk engine reads a `signals` object it does not construct; the context module emits signals it does not interpret; the authorize pipeline is an ordered list of checks; the UI renders whatever `failureCode` and `reasons[]` the server returns. So a new threat usually touches one file.

**Centralised configuration** — `backend/src/config/policy.ts`, the only place holding: intent TTL, QR TTL, risk thresholds and weights, step-up attempt limits, rate limits, enabled controls, semantic challenge type. A card that says "tighten the window" is a one-line change.

**Adding a new risk rule** — one pure function, one array entry:

```ts
// config/policy.ts
export const riskRules = [ ...existing,
  (s) => s.newSignal > 3 ? { points: 30, reason: 'NEW_SIGNAL_EXCEEDED' } : null,
];
```
No engine change, no schema change, and the reason string flows to the UI automatically.

**Adding a new security check** — one function pushed into the authorize chain, returning a `failureCode` or `null`. New codes need no migration: `audit_logs.event_type` is free-form text and `event_data` is `JSONB`.

**Adding a new UI state** — one entry in the failure-code map S2 owns. Unknown codes already fall back to a generic blocked screen, so the UI degrades safely rather than crashing on something it has never seen.

**Avoiding a rewrite:** never inline a threshold; never let the UI decide policy; never read `userId` from a body; keep migrations append-only. If a card demands a genuinely new module, it plugs into the pipeline the same way the seven existing ones do.

**Execution:** S4 leads (no critical-path dependency at hour 12), S1 supports on backend, S2 on UI, S3 re-runs all attacks after. **Timebox 4 hours**; if it will not fit, implement the smallest honest version and document the rest as designed-not-built — the same boundary discipline used everywhere else in this plan.

---

## 12. Final Submission Checklist

**Working MVP** — clean clone runs in ≤5 commands · register passkey · pick payee · enter amount · review server-authoritative screen · approve · `SETTLED` · balances change · receipt.

**Security layer** — hash *is* the challenge · 90s expiry · nonce single-use · Ed25519 QR reference-only · context drift · risk engine with stated reasons · semantic step-up (3 attempts) · atomic exactly-once ledger · append-only audit · session cookie (no body-supplied `userId`).

**Future Card** — implemented, committed with timestamps inside the window, documented in `docs/future-card.md`, re-tested against all attacks.

**Attack-then-defend** — 7 scripts in `attacks/`, each printing request → response → audit row · all target localhost only · recorded video backup.

**README** — approach · architecture · run instructions · **AI assistance disclosure (mandatory, Rules §2.F)** · open-source credits · honest limitations · what is built vs designed.

**Architecture diagram** — module diagram + end-to-end flow, in `docs/`, matching what actually shipped, not the deck's superset.

**Screenshots** — happy path, review screen with countdown, each failure state, timeline, four blocked attacks.

**Repository** — public, `main` runnable, history intact, no `.env`, no secrets.

**Presentation** — 5-min narrative: problem → thesis → happy path → four attacks → Future Card → limitations. All four members able to explain any part.

---

## 13. First Implementation Milestone

**M0 — Unblock (target: 60 minutes).** Nothing else can start.

**Start order:**

1. **S4 first, immediately, alone:** start Docker Desktop, `docker compose up postgres redis -d`, verify both healthy. **Everything is blocked behind this.**
2. **S1 second (critical path):** `npm install`; fix `keyManager.ts`; write `config/policy.ts` and `utils/canonical.ts` with its self-check; rewrite migration `001`; implement `migrate.ts`; write `seed.ts`.
3. **S2 in parallel:** delete the Next.js app, scaffold Vite + React + React Router, port `api-client.ts`, implement `webauthn-client.ts`.
4. **S3 in parallel:** `scripts/smoke.mjs` asserting the full happy path against the agreed contract — it will fail until M1, and that failing output is the definition of done for M1.
5. **All four at hour 2:** agree and merge `docs/api-contract.md` before S2 and S3 write anything that binds to it.

**Files created or rewritten in M0:**

| File | Action |
|---|---|
| `backend/src/db/migrations/001_initial_schema.sql` | Rewrite — 6 tables, `amount_minor BIGINT`, `accounts`, unique ledger constraint |
| `backend/src/db/migrate.ts` | Implement (~10 lines) |
| `backend/src/db/seed.ts` | New — users, accounts, balances, ~20 synthetic transactions |
| `backend/src/db/types.ts` | Update to match schema |
| `backend/src/config/policy.ts` | New — every tunable |
| `backend/src/utils/canonical.ts` | New — canonical JSON + hash + self-check |
| `backend/src/modules/keys/keyManager.ts` | Fix jose import; Ed25519 + HMAC |
| `backend/src/api/middleware/session.ts` | New — cookie JWT |
| `backend/src/index.ts` | Add `cookie-parser`, `/health`, fix startup await |
| `frontend/**` | Replace Next.js with Vite + React |
| `scripts/smoke.mjs` | New — end-to-end assertion |
| `docs/api-contract.md` | New — frozen at hour 2 |

**Parallel-safe:** S1 backend · S2 frontend · S3 scripts · S4 infra+docs touch four disjoint trees. Only `docs/api-contract.md` needs all four, and it is written once.

**Verification for M0:** `docker ps` shows both containers · `npm run db:migrate` creates 6 tables · `npm run db:seed` gives Asha a positive balance · `npx tsc --noEmit` clean in both workspaces · `curl localhost:4000/health` returns 200 · `node --test` passes the canonical-hash vector · frontend dev server serves a routed page.

**Verification for M1 (the real gate):** `npm run smoke` exits 0, having registered a passkey, locked an intent, verified an assertion whose challenge equals the intent hash, settled atomically, and asserted that a second identical authorize returns `409 REPLAY_BLOCKED`.

**Awaiting confirmation before starting** — per your execution rules, these are the plan's material architectural changes and I will not begin until you approve: rewriting migration `001` and adding `accounts`; deleting the Next.js frontend; introducing session cookies so `userId` is never body-supplied.

---

## 14. Risks, Assumptions, and Open Questions

### ⚠ Schedule conflicts — must be verified with organizers

**The three source documents give three different Future Card times. Do not assume any one is correct.**

| Source | Stated time |
|---|---|
| Official rules PDF §3 | **22:00** — "10:00 PM FUTURE CARD SELECTION" |
| `PRISM_Updated.pdf` plan of action | **~21:00** — "12–12.5 hr CARD** feature selection" (12h after a 09:00 start) |
| Your team schedule note | **00:00** — "12 AM — Future Card" |

**Verify the Future Card time with the organizers as a priority.** A three-hour spread changes when the core must be frozen. Until confirmed, this plan targets **Future-Card-ready at 20:30** — safe under all three readings.

Three further mismatches to confirm:

1. **"Post-lunch faculty review"** does not appear in the official schedule; the official document has lunch 13:00–13:45 and a *mentor checkpoint at 18:00–18:30*. Confirm whether these are the same event.
2. **"Night student coordinators review 2"** vs the official **06:00–06:30 progress review 2**. Confirm whether an additional night review exists.
3. **"9–11 AM Review 3"** aligns with the official **judging** slot (09:00–11:00), which is **after the 09:00 code freeze**. Treat it as the jury demo, not a build checkpoint. If your team expects to still be building at 09:00, that assumption is wrong and expensive — confirm.

**Not in conflict:** dates (07–08 Sep 2026) agree across all documents and match today.

### Compliance risks

- **Originality (Rules §2.C):** all code must be created in-window. The scaffold commit is 07 Sep 10:03, after the 09:00 start — defensible. **Preserve git history verbatim**; never squash or rewrite timestamps. If any part of the scaffold predates 09:00 on a different machine, disclose it.
- **AI disclosure (Rules §2.F):** three of four members are AI coding agents. This is a substantial disclosure and it is mandatory. Write it plainly in the README; concealment risks disqualification, and disclosure costs nothing.
- **Explainability (Rules §2.C):** *"Inability to explain the submission may be treated as misconduct."* With three AI agents writing code, this is the sharpest risk in the whole event. The 08:00 cross-brief is non-negotiable.

### Technical risks

| Risk | Impact | Mitigation |
|---|---|---|
| **WebAuthn challenge encoding** | Hours lost, false `TAMPER_BLOCKED` | One representation (base64url), server-only computation, self-check with a known vector at hour 2 |
| **Docker won't start** | Total block | Fix first, before any code. Redis shim as fallback; Postgres has none — escalate immediately if it fails |
| WebAuthn secure-context requirement | Credentials invalidated by a hostname change | Use `localhost` throughout; if a tunnel is needed, establish it **before** any registration |
| Second-browser drift too weak on stage | Step-up demo fails | Context weighted to device/credential/session signals, not IP (§3.5) |
| Incognito passkeys unavailable | Cannot register in the demo profile | Use a **second Chrome profile**, not incognito, if virtual authenticator support is inconsistent |
| S1 is a serial bottleneck | Slip cascades everywhere | S1 owns nothing else; hour-10 abort rule enforced |
| Vite rewrite overruns | S2 late to the composer | Timebox to 60 min; the existing page components port near 1:1 once `'use client'` and `next/navigation` are removed |

### Assumptions (stated because they are not in the documents)

1. **Closed-loop ledger** — PRISM holds internal accounts; no external payment rail. Needed because the settlement TODO references accounts that do not exist, and no document specifies a gateway.
2. **Single-device demo** — one laptop, `localhost`, two browser profiles. Needed because WebAuthn requires a secure context and cross-device adds tunnel risk for zero judging benefit.
3. **Session model** — passkey login issues an httpOnly JWT cookie. Needed because the scaffold trusts a client-supplied `userId`, which is a trivial impersonation hole a judge would find immediately.
4. **Two seeded users (Asha, Priya)** — matches the worked example in the explainer, so the demo narrative and the documents agree.
5. **`PRISM_DISABLE` is dev-only** — refused under `NODE_ENV=production`, off in the submitted build. Needed to show the "vulnerable" half of attack-then-defend without shipping a weakened system.

### Open questions for the team

1. Confirmed Future Card time — **22:00, 21:00, or 00:00?**
2. Is the post-lunch faculty review the same as the official 18:00 mentor checkpoint?
3. Is there a night coordinators review in addition to the official 06:00 one?
4. Does anyone expect to be building after the 09:00 code freeze? (If yes, that expectation is wrong.)
5. Is a physical mobile device available for a QR scan demo, or is the link-based path our only route?
