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

Open <http://localhost:5173>. Health check: `curl localhost:4000/health`.

> **Do not change the hostname or port after registering a passkey.** The
> WebAuthn RP ID is bound to `localhost:5173`, and every credential dies with
> it. Settle this before anyone registers.

---

## Create a passkey (do this first)

PRISM has no passwords. Before you can pay, this device needs a passkey — a
keypair whose private half stays in the device's secure hardware. PRISM only
ever stores the public key and only ever sees a signature.

**Register before you sign in.** A fresh browser profile has no passkey, so
"Sign in" will fail with `AUTH_FAILED: no passkey registered` until you have
registered once.

### Option A — Windows Hello / Touch ID (what a judge sees)

1. Open <http://localhost:5173> in Chrome or Edge
2. Leave the account dropdown on **Asha Menon**
3. Click **Register a passkey on this device**
4. In the OS dialog choose **This device**
5. Confirm with your **PIN, fingerprint, or face**

Then click **Sign in**.

> Requires Windows Hello to be set up. PRISM sends
> `userVerification: 'required'`, so an account with no PIN cannot register.
> Set one under **Settings → Accounts → Sign-in options → PIN**.

### Option B — Chrome virtual authenticator (use this while building)

No hardware, no OS prompt, and you can create as many distinct "devices" as
you need — which is how the step-up demo gets a second device on one laptop.

1. **F12** → DevTools **⋮** → **More tools** → **WebAuthn**
2. Tick **Enable virtual authenticator environment**
3. **Add** an authenticator: protocol **ctap2**, transport **internal**,
   **resident keys** ✅, **user verification** ✅
4. Register in the app — it completes instantly

Registering from a second Chrome profile (or after replacing the virtual
authenticator) makes the `NEW_DEVICE` and `NO_BASELINE` risk rules fire
deterministically, which is what drives the step-up demo.

### Option C — phone as passkey

In the OS dialog pick **Use another device**, scan the QR with your phone,
approve with fingerprint or face. Visually strong for judging, but it needs
Bluetooth and adds a live failure point — treat it as a bonus, not the
primary path.

### If registration fails

| Message | Cause |
|---|---|
| `InvalidStateError` — already registered | This device already has a passkey for that account. Just **Sign in**. |
| `NotAllowedError` | Cancelled, or the prompt timed out. |
| `SecurityError` | Not a secure context. Must be `http://localhost:5173` — not `127.0.0.1`, not a LAN IP. |
| `AUTH_FAILED: no passkey registered` | You clicked Sign in before Register. |

Confirm a credential landed:

```bash
docker exec prism-postgres-1 psql -U prism_user -d prism_db \
  -c "SELECT id, device_type, backed_up, created_at FROM credentials;"
```

Start over — clears passkeys only, leaving accounts and payment history:

```bash
docker exec prism-postgres-1 psql -U prism_user -d prism_db \
  -c "DELETE FROM credentials;"
```

---

## Access it from another device

The app runs on `localhost` by default. Getting it onto a second laptop or a
phone takes one extra step, and there is exactly one reason it is not simply
"use the LAN IP":

**WebAuthn will not work over `http://192.168.x.x:5173`.** A passkey needs a
secure context (HTTPS or `localhost`), *and* the WebAuthn spec requires the
RP ID to be a domain name — an IP address is rejected outright. No browser
flag gets around the second one. So a LAN IP gets you a page your friends can
look at, and a sign-in button that cannot work.

The fix is one HTTPS tunnel, with Vite proxying the API so the whole app stays
on a single origin. Same origin means no CORS change and the `sameSite=lax`
session cookie keeps working.

### One-time setup

```powershell
winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements
```

`vite.config.ts` is already configured for this: `host: true`, an `allowedHosts`
list for tunnel domains, and `/api` + `/health` proxied to port 4000. Vite 5.4.12+
rejects unrecognised `Host` headers with a bare *"Blocked request. This host is
not allowed."*, which is why the allow-list has to exist.

### Each time

```powershell
# terminal 1 — dev server bound to all interfaces
cd s:\prismrontend
npm run dev -- --host

# terminal 2 — the tunnel (note the leading & : PowerShell needs it to run a quoted path)
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:5173
```

cloudflared prints a URL like `https://random-words-here.trycloudflare.com`.
Put that hostname into `.env`:

```ini
WEBAUTHN_RP_ID=random-words-here.trycloudflare.com
WEBAUTHN_EXPECTED_ORIGIN=https://random-words-here.trycloudflare.com
VITE_API_URL=
```

`WEBAUTHN_RP_ID` is the **host only** — no scheme, no port. `VITE_API_URL` stays
empty so the frontend uses relative URLs through the proxy; a value here would
send visitors' browsers to *their own* machine.

Then **restart the backend**, because config is read once at boot.

### The part that catches people out

**Changing `WEBAUTHN_RP_ID` invalidates every passkey already registered.** A
passkey is bound to its RP ID, so switching between `localhost` and a tunnel
host in either direction means everyone re-registers. It takes about five
seconds per person (the "Register a passkey on this device" button), but it is
a surprise if you hit it mid-rehearsal. A free quick-tunnel hostname changes on
every restart, so this recurs each time.

Keep a `localhost` copy of the config so you can switch back in one command:

```powershell
Copy-Item s:\prism\.env s:\prism\.env.localhost.bak   # once, while on localhost
Copy-Item s:\prism\.env.localhost.bak s:\prism\.env -Force  # to restore
```

### Known limitation

A cloudflared **quick tunnel is not reliable enough to bet a demo on.** Measured
here: it survived roughly 40 minutes before dying with repeated
`failed to dial to edge with quic: timeout` errors, after which the public URL
returned HTTP 530. If remote access has to work at a fixed time, either watch
the tunnel and be ready to redo the four steps above, or run the demo on one
machine and skip the tunnel entirely.

### Stopping it

```powershell
Stop-Process -Name cloudflared -Force
Copy-Item s:\prism\.env.localhost.bak s:\prism\.env -Force
```

Restart the backend afterwards. The `--host` flag and the Vite proxy are
harmless on localhost, so there is nothing else to revert.

---

## Mobile — two Expo apps

PRISM ships two phone apps, and they are not the same product.

| | `auth_expo_app/` | `prism_expo_app/` |
|---|---|---|
| **What it is** | **PRISM Authenticator** — a second factor | **PRISM App** — the portal itself |
| **Who it is for** | Someone paying on a laptop | Someone paying on a phone |
| **What it does** | Shows a 6-digit code that approves one payment | Balance, statement, send, receive, scan, timeline |
| **Backend** | The web backend, `:4000` | Its own server, `:4100`, same database |

Both are Expo Go apps: no development build, no EAS, no native modules beyond
what Expo Go already bundles.

### The constraint both apps are shaped by

**React Native has no `navigator.credentials`.** A native passkey needs an EAS
development build *plus* `assetlinks.json` / AASA served from a real HTTPS
domain, neither of which exists on `prism.local`. So a phone cannot hold a
PRISM passkey, and everything below follows from that one fact.

The answer in both apps is the same primitive:

```
code = HMAC-SHA256(device_secret, binding)
     → dynamic truncation (RFC 4226 §5.3) → % 1_000_000 → 6 digits
```

`binding` is whatever is being authorized — an intent hash for a payment, a
login challenge for a sign-in. **There is no time counter.** TOTP needs one
because a login has no other freshness source; PRISM's flows have the intent
nonce and its TTL. Dropping it removes clock skew as a failure mode and makes
the code deterministic per transaction, which is why **the phone works with no
network at all**.

The same fixture is asserted on both sides — `backend/src/modules/authenticator/otp.test.ts`
(node:crypto) and each app's `lib/otp.test.ts` (@noble/hashes) — so the two
implementations cannot silently diverge:

```
approval 944316 · denial 047685
```

---

### 1. PRISM Authenticator (`auth_expo_app/`)

Turns a refusal into an escalation. A payment the risk engine scores too high
used to dead-end with `403`; with a paired phone it becomes *"approve this on
your other device"*.

**Workflow**

1. **Pair.** Portal → **Settings → Authenticator → Pair a phone**. The server
   mints a secret and draws it as a QR (`prism://pair?d=…&s=…`). The phone
   photographs it and **never sends it back** — on a plain-HTTP LAN a secret
   POSTed from the phone would be readable on the wire. Same shape as an
   `otpauth://` enrolment URI. Confirm on the laptop, because
   `/authenticator/pair/confirm` needs a session and the phone has none.
2. **Pay** something the engine flags, or **₹50,000 or more**, which always
   requires the phone (`HIGH_VALUE_AUTHENTICATOR`).
3. The Verify screen shows a **signed** challenge as a QR with a **60-second**
   countdown. Signed matters: the app renders the payee and amount *from the
   token*, so an unsigned one would let anyone who can draw a QR choose what
   the second device displays — precisely the fraud it exists to catch.
4. **Scan it.** The app verifies the Ed25519 signature against
   `/.well-known/prism-keys`, then shows the amount, the recipient and the
   6 digits. Works in airplane mode.
5. **Type the code.** The payment settles. The 60-second window is enforced
   server-side against a Redis record, not by the phone's clock.

**"This isn't me."** The app can also derive `HMAC(secret, hash + ":deny")` —
six digits indistinguishable from an approval. A victim being coached through
a transfer can read it out and quarantine the payment, and nobody watching can
tell. ⛔ **The server route for this is not wired yet**; the button computes a
real code that nothing currently accepts.

---

### 2. PRISM App (`prism_expo_app/`)

The whole portal on a phone: sign in, balance, Cr/Dr statement, send, review,
approve, step-up, receive by QR, scan, security timeline.

**Architecture.** `prism_expo_app/backend/` is a second Express server on
`:4100` sharing the web stack's Postgres and Redis. It **re-implements nothing
that decides whether money moves** — intent lock, context, risk, policy
firewall, attestation chain and settlement are imported from `backend/` and run
unchanged. Sharing the database is the point: a payment made on the phone lands
in the same ledger the website reads.

**Workflow**

1. **Pair from the web portal** (as above). Pairing is the bootstrap: the app
   has no password and no passkey, so the secret is the only thing that
   proves which account this phone belongs to.
2. **Sign in.** The server issues a random challenge; the phone answers with
   `HMAC(secret, challenge)`. The session comes back as a Bearer token, because
   React Native's `fetch` keeps no cookie jar. Same signed token the browser
   gets in its cookie.
3. **Send.** Pick a recipient, enter an amount, and the intent locks.
4. **Review.** Every value is read back from `GET /payment/:id` — never from
   navigation state. A payee carried in a route param is a payee an attacker
   can set.
5. **Approve.** Face ID / fingerprint first, then the app derives
   `HMAC(secret, intent_hash)` and sends it. The payment settles.

**Biometrics** gate three things: approving a payment, opening the app (it
locks whenever backgrounded, because the stored secret can authorize
payments), and the destructive actions in Settings.

#### ⚠ The mobile path is weaker than the web path, and says so

| | Passkey (`WEBAUTHN_APPROVED`) | Device code (`DEVICE_APPROVED`) |
|---|---|---|
| Key material | Private key, never leaves the device | **Shared secret** — the server has a copy |
| Bound to the transaction | Yes, signature over the intent hash | Yes, HMAC over the intent hash |
| Tamper / replay resistance | Equal | Equal |
| Survives a server compromise | Yes | **No** — a stolen database could forge one |

Tampering and replay fail identically on both. **Key custody does not.** So the
attestation chain records `DEVICE_APPROVED`, never `WEBAUTHN_APPROVED`, and the
timeline reads *"Approved on a paired device, not a passkey"*. The audit trail
must never claim a stronger proof than the one that happened.

`expo-local-authentication` is a **local** check — WebAuthn carries user
verification inside the signature, this does not. The server records
`biometricClaimed: true` and the field is named *claimed* deliberately.

**A step-up on the phone falls back to the digits quiz**, never to another code
from the same device: asking the phone that just approved for a second HMAC
from the same secret proves nothing new.

---

### Running the mobile apps

```bash
# 1. The web stack must be up (Postgres, Redis, backend, portal)
cd backend && npm run dev            # :4000
cd frontend && npm run dev           # :5173

# 2. The PRISM App's own API
cd prism_expo_app/backend && npm run dev    # :4100

# 3. Either app's Metro bundler
cd prism_expo_app/frontend && npx expo start --lan
cd auth_expo_app && npx expo start --lan
```

On the phone, open **Expo Go** → *Enter URL manually* → `exp://<LAN-IP>:8081`.

**The address you give the app is the backend directly** — `http://<LAN-IP>:4100`
for the PRISM App, `http://<LAN-IP>:4000` for the Authenticator. **Not**
`https://prism.local:5173`: a phone cannot resolve `prism.local` and does not
trust the mkcert CA. React Native is not subject to CORS, and with no WebAuthn
there is no secure-context requirement.

> Restart Metro after installing any dependency. Its module map is built at
> startup, so a package added while it is running resolves as missing.

---

## Offline behavior

Two different things are meant by "offline" in PRISM, and only one of them is
actually designed to work with no connection:

### The web portal has no queued/"outbox" payments, by design

Settlement is server-authoritative and every intent, step-up window and
capability is short-lived on purpose (`policy.intentTtlSeconds`,
`policy.stepUp.authenticatorTtlSeconds` = 60s) — see [Risk scoring](#risk-scoring--the-points-rules)
and `authorizationPolicy.ts`. Queuing a payment while offline and firing it
later would mean authorizing it against risk/context signals that are already
stale by the time it actually sends, which defeats the reason those windows
are short. So the portal does **not** queue payments; it just needs to fail
*honestly* when the browser has no connection, instead of the confusing mix of
404s/500s/misattributed passkey errors that used to show up depending on
exactly which request was in flight when the connection dropped.

What changed (`frontend/src/lib/api-client.ts`, `useOnline.ts`, `session.tsx`,
`Pay.tsx`, `Review.tsx`, `Verify.tsx`, `App.tsx`):

- **`OfflineError`, distinct from `ApiError`.** `api-client.ts`'s `request()`
  checks `navigator.onLine` before every call and reclassifies a fetch-level
  `TypeError` (the browser's own "could not reach the server" failure) as
  `OfflineError` too. No failure code exists for it because the server was
  never reached — call sites that used to lump this in with "wrong passkey"
  or "signed out" now check for it first.
- **The root cause: `session.tsx` no longer signs you out on a network
  blip.** `refresh()` used to treat *any* failure of `GET /me` — connectivity
  loss included — as "not signed in" and clear the session, which made
  `RequireSession` bounce a payment mid-flow back to the sign-in screen the
  instant one poll found the network gone. It now only clears the session on
  a real failure (a genuine 401); an `OfflineError` leaves the last-known
  session in place and sets a separate `offline` flag instead.
- **A visible "You're offline" banner** (`App.tsx`) whenever
  `navigator.onLine` is false, everywhere except the pre-login landing page.
- **Submit buttons disable themselves while offline** on Pay, Review
  (Approve) and Verify (step-up confirm, "Generate a new code"), so nothing
  is even attempted against a connection that's already known to be down.
- **Nothing is ever left half-created.** The offline check runs before the
  request fires, so a payment either never leaves the browser or the server
  already has the authoritative record of it — there is no local "pending"
  state to reconcile. Review/Verify screens that failed to load while offline
  retry automatically the moment `online` flips back to `true`.
- A step-up code that expires because the 60-second window ran out while you
  were offline now says so plainly ("this is a freshness check, not a
  risk-score decision") instead of reading like an unexplained refusal.

### PRISM Authenticator (`auth_expo_app/`) genuinely works with zero network

This one *is* designed to run with the phone in airplane mode, and it was
verified line-by-line while fixing the portal above — no network code exists
anywhere in the scan → verify → generate-code path:

- `screens/Scan.tsx` only calls `verifyToken()` (local Ed25519 check against
  the public key fetched once at pairing) — no `fetch` in the file.
- `screens/Code.tsx` only calls `approvalCode()` / `denialCode()` from
  `lib/otp.ts` (pure HMAC-SHA256 over the locally-stored secret and the
  token's `intentHash`) — no `fetch` in the file either.
- `App.tsx` loads the pairing record and cached server key from
  `expo-secure-store` on launch (`lib/store.ts`), not from the network.
- The **only** network calls in the whole app are pairing
  (`/authenticator/pair/start` + `/confirm`, once, from the portal and the
  phone respectively) and re-fetching `/.well-known/prism-keys` if the cached
  key is missing. After that, scanning a code and generating the 6 digits
  needs no signal at all — this matches the design in
  `docs/superpowers/specs/2026-09-07-prism-authenticator-design.md` §3.

If a paired phone ever fails to produce a code offline, that is a regression
in `Scan.tsx`/`Code.tsx`/`lib/verify.ts`/`lib/otp.ts` specifically — it is not
supposed to need a signal at any point after pairing.

---

## Current state (M0 complete)

| Area | State |
|---|---|
| Postgres schema, migrations, seed | ✅ working |
| Intent-hash contract + self-check | ✅ working, pinned by `npm test` |
| Passkey register / login / session cookie | ✅ working |
| Intent lock, nonce lifecycle, audit log | ✅ working |
| Context, risk engine, semantic step-up, Ed25519 QR, ledger | ✅ implemented, needs end-to-end testing |
| Frontend | ✅ every screen built: home, send, review, step-up, status, timeline, receive, scan, settings, policy |
| PRISM Authenticator (`auth_expo_app/`) | ✅ pairing and payment step-up verified; ⛔ denial route not wired |
| PRISM App (`prism_expo_app/`) | ✅ device sign-in, statement, send, approve, receive, scan, timeline |
| Attack scripts | ⛔ not started (S3) |

**Read [`PLAN.md`](PLAN.md) before starting.** It carries the task breakdown,
file ownership, the git workflow, and the review checkpoints.
API contract: [`docs/api-contract.md`](docs/api-contract.md) — frozen; ask S1
before changing a route.

Two rules that cause the most expensive bugs if broken:

1. **Money is integer minor units (paise).** ₹5,000 is `500000`.
2. **No endpoint takes a `userId`.** The payer comes from the session cookie.

---

## Risk scoring — the points rules

The risk engine is rules-first and never a model: every decision can name the
exact conditions that fired, because an unexplainable block cannot be audited,
contested, or debugged. Each rule is independent and pure, so the score is just
a sum. Source of truth: `RULES` in
[`backend/src/modules/risk/riskEngine.ts`](backend/src/modules/risk/riskEngine.ts).

| Rule | Points | Fires when | Reason shown to the user |
|---|---:|---|---|
| `NEW_DEVICE` | 35 | A baseline exists for this user but the device fingerprint differs | This device has not been used for payments before |
| `NEW_PAYEE` | 30 | Payer has never paid this recipient | You have never paid this recipient before |
| `AMOUNT_ANOMALY` | 30 | Amount is 3–50× the payer's largest settled payment | Amount is far larger than your usual payments |
| `AMOUNT_EXTREME` | 55 | Amount is over 50× that largest payment | Amount is vastly larger than anything you have sent before |
| `NO_BASELINE` | 25 | No context baseline recorded for this user yet | No established pattern for this session yet |
| `HASTY_APPROVAL` | 15 | Approved < 1500 ms after the details appeared (measured server-side from the `CHALLENGE_ISSUED` audit row) | Payment approved unusually quickly after the details appeared |
| `NETWORK_CHANGED` | 10 | Request arrives from a different network than the baseline | Connecting from a different network than usual |

Score is the sum of fired rules, capped at 100, then routed:

| Score | Decision |
|---|---|
| 0 – 39 | **APPROVE** — settle |
| 40 – 84 | **STEP_UP** — semantic verification required |
| 85 – 100 | **BLOCK** — terminal, no retry path |

Thresholds live in `policy.risk` in
[`backend/src/config/policy.ts`](backend/src/config/policy.ts); the amount
multiples and the 1500 ms hasty window live there too. Multiples are relative
to the payer's largest *settled* payment, so they mean nothing until there is
history — which is why the seed provides some.

Two pairs are mutually exclusive by construction, so nothing is ever scored
twice for the same fact: `NO_BASELINE` and `NEW_DEVICE` (you cannot differ from
a baseline that does not exist), and `AMOUNT_ANOMALY` and `AMOUNT_EXTREME`
(bands, not thresholds). The context module also computes an `impossibleTravel`
signal, but PRISM deliberately ships no geolocation source, so it has no rule
and never fires.

**Why the block threshold is 85 and not 75.** A genuine user, on their own
device, being talked into paying a stranger scores 75
(`NEW_PAYEE` + `AMOUNT_ANOMALY` + `HASTY_APPROVAL`). Blocking at 75 sounds
safer but is wrong twice: it skips semantic verification — the only control
that addresses a manipulated genuine user — and it refuses a possibly
legitimate payment without ever asking the person. At 85 that case lands in
the step-up band, while a stolen device (which also trips `NEW_DEVICE`, 110 →
capped 100) still blocks outright.

Worked examples:

| Situation | Rules fired | Score | Outcome |
|---|---|---:|---|
| Known device, known payee, normal amount | — | 0 | APPROVE |
| Known device, first payment to a new payee | `NEW_PAYEE` | 30 | APPROVE |
| Social engineering: new payee, 5× usual, approved instantly | `NEW_PAYEE` + `AMOUNT_ANOMALY` + `HASTY_APPROVAL` | 75 | STEP_UP |
| Stolen device paying a stranger a large sum | `NEW_DEVICE` + `NEW_PAYEE` + `AMOUNT_ANOMALY` | 95 | BLOCK |
| Known device, 60× usual amount to a new payee | `NEW_PAYEE` + `AMOUNT_EXTREME` | 85 | BLOCK |

Adding a rule is one entry in `RULES` — no engine change, no schema change, no
UI change; the reason string flows through to the timeline on its own. All four
outcomes are pinned by `riskEngine.test.ts`, so run `npm test` after touching
any number above.

> `PRISM_DISABLE=riskEngine` fires no rules at all (score 0, everything
> approves). That switch exists for the attack demo's "before" state and is
> refused entirely when `NODE_ENV=production`.

---

## Semantic verification (what STEP_UP actually does)

Every other layer answers "is this the right **person**, on the right
**device**, approving the right **transaction**?" In social-engineering fraud
the answer to all three is *yes* and the money is still stolen — the victim
really is the account holder, really is holding their own phone, and really is
approving the exact payment the scammer wants. Semantic verification is the
only layer that asks a different question: **does the user understand what they
are about to do?**

**The challenge.** PRISM shows the payee and the amount taken from the *locked*
database record — never from client input — and asks the payer to type the last
two digits of the amount in rupees (`⌊amountMinor / 100⌋ % 100`, so ₹4,750.00 →
`50`). It is deliberately *not* another biometric prompt: a thumb can be pressed
reflexively while someone talks over the phone; reading the real number off the
screen and typing it cannot be done without looking at it.

**The attempt cap is the load-bearing part.** A two-digit answer is guessable in
100 tries, so this control is only as strong as its cap:

- `policy.stepUp.maxAttempts` = **3**, counted **per transaction**, not per
  issued challenge, in its own Redis key outside the challenge record. An
  earlier version kept the counter inside the record, so re-authorizing handed
  out a fresh challenge with attempts back at zero — roughly 34 re-approvals
  covered the whole keyspace.
- Exhausting the cap **blocks the transaction terminally** (`markFailed → BLOCKED`).
  There is no reset path; a genuine user starts a new payment, which is a new
  intent with a new hash and a new nonce.
- The counter's TTL (900 s) outlives the 90 s intent window, so it cannot be
  aged out faster than the transaction it guards. Wrong answers use `INCR`, so
  two concurrent guesses cannot spend the same attempt.
- The challenge is bound to `intentHash` — re-locking the transaction
  invalidates any outstanding challenge (`TAMPER_BLOCKED`).
- A wrong answer does *not* destroy the challenge; a mistyping user just tries
  again. Destroying it per guess protected nothing (the cap is per transaction)
  while forcing an honest payer to re-approve with their passkey.

**Passing is remembered per transaction.** On success PRISM sets a
`stepup:passed:<txId>` flag. Approval still requires a fresh
transaction-bound WebAuthn assertion, and that re-authorization re-runs the
risk engine — which, with the same signals, would demand the same check
forever. So a `STEP_UP` is downgraded to `APPROVE` when that transaction has
already passed. A `BLOCK` is **never** downgraded, and the flag is keyed to the
transaction so it cannot carry over to a different payment.

**Honest limitation.** A sufficiently pressured victim may still read the digits
aloud and type them. This adds friction and clarity at the decisive moment; it
is not a cure.


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
   RiskEngine: sum the points rules that fired (see "Risk scoring" above)
   → APPROVE (< 40) | STEP_UP (40–84) | BLOCK (≥ 85)

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