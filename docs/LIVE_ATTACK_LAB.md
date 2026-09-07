# Live Attack Lab — Setup & Usage Guide

The Live Attack Lab is PRISM's real-time attack demonstration surface: an operator console where you pick a **real, currently-live transaction** and launch a **real attack** against it, over the same API a genuine client uses, and watch the real outcome stream in.

It is one of two "modes" in this repo:

| | Mode A — `attacks/` | Mode B — Live Attack Lab |
|---|---|---|
| What it is | Scripted, automated regression suite | Interactive, operator-driven live demo |
| Run it | `cd attacks && npm run setup && npm run <script>` | `/attacks` in the browser |
| Targets | Transactions the script creates itself | Any real live transaction, including ones created by a real browser elsewhere |
| Use it for | CI/regression, "does this control still work?" | Hackathon/judge demos, "watch an attack happen live" |

This document is only about Mode B. For Mode A, see `attacks/README.md`.

---

## 1. Prerequisites

- Postgres + Redis running: `docker compose up -d` (from the repo root)
- Migrations applied and seed data loaded:
  ```bash
  cd backend
  npm run db:migrate
  npm run db:seed
  ```
- `.env` at the repo root (copy from `.env.example` if you haven't already) with at minimum:
  ```
  JWT_SECRET=<any random string>
  ATTACK_ADMIN_TOKEN=<a password you choose for this demo session>
  ```

`ATTACK_ADMIN_TOKEN` is required — every Live Attack Lab endpoint refuses requests without it (503 if unset entirely, 401 if wrong). There is no default; you must set one.

## 2. Optional: enable the stolen-cookie demo

Some attacks (tamper, forged-signature, JWT-tamper, step-up brute force) are more convincing when they use a **real captured session** from another device instead of the engine quietly logging in on its own. To enable the button that makes this possible:

```
ATTACK_LAB_DEMO_ENABLED=true
```

This is hard-disabled whenever `NODE_ENV=production`, regardless of this flag — it cannot be accidentally shipped live. Leave it unset if you don't need this for your demo; every scenario still works without it (see §5).

## 3. Start the stack

```bash
cd backend && npm run dev      # terminal 1 — http://localhost:4000
cd frontend && npm run dev     # terminal 2 — http://localhost:5173
```

For a real multi-laptop demo over a LAN instead of one machine, see `docs/LAN_DEMO_SETUP.md` first — it covers the HTTPS/hostname setup real WebAuthn logins need across devices.

## 4. Open the Lab

Go to **http://localhost:5173/attacks**. First visit, it asks for the operator token — enter the `ATTACK_ADMIN_TOKEN` value from your `.env`. It's kept only in that browser tab's `sessionStorage` (cleared when the tab closes) and sent solely as the `X-Attack-Token` header.

You do **not** need to be signed in as a PRISM user to open this page — the operator token is a separate gate from the ordinary PRISM login.

---

## 5. How to run a live attack

### Step 1 — Get a real live transaction on the board

The **Live transactions** panel at the top polls the real backend every ~1 second and shows every transaction that isn't finished yet (plus anything settled in the last 10 minutes). A row appears here the instant it's created — no matter how it was created:

- **From a real device**: sign in normally at `/` on any browser/laptop, start a payment (`Send` → pick a recipient and amount → you'll land on the Review/approval screen), and stop there without approving it yet. It now shows up in the Lab's live feed as `PENDING`.
- **From the Lab itself**: use the **"Run legitimate transaction"** button (below the fallback target picker) to have the engine complete one on a seeded user's behalf. Good for a quick single-machine test when you don't have a second device handy.

> **Timing matters.** A locked transaction has a 90-second approval window (PRISM's real intent-lock TTL). If you wait too long to attack a `PENDING` row, the real backend will reject with `INTENT_EXPIRED` before your attack's own check even runs — which the Lab reports honestly (outcome `SIMULATED`, not a fabricated block). Pick a fresh row, or create one right before you attack it.

### Step 2 — Select it

Click any row in the Live transactions panel. It highlights, and a green "Attack target selected" banner confirms which real transaction (payer → payee, real id) every attack card below will now target.

### Step 3 — Pick a scenario

Click **Select attack** on any card. You land on that scenario's detail page with your selected transaction already carried over. Read sections 1–3 (Description, Impact, Mechanism) to see exactly what the attack does, which real PRISM layer is expected to catch it, and any honest caveats (e.g. the IDOR scenario explicitly notes that same-LAN network detection does *not* apply here by design).

### Step 4 — (Optional) paste a captured session

If the scenario's "4. Target" section shows a **Victim session cookie** or **Attacker session cookie** field and `ATTACK_LAB_DEMO_ENABLED=true` is set:

1. On the *victim's* device, sign in normally, go to **Home**, and click **"Copy session for Attack Lab"** (only visible when the demo flag is on). This copies that device's real session cookie to the clipboard.
2. Paste it into the matching field on the attack detail page.

Leave the field blank and the engine falls back to authenticating as that account itself — still a completely real login, just not a demonstration of a *stolen* one. The page tells you plainly which mode a run used.

### Step 5 — Launch

Click the big **Launch Attack** button. This is not a UI animation — it POSTs to the real backend, which immediately starts firing real HTTP requests at the real PRISM API (initiate/challenge/authorize/etc., exactly like a genuine client) and returns a run id. The **Live attack execution** panel below then polls that run every ~900ms and renders each event the moment the backend recorded it:

- **Attacker device** events — what the attacker sent and why
- **PRISM** events — the server's actual response, and (once the run finishes) the real `audit_logs` rows for that transaction, folded in and labeled by which PRISM layer produced them
- A final outcome badge: **Blocked**, **Attack succeeded**, **Partially mitigated**, **Simulated**, or **Protection unavailable** — read from the real API response, never asserted by the frontend

### Step 6 — Watch the victim's screen react (if you used a real device)

If you left the transaction open on a real browser's Review screen in Step 1, that screen polls the same transaction record every 1.5 seconds. The moment the attack causes PRISM to reach a terminal state, it automatically navigates to the Status page and shows the real reason — the same failure code the Lab's own event log just showed you. This is pure observation on the victim's side: nothing about the enforcement happens there.

---

## 6. The "Run legitimate transaction" control

Use this to show a payment succeeding normally, for contrast with an attack failing. It runs one complete real payment (initiate → WebAuthn challenge → real Ed25519 signature → risk evaluation → settlement) for whichever user is selected as the fallback target, and streams its own live event log the same way an attack does.

## 7. Run history

The bottom of the dashboard lists every run this backend instance has ever recorded — scenario, attacker label, outcome, and when it started. This is the literal `attack_runs` table, so it survives page reloads and is a real audit trail you can walk a judge through after the fact.

---

## 8. Troubleshooting

- **"Operator token required" won't go away** — check `ATTACK_ADMIN_TOKEN` is set in `.env` and you restarted the backend after setting it (env vars are read once at boot).
- **A run comes back `SIMULATED` with `INTENT_EXPIRED`** — the transaction you selected sat too long before you attacked it (90s window). Pick a fresher one.
- **"Copy session for Attack Lab" button doesn't appear on Home** — `ATTACK_LAB_DEMO_ENABLED` isn't set to `true`, or you're running with `NODE_ENV=production` (hard-disabled there regardless).
- **Rate limited (`429`) during a burst of testing** — the Lab has its own generous limiter, but scenarios that hit `/auth/login` or `/payment/:id/step-up` still share PRISM's stricter limiters with the rest of the app. Wait out the 5-minute window, or space out repeated test runs.
- **Live transactions list is empty** — nothing is currently open. Start a payment from any signed-in device, or click "Run legitimate transaction."

## 9. What this is not

This is a controlled demo-operator facility, not a way to bypass PRISM's security. Every attack goes through the same real `/payment/:id/authorize` (or equivalent) endpoint a genuine client calls, with every one of PRISM's seven authorization steps intact. The Lab's own endpoints, and the session-reveal button, are gated and cannot run in production. See each scenario's "Assumptions" and "Limitations" on its detail page for exactly what it does and doesn't prove.
