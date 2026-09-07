# PRISM — Payment Risk & Intent Security Model

> **IntentLock Monolithic Application** — A 4-layer payment authentication system that cryptographically binds a user's approval to one exact transaction: **Person × Device × Transaction × Context**.

---

## Run it

Prerequisites: Node ≥ 20, Docker Desktop running.

```bash
cp .env.example .env
# set JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

docker compose up -d                       # postgres + redis only

cd backend && npm install
npm run db:migrate && npm run db:seed
npm test                                   # pins the intent-hash contract
npm run dev                                # :4000

cd ../frontend && npm install && npm run dev   # :5173
```

Open <http://localhost:5173>, register a passkey as Asha, and pay.
Health check: `curl localhost:4000/health`.

> **Do not change the hostname or port after registering a passkey.** The
> WebAuthn RP ID is bound to `localhost`, and every credential dies with it.

## Current state (M0 complete)

| Area | State |
|---|---|
| Postgres schema, migrations, seed | ✅ working |
| Intent-hash contract + self-check | ✅ working, pinned by `npm test` |
| Passkey register / login / session cookie | ✅ working |
| Intent lock, nonce lifecycle, audit log | ✅ working |
| Context, risk engine, semantic step-up, Ed25519 QR, ledger | ✅ implemented, needs end-to-end testing |
| Frontend | ⚠️ Vite + React scaffold; sign-in works, payment screens are owned stubs |
| Attack scripts | ⛔ not started (S3) |

**Read [`PLAN.md`](PLAN.md) before starting.** It carries the task breakdown,
file ownership, the git workflow, and the review checkpoints.
API contract: [`docs/api-contract.md`](docs/api-contract.md) — frozen; ask S1
before changing a route.

Two rules that cause the most expensive bugs if broken:

1. **Money is integer minor units (paise).** ₹5,000 is `500000`.
2. **No endpoint takes a `userId`.** The payer comes from the session cookie.

⚠️ Sections below this line still describe the original scaffold (Next.js,
USD, the old folder layout) and are being rewritten — trust the table above.

---

## What PRISM Prevents

| Threat | PRISM Defence |
|---|---|
| QR hijacking / swap | QR contains only a signed reference; payment details live in DB |
| Replay attacks | Single-use nonce stored in Redis, consumed on authorization |
| Transaction tampering | SHA-256 intent hash becomes the WebAuthn challenge — any change breaks the signature |
| Unauthorized device | Device-bound passkey (WebAuthn) cannot be exported |
| Ambient context drift | Context micro-fingerprint compared per request, anomalies escalate risk |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    IntentLock Monolithic Application                │
│                                                                     │
│  ┌──────────────┐                                                   │
│  │  API Gateway │  Express + rate-limit-redis                       │
│  └──────┬───────┘                                                   │
│         │                                                           │
│  ┌──────▼───────┐   ┌────────────────┐   ┌──────────────────────┐  │
│  │   Identity   │   │  Intent-Lock   │   │    Dynamic QR        │  │
│  │  (WebAuthn)  │   │(nonce+hash+exp)│   │ (signed reference)   │  │
│  └──────────────┘   └────────────────┘   └──────────────────────┘  │
│                                                                     │
│  ┌──────────────┐   ┌────────────────┐   ┌──────────────────────┐  │
│  │   Context    │   │  Risk Engine   │   │ Semantic Verification │  │
│  │(fingerprint) │──▶│(score→route)  │──▶│  (step-up check)     │  │
│  └──────────────┘   └────────────────┘   └──────────────────────┘  │
│                                                                     │
│  ┌──────────────┐   ┌────────────────┐   ┌──────────────────────┐  │
│  │    Ledger    │   │  Audit + Alerts│   │   Key Management     │  │
│  │ (ACID settle)│   │  (event log)   │   │  (isolated secrets)  │  │
│  └──────────────┘   └────────────────┘   └──────────────────────┘  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
              ┌─────────────────┴──────────────────┐
              │  PostgreSQL (local)    Redis         │
              │  - users               - sessions    │
              │  - credentials         - nonces      │
              │  - transactions        - rate limits  │
              │  - ledger_entries      - challenges   │
              │  - audit_logs          - context BL   │
              └────────────────────────────────────── ┘
```

---

## End-to-End PRISM Flow

```
1. TRANSACTION SETUP
   Client → POST /payment/initiate
   IntentLock: generate nonce, compute SHA-256(userId|recipientId|amount|currency|nonce|expiry)
   → intentHash stored in DB, nonce stored in Redis

2. HASH BECOMES CHALLENGE
   Client → POST /auth/login/options
   Identity: generate WebAuthn options with intentHash as the challenge
   → User's device passkey signs intentHash (not a random number)

3. WEBAUTHN VERIFY
   Client → POST /payment/authorize (with WebAuthn assertion)
   Identity: verifyAuthenticationResponse — ensures signature is over intentHash
   IntentLock: reconstruct hash from DB, safeCompare → tamper proof
   IntentLock: check nonce in Redis → replay proof

4. RISK EVALUATION
   Context: compare device fingerprint vs baseline → driftScore
   RiskEngine: combine velocity + amount + drift → risk score
   → APPROVE (score < 0.4) | STEP_UP (< 0.75) | BLOCK (≥ 0.75)

5. STEP-UP (if required)
   Semantic: generate challenge text from locked DB record
   Client confirms → POST /verify/step-up
   Semantic: verify confirmation → transition to APPROVED

6. PAYMENT AUTHORIZATION
   Ledger: BEGIN TX → SELECT FOR UPDATE → validate status
   → debit/credit → INSERT ledger_entry → UPDATE status='SETTLED' → COMMIT
   Audit: log SETTLEMENT_SUCCESS

7. AUDIT
   Every decision (approve/block/step-up) writes to audit_logs (immutable)
```

---

## Folder Structure

```
prism-monorepo/
├── docker-compose.yml
├── .env.example
├── README.md
├── docs/
│   └── architecture.md
├── scripts/
│   └── setup.sh
│
├── backend/                          # IntentLock Monolithic Application
│   ├── package.json
│   ├── tsconfig.json
│   ├── eslint.config.mjs
│   ├── .prettierrc
│   └── src/
│       ├── index.ts                  # App entry point, Express setup, graceful shutdown
│       ├── config/
│       │   └── env.ts                # Env var validation at startup
│       ├── db/
│       │   ├── pool.ts               # Shared pg Pool (import this everywhere)
│       │   ├── types.ts              # TypeScript interfaces for all DB rows
│       │   ├── migrate.ts            # Migration runner (npm run db:migrate)
│       │   └── migrations/
│       │       └── 001_initial_schema.sql
│       ├── api/
│       │   ├── routes.ts             # All Express routes (API Gateway layer)
│       │   └── middleware/
│       │       ├── rateLimiter.ts    # Redis-backed rate limiting
│       │       └── errorHandler.ts   # Global error handler
│       ├── modules/
│       │   ├── identity/
│       │   │   └── webauthn.ts       # WebAuthn registration & authentication
│       │   ├── intent/
│       │   │   └── intentLock.ts     # Nonce + hash + expiry generation
│       │   ├── qr/
│       │   │   └── dynamicQr.ts      # Signed single-use QR codes
│       │   ├── context/
│       │   │   └── fingerprint.ts    # Device/network fingerprint & drift
│       │   ├── risk/
│       │   │   └── riskEngine.ts     # Risk scoring → APPROVE/STEP_UP/BLOCK
│       │   ├── semantic/
│       │   │   └── intentCheck.ts    # Step-up confirmation logic
│       │   ├── ledger/
│       │   │   └── settlement.ts     # ACID settlement (SELECT FOR UPDATE)
│       │   ├── audit/
│       │   │   └── logger.ts         # Immutable event logging
│       │   └── keys/
│       │       └── keyManager.ts     # Isolated key access (jose JWT signing)
│       └── utils/
│           ├── redis.ts              # Redis singleton
│           └── crypto.ts             # SHA-256, nonce, timing-safe compare
│
└── frontend/                         # Next.js App Router
    ├── package.json
    ├── tsconfig.json
    ├── next.config.mjs
    └── src/
        ├── app/
        │   ├── layout.tsx
        │   ├── page.tsx              # Landing / login
        │   ├── pay/page.tsx          # Payment initiation
        │   ├── qr/page.tsx           # QR display/scan
        │   ├── verify/page.tsx       # Step-up verification
        │   └── status/page.tsx       # Transaction result
        ├── components/
        │   ├── QRDisplay.tsx         # Renders signed QR payload
        │   ├── WebAuthnPrompt.tsx    # Triggers native passkey UI
        │   └── StepUpChallenge.tsx   # Step-up text confirmation
        └── lib/
            ├── api-client.ts         # Typed fetch wrapper for all backend routes
            └── webauthn-client.ts    # @simplewebauthn/browser wrapper
```

---

## Prerequisites

- **Node.js** ≥ 20
- **Docker + Docker Compose** (for PostgreSQL + Redis)
- **npm** ≥ 10

---

## Quick Start

### 1. Clone & configure environment

```bash
git clone <repo>
cd prism-monorepo
cp .env.example .env
# Edit .env — set JWT_SECRET and QR_SIGNING_KEY to random strings
```

### 2. Start data stores

```bash
docker-compose up postgres redis -d
```

### 3. Set up the backend

```bash
cd backend
npm install
npm run db:migrate       # Runs 001_initial_schema.sql against local postgres
npm run dev              # Starts Express on :4000 with nodemon
```

### 4. Start the frontend

```bash
cd ../frontend
npm install
npm run dev              # Starts Next.js on :3000
```

### 5. (Optional) Full stack with Docker

```bash
# From root
docker-compose up --build
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:4000/api/v1

---

## Database

No ORM. PRISM uses **raw PostgreSQL** via the `pg` pool for explicit control over:
- `SELECT FOR UPDATE` locking in settlement
- Atomic multi-statement transactions
- Full visibility over query plans

Schema is defined in [`backend/src/db/migrations/001_initial_schema.sql`](backend/src/db/migrations/001_initial_schema.sql).

Run migrations manually:

```bash
cd backend && npm run db:migrate
```

---

## Key Design Rules

1. **No module reads raw keys** except `KeyManagementModule` — all signing goes through `keyManager.signPayload()`.
2. **Nonces are single-use** — stored in Redis on creation, consumed (deleted) on successful authorization.
3. **intentHash = WebAuthn challenge** — the user's passkey physically signs the transaction fingerprint.
4. **Audit never blocks** — `AuditModule.log()` swallows errors so payment flow is never interrupted.
5. **Settlement uses `SELECT FOR UPDATE`** — prevents double-spend on concurrent requests.

---

## Environment Variables Reference

| Variable | Where used | Description |
|---|---|---|
| `DATABASE_URL` | `db/pool.ts` | PostgreSQL connection string |
| `REDIS_URL` | `utils/redis.ts` | Redis connection string |
| `WEBAUTHN_RP_ID` | `modules/identity` | Relying Party domain (e.g. `localhost`) |
| `WEBAUTHN_RP_NAME` | `modules/identity` | Human-readable RP name |
| `WEBAUTHN_EXPECTED_ORIGIN` | `modules/identity` | Allowed origin (e.g. `http://localhost:3000`) |
| `JWT_SECRET` | `modules/keys` only | HMAC secret for JWT signing |
| `QR_SIGNING_KEY` | `modules/keys` only | HMAC secret for QR payload signing |
| `NEXT_PUBLIC_API_URL` | Frontend | Backend API base URL |