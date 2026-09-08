# PRISM Authenticator — design

Status: approved for planning · 2026-09-07 · owner S2

A companion mobile app (Expo) that turns PRISM's high-risk outcomes from
*refusal* into *escalation to a second device*, and doubles as a second factor
for portal sign-in.

Today a score of 85+ returns `403 RISK_BLOCKED` (`backend/src/api/routes.ts`).
That is a dead end for a genuine user and, worse, it skips the only control
that addresses a socially-engineered but genuine payer. The Authenticator adds
a rung above the existing last-two-digits challenge instead of replacing it.

---

## 1. The primitive

One derivation, used everywhere:

```
code = HMAC-SHA256(device_secret, binding)
     → low 31 bits via dynamic truncation (RFC 4226 §5.3)
     → % 1_000_000
     → zero-pad to 6 digits
```

`binding` is whatever is being authorized:

| Flow             | binding                                   |
|------------------|-------------------------------------------|
| Payment step-up  | `transactions.intent_hash`                |
| Payment denial   | `intent_hash + ":deny"`                   |
| Portal sign-in   | the WebAuthn login challenge (base64url)  |

**No time counter.** TOTP's 30-second window exists because a login has no
other freshness source. PRISM's flows do: the intent nonce and its TTL
(`policy.stepUp.ttlSeconds = 180`) and the WebAuthn challenge. Dropping the
counter removes clock-skew failure — the demo cannot break because a phone's
clock drifted — and makes the code *deterministic per transaction*, which is
the property that lets the app work with no network at all.

Domain separation for the deny code is the `":deny"` suffix, matching the HKDF
`info`-string convention already used in `modules/keys/keyManager.ts`.

### Brute force

A 6-digit code is 10^6. The cap is the control that already exists and is
already argued for in `config/policy.ts`: `stepUp.maxAttempts = 3` counted
**per transaction**, with `attemptTtlSeconds = 900` outliving the intent
window. The Authenticator answer goes through the same counter and the same
`strictLimiter`. No new rate-limiting code.

---

## 2. Pairing

1. Portal → `POST /authenticator/pair/start` (session required). Server creates
   a row in `authenticator_devices` with `status = 'PENDING'`, a random 32-byte
   `secret`, and a 120-second expiry. Responds `{ deviceId, secret, expiresAt }`.
2. `frontend/src/pages/Settings.tsx` renders that as a QR:
   `prism://pair?d=<deviceId>&s=<base64url secret>`.
3. App scans, writes `{ deviceId, secret }` to `expo-secure-store`, then
   `POST /authenticator/pair/confirm { deviceId }` → `status = 'ACTIVE'`.

**The secret is displayed, never transmitted.** It exists on the server and on
the phone's camera path only — the same shape as an `otpauth://` enrolment URI.
This matters because the demo runs over plain HTTP on a LAN
(`docs/LAN_DEMO_SETUP.md`); a secret POSTed from the phone would be on the wire
in cleartext.

One active device per user in v1. Re-pairing supersedes the previous device
(`status = 'REVOKED'`), which is also the lost-phone story.

---

## 3. Payment step-up

### Server

`riskEngine.evaluate()` is unchanged — thresholds and reasons stay exactly as
`riskEngine.test.ts` pins them. The change is only in how `routes.ts` acts on
the result:

| Score  | Paired device | Outcome                                        |
|--------|---------------|------------------------------------------------|
| < 40   | —             | `APPROVED` (unchanged)                         |
| 40–84  | —             | `STEP_UP`, `mode: 'SEMANTIC'` (unchanged)      |
| 85+    | yes           | `STEP_UP`, `mode: 'AUTHENTICATOR'` (**new**)   |
| 85+    | no            | `403 RISK_BLOCKED` (unchanged)                 |

`blockThreshold` therefore changes meaning: it stops being "refuse" and becomes
"require the second device". A stolen device scoring 90 still fails, one step
later, because the thief does not hold the paired phone. The block path
survives intact for anyone unpaired, so `riskEngine.test.ts` needs no edit —
only the route-level assertions do.

The 202 response carries a **signed** challenge token via the existing
`keyManager.signQrToken(payload, 180)`:

```json
{
  "txId": "...", "intentHash": "...",
  "payee": "Ravi Kumar", "payeeIsNew": true,
  "amountMinor": 4850000, "currency": "INR",
  "score": 87, "reasons": ["NEW_PAYEE", "AMOUNT_ANOMALY", "HASTY_APPROVAL"]
}
```

### Why the signature is not optional

The app displays the payee and amount from the token so the user can compare
them against what the portal claims. If the token were unsigned, an attacker
who can render a QR controls that display — which is precisely the fraud PRISM
exists to stop. Ed25519 verification on the phone needs only the public key, so
the app fetches it once at pairing. New endpoint `GET /.well-known/prism-keys`
exposes the JWK (`keyManager` already exports it at `keyManager.ts:223`).

### Client

Portal renders the token as a QR on the step-up screen. Phone scans, verifies
the signature, shows payee / amount / risk reasons and the 6-digit code with a
countdown to `exp`. User types the code into the portal.

`POST /payment/:id/step-up` — the **existing** endpoint — gains a branch: if
the transaction's step-up mode is `AUTHENTICATOR`, verify the body's `answer`
against `HMAC(secret, intent_hash)` instead of calling `semantic.verify()`.
Same route, same attempt counter, same `{ ok: true, next: 'REAUTHORIZE' }`
contract, so the frontend's post-step-up flow is untouched.

**The phone needs no network for this leg.** Everything it requires is in the
scanned token plus its stored secret. Demonstrating it in airplane mode is the
clearest possible statement that the code is bound to the transaction and not
to a session.

---

## 4. Denial — "This isn't me"

The app's deny button computes `HMAC(secret, intent_hash + ":deny")` and the
user enters it the same way. Server marks the transaction `BLOCKED`, writes a
`USER_REPORTED_FRAUD` audit event, and inserts into the **existing**
`duress_alerts` table (migration 002) — which already models exactly this: a
user signalling coercion, with `raised_at` / `released_at` / `release_note` and
an open-alerts index. No new table.

This is the answer to "what if the scammer is on the phone with them while they
read the code out" — the victim has a code that looks identical to the approval
code and quietly quarantines the payment instead.

---

## 5. Portal sign-in MFA

`POST /auth/login/options` gains `requiresOtp: true` when the account has an
`ACTIVE` device, plus the challenge rendered as `prism://login?c=<challenge>`.
Portal shows it as a QR beside the passkey prompt. App scans, displays
"Sign in to PRISM · 482917". `POST /auth/login/verify` accepts `otp` and
verifies `HMAC(secret, challenge)` **after** `identity.verifyLogin()` succeeds
and **before** `issueSession()`.

Honest framing: this does not make login meaningfully more phishing-resistant —
the passkey already is, and layering an OTP on a WebAuthn login is close to
theatre. Its value here is (a) demonstrating that one primitive binds a code to
*whatever* is being authorized, and (b) covering the case where a passkey is
present on a machine the user no longer controls. Present it that way rather
than as a security win, because a sharp judge will make the point otherwise.

Same failure counter and `strictLimiter` as the existing auth routes.

---

## 6. Schema

`backend/src/db/migrations/003_authenticator.sql` (003 — note 002 is already
taken twice):

```sql
CREATE TABLE authenticator_devices (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id),
  secret       BYTEA       NOT NULL,
  status       TEXT        NOT NULL CHECK (status IN ('PENDING','ACTIVE','REVOKED')),
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ            -- pairing window; NULL once ACTIVE
);

CREATE UNIQUE INDEX idx_authenticator_active_per_user
  ON authenticator_devices(user_id) WHERE status = 'ACTIVE';

ALTER TABLE transactions
  ADD COLUMN step_up_mode TEXT CHECK (step_up_mode IN ('SEMANTIC','AUTHENTICATOR'));
```

The partial unique index enforces one-active-device-per-user in the database
rather than in application code.

---

## 7. Module boundaries

New backend module `backend/src/modules/authenticator/`, mirroring the shape of
the existing modules:

- `otp.ts` — pure. `derive(secret, binding) → string`. No I/O, no imports from
  the rest of the app. This is the file that has a unit test.
- `devices.ts` — pairing lifecycle and lookup. The only file that reads
  `authenticator_devices`.
- `index.ts` — the module's public surface: `startPairing`, `confirmPairing`,
  `activeDeviceFor`, `verifyPaymentCode`, `verifyDenialCode`, `verifyLoginCode`.

`routes.ts` calls only `index.ts`. Secrets never leave `devices.ts` except into
`otp.derive`.

---

## 8. App structure

Expo Go — no dev build, no EAS, no native modules beyond what Expo Go bundles.

```
app/
  App.tsx          four screens on a useState switch — no navigation library
  screens/         Pair.tsx  Scan.tsx  Code.tsx  Settings.tsx
  lib/otp.ts       byte-identical logic to backend otp.ts
  lib/store.ts     expo-secure-store wrapper
  lib/verify.ts    Ed25519 token verification
```

Dependencies: `expo-camera` (barcode scanning), `expo-secure-store`,
`@noble/hashes` (HMAC — `expo-crypto` provides digests but no HMAC),
`@noble/curves` (Ed25519 verification). Four, all pure-JS or Expo-bundled.

No navigation library, no state manager, no UI kit, no push notifications, no
EAS. Four screens do not need routing.

---

## 9. Test

`backend/src/modules/authenticator/otp.test.ts`, in the style of the existing
`riskEngine.test.ts` / `intentCheck.test.ts`:

1. A fixed `(secret, binding)` fixture produces a known 6-digit code — the same
   vector is asserted in the app's `lib/otp.ts` test, so the two derivations
   cannot silently diverge.
2. Flipping one bit of `binding` changes the code (transaction binding holds).
3. The `":deny"` suffix produces a different code from the bare binding (domain
   separation holds).
4. A code valid for transaction A is rejected for transaction B.

---

## 10. Out of scope

- Push notifications, EAS builds, app store distribution.
- Multiple devices per user, device naming, device list UI beyond one row.
- Offline transaction history in the app.
- Biometric gate on opening the app (`expo-local-authentication`) — worth ~10
  lines later, but it protects the secret only against someone already holding
  an unlocked phone.
- Secret rotation. Re-pairing is the rotation story.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Camera permission or scanning fails on the demo phone | Pairing and step-up both accept manual entry of the token as a fallback. Build it into the same screen, not later. |
| `blockThreshold` semantics change confuses the pitch | Frame as "PRISM never dead-ends a genuine user"; the block path remains for unpaired accounts and is still demonstrable. |
| Expo Go version skew against installed SDK | Pin the SDK in `app.json` and test on the actual demo phone before the freeze, not on a simulator. |
