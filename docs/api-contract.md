# PRISM API contract

**Frozen at M0.** S2, S3 and S4 build against this. If you need a change, ask
S1 — do not edit a route to match your page.

Base URL `http://localhost:4000/api/v1` · session is an **httpOnly cookie**,
so every request needs `credentials: 'include'`. Use `src/lib/api-client.ts`;
it already does.

## Two rules that are not negotiable

1. **No endpoint accepts a `userId`.** The payer comes from the session cookie.
   Anything else is impersonation.
2. **Money is integer minor units (paise).** ₹5,000 is `500000`. Never a float,
   never a formatted string — the amount is hashed into the intent.

## Error shape

Every failure, without exception:

```json
{ "failureCode": "TAMPER_BLOCKED", "message": "…", "details": { } }
```

Switch on `failureCode`. Full catalogue in `backend/src/api/errors.ts`:

| Code | HTTP | Blocks |
|---|---|---|
| `AUTH_FAILED` | 401 | Credential theft, no session |
| `ORIGIN_MISMATCH` | 403 | Phishing on a lookalike domain |
| `QR_INVALID_SIGNATURE` | 403 | Printed sticker swapped over a real code |
| `QR_EXPIRED` | 410 | Screenshot of an old QR |
| `QR_ALREADY_USED` | 409 | Re-scanning a consumed token |
| `TAMPER_BLOCKED` | 403 | Amount or payee altered after approval |
| `INTENT_EXPIRED` | 410 | Delayed replay, stale approval |
| `REPLAY_BLOCKED` | 409 | Replayed or duplicate submission |
| `SIG_INVALID` | 403 | Forged or wrong credential |
| `RISK_BLOCKED` | 403 | Stolen device, hostile context |
| `STEP_UP_FAILED` | 403 | Social engineering, coerced approval |
| `INSUFFICIENT_FUNDS` | 402 | Ordinary business rule, not an attack |

Unknown codes must fall back to a generic blocked screen. A Future Card may
add one, and the UI must not crash on it.

## Endpoints

### Identity
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/register/options` | `{email}` | WebAuthn creation options |
| POST | `/auth/register/verify` | `{email, response}` | `{userId, displayName}` + sets cookie |
| POST | `/auth/login/options` | `{email}` | WebAuthn request options |
| POST | `/auth/login/verify` | `{email, response}` | `{userId, displayName}` + sets cookie |
| POST | `/auth/logout` | — | `{ok}` |
| GET | `/me` | — | `{userId, email, displayName, balanceMinor, balanceFormatted}` |

### Payment
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/payees` | — | `Payee[]` — `knownPayee:false` drives the new-payee risk rule |
| POST | `/payment/initiate` | `{payeeAccountId, amountMinor}` | `201 TransactionView` |
| GET | `/payment/:id` | — | `TransactionView` — **the only source of truth for the review screen** |
| POST | `/payment/:id/challenge` | — | WebAuthn options whose `challenge` **is** `intent_hash` |
| POST | `/payment/:id/authorize` | `{assertion, deliberationMs}` | `200 APPROVED` \| `202 STEP_UP` \| error |
| POST | `/payment/:id/step-up` | `{answer}` | `{ok, next:'REAUTHORIZE'}` |

`TransactionView`:
```ts
{ txId, payeeName, payeeHandle, amountMinor, amountFormatted, currency,
  status, intentHash, expiresAt, secondsRemaining,
  riskScore, riskReasons, failureCode }
```

`authorize` responses:
```ts
// 200
{ decision:'APPROVED', score, reasons[], settledAt, balanceMinor, balanceFormatted }
// 202 — no money moved, nonce untouched, transaction still retryable
{ decision:'STEP_UP', score, reasons[],
  challenge: { token, prompt, payeeName, amountFormatted, expiresInSeconds } }
```

Passing the step-up does **not** authorize. It returns you to
`/challenge` + `/authorize` for a fresh transaction-bound assertion.

### QR, audit, devices
| Method | Path | Returns |
|---|---|---|
| GET | `/qr/:txId` | `{token, expiresInSeconds}` — Ed25519 JWS, reference only |
| POST | `/qr/redeem` | `TransactionView` fetched from the record, **never from the code** |
| GET | `/transactions` | last 20 `TransactionView` |
| GET | `/transactions/:id/timeline` | `{transaction, events[]}` — the append-only audit trail |
| GET | `/credentials` · POST `/credentials/:id/revoke` | device list / revocation |
| GET | `/policy` | live TTLs, thresholds, and any disabled controls |

## Authorize pipeline order

The sequence is the security design. Nothing runs until the step above passes,
and only the final step moves money or consumes the nonce.

```
1 session          -> AUTH_FAILED
2 ownership/state  -> NOT_FOUND / REPLAY_BLOCKED
3 expiry           -> INTENT_EXPIRED
4 nonce state      -> REPLAY_BLOCKED
5 hash recompute   -> TAMPER_BLOCKED
6 assertion verify -> SIG_INVALID / ORIGIN_MISMATCH
7 context + risk   -> RISK_BLOCKED | STEP_UP | continue
8 balance          -> INSUFFICIENT_FUNDS
9 settle atomically; nonce -> CONSUMED
```

**Invariant to state at judging:** a failed payment never moves money and never
consumes the nonce.
