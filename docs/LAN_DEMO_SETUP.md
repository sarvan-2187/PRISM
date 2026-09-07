# Attack Simulation Dashboard — 3-Laptop LAN Demo Setup

The Attack Simulation Dashboard (`/attacks`) works out of the box in ordinary
single-machine dev mode — `npm run dev` in `backend/` and `frontend/`, same as
the rest of PRISM. This document is only needed if you want the full
three-physical-laptop demo: two laptops as genuine devices doing real browser
passkey logins, a third running the dashboard as the attacker/operator.

## Why this needs extra setup

A browser will only complete a real WebAuthn ceremony in a "secure context":
HTTPS, or literally the hostname `localhost`. It will refuse on a plain LAN IP
like `http://192.168.1.42:5173`. WebAuthn's `rpId` also has to be a real
hostname, not a raw IP address. So a genuine cross-laptop passkey demo needs:

1. A shared hostname (e.g. `prism.local`) that all three laptops resolve to
   the host laptop's LAN IP.
2. An HTTPS certificate for that hostname, trusted on all three laptops.

The attacker device does **not** need any of this — its requests are plain
`fetch` calls (see `backend/src/modules/attacks/httpClient.ts`), not browser
WebAuthn ceremonies, so it can run from any device on the network once it can
reach the backend's URL and knows the operator token.

## Steps (host laptop — the one running backend + Postgres + Redis)

1. Find this machine's LAN IP (e.g. `192.168.1.42`):
   - Windows: `ipconfig` → IPv4 Address
   - macOS/Linux: `ifconfig` or `ip addr`

2. Install [mkcert](https://github.com/FiloSottile/mkcert) and its local CA:
   ```bash
   mkcert -install
   mkcert prism.local
   ```
   This produces `prism.local.pem` and `prism.local-key.pem`.

3. On **every** laptop in the demo (including this one), add a hosts-file
   entry pointing `prism.local` at this machine's LAN IP:
   - Windows: edit `C:\Windows\System32\drivers\etc\hosts` (as Administrator)
   - macOS/Linux: edit `/etc/hosts` (with `sudo`)
   ```
   192.168.1.42   prism.local
   ```

4. Copy `mkcert`'s root CA (`mkcert -CAROOT` shows its location) to the other
   two laptops and trust it there too (double-click the `.pem`/`.crt` and add
   it to the system/browser trust store). Without this step, the other
   laptops' browsers will still show a certificate warning.

5. Update the repo root `.env`:
   ```
   WEBAUTHN_EXPECTED_ORIGIN=http://localhost:5173,https://prism.local:5173
   TLS_CERT_PATH=/absolute/path/to/prism.local.pem
   TLS_KEY_PATH=/absolute/path/to/prism.local-key.pem
   ATTACK_ADMIN_TOKEN=choose-a-token
   ```
   (`WEBAUTHN_RP_ID` can stay `localhost` for local single-machine dev, but
   for the LAN passkeys to work it must be set to `prism.local` — note this
   invalidates any passkeys already registered under `localhost`, since RP ID
   changes are not backwards compatible. Re-register after changing it.)

6. Start the backend as usual (`npm run dev` in `backend/`) — with
   `TLS_CERT_PATH`/`TLS_KEY_PATH` set it now listens over HTTPS on the same
   port.

7. Start the frontend with Vite bound to all interfaces so the other laptops
   can reach it:
   ```bash
   cd frontend && npm run dev -- --host
   ```
   and set `VITE_API_URL=https://prism.local:4000` in `frontend/.env.local`.

## On the two legitimate-device laptops

Open `https://prism.local:5173`, register a real passkey, sign in, and use
the app normally (send/receive) — this is Laptop A / Laptop B in the attack
scenarios' target-selection dropdown.

## On the attacker/operator laptop

Open `https://prism.local:5173/attacks` (or `http://prism.local:5173/attacks`
— the dashboard itself doesn't need HTTPS since it makes plain fetch calls,
not WebAuthn calls), enter the `ATTACK_ADMIN_TOKEN`, pick one of the two
legitimate laptops' accounts as the target, and launch a scenario. Every
request it fires goes to the same real backend the two legitimate laptops are
using — same Postgres, same Redis, same audit log.

## Single-machine fallback

No third laptop available? Everything above still works with all three
"devices" as separate browser profiles or private windows on one machine, or
simply the dashboard's own headless attacker running against sessions the
backend establishes for itself (which is what happens by default — see
`backend/src/modules/attacks/deviceSession.ts`). The backend, database, and
security decisions are exactly the same either way; only the physical
topology changes.
