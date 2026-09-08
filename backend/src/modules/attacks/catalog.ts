/**
 * Attack Scenario Catalog — the content behind every card in the Attack
 * Simulation Dashboard.
 *
 * This is metadata only: what each scenario is, what it targets, and what a
 * real run of it can honestly claim. The actual attack logic lives in
 * ./attackers/*.ts. Descriptions here are drawn from the same protection
 * mapping documented in the repo's own attack.md / attacks/README.md, so the
 * dashboard's claims match the engineering documentation rather than
 * inventing new ones.
 */

export type ScenarioId =
  | 'TRANSACTION_TAMPERING'
  | 'REPLAY_SETTLED_TRANSACTION'
  | 'IDOR_CROSS_USER'
  | 'FORGED_WEBAUTHN_ASSERTION'
  | 'SESSION_JWT_TAMPER'
  | 'STEPUP_BRUTEFORCE'
  | 'QR_OVERLAY_SWAP';

export type ScenarioCategory =
  | 'Transaction Integrity'
  | 'Replay & Ledger'
  | 'Authorization / IDOR'
  | 'Identity (WebAuthn)'
  | 'Session Forgery'
  | 'Social Engineering / Brute Force'
  | 'QR / Receiving Payments';

export interface ScenarioDefinition {
  id: ScenarioId;
  name: string;
  category: ScenarioCategory;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  whatItIs: string;
  howItAffectsTheModel: string;
  attackerGoal: string;
  expectedDetectionLayer: string;
  expectedDetectionFiles: string[];
  preconditions: string[];
  expectedOutcome: string;
  mechanism: string;
  attackerDevice: string;
  targetDescription: string;
  networkHonestyNote?: string;
  /** Can genuinely use a pasted victim/attacker session cookie against a live transaction. */
  usesVictimSession: boolean;
  usesAttackerSession: boolean;
  assumptions: string[];
  limitations: string[];
}

export const CATALOG: Record<ScenarioId, ScenarioDefinition> = {
  TRANSACTION_TAMPERING: {
    id: 'TRANSACTION_TAMPERING',
    name: 'Transaction Tampering (Intent-Hash Substitution)',
    category: 'Transaction Integrity',
    severity: 'HIGH',
    whatItIs:
      'A claimed-hash substitution attack. The attacker locks two real transactions — one cheap, one expensive — and then tries to settle the expensive one while claiming it should be verified against the cheap one’s intent hash, hoping the server trusts a client-supplied hash instead of recomputing its own.',
    howItAffectsTheModel:
      'If it worked, an attacker (or a compromised client) could get a large payment authorized on the strength of a signature that was only ever produced for a small one — silently changing what a "confirmed" payment actually confirmed.',
    attackerGoal:
      'Settle a high-value transaction using verification state that was only ever established for a low-value one.',
    expectedDetectionLayer: 'Intent Lock (Intent layer)',
    expectedDetectionFiles: [
      'backend/src/modules/intent/intentLock.ts (verifyHash)',
      'backend/src/api/routes.ts (POST /payment/:id/authorize, step 4)',
    ],
    preconditions: [
      'Target user has at least one account and one payee to pay',
      'PRISM backend reachable at the configured local URL',
    ],
    expectedOutcome:
      'The server recomputes the intent hash from its own locked database record and rejects any claimed hash that disagrees with it, with failureCode TAMPER_BLOCKED.',
    mechanism:
      'The engine locks a real ₹5 transaction and a real high-value transaction for the target user (POST /payment/initiate twice), then calls POST /payment/:id/authorize on the expensive one while passing the cheap transaction’s real intentHash in the request body — exactly the shape a proxy-based interception attack would produce.',
    attackerDevice:
      'Runs as a manipulated client on the payer’s own authenticated session — models an attacker who has intercepted or is proxying the victim’s traffic (e.g. a malicious device on the same network performing request tampering), not a separate account.',
    targetDescription: 'A real live PENDING/STEP_UP_REQUIRED transaction selected from the discovery feed (or, as a fallback, one the engine creates itself).',
    usesVictimSession: true,
    usesAttackerSession: false,
    assumptions: [
      'The attacker can modify outgoing request bodies (e.g. via a proxy on a compromised/adjacent device) but cannot forge a valid signature.',
    ],
    limitations: [
      'This does not test whether an attacker can intercept traffic in the first place (that is a transport/TLS concern, out of scope for this API-level check).',
    ],
  },

  REPLAY_SETTLED_TRANSACTION: {
    id: 'REPLAY_SETTLED_TRANSACTION',
    name: 'Replay of a Settled Transaction',
    category: 'Replay & Ledger',
    severity: 'HIGH',
    whatItIs:
      'A classic replay attack: capture a completed, successfully authorized payment request and resend it, hoping the backend moves the money a second time.',
    howItAffectsTheModel:
      'A successful replay would double-debit the payer (or double-credit the payee) for a single approved intent — turning one authorization into two settlements.',
    attackerGoal: 'Get a single approved payment to settle — and move money — more than once.',
    expectedDetectionLayer: 'Nonce / Replay Guard + Ledger (Intent & Ledger layers)',
    expectedDetectionFiles: [
      'backend/src/modules/intent/intentLock.ts (nonceState/consumeNonce)',
      'backend/src/modules/ledger/settlement.ts (settle)',
      'backend/src/db/migrations/001_initial_schema.sql (ledger_entries UNIQUE(transaction_id, direction))',
    ],
    preconditions: [
      'Target user has sufficient balance for one small real payment',
      'A known payee exists for the target user (to avoid triggering STEP_UP so the run reaches SETTLED deterministically)',
    ],
    expectedOutcome:
      'The first authorize call settles normally. The identical replayed authorize call is rejected with failureCode REPLAY_BLOCKED — enforced independently by the in-memory nonce state and, underneath that, a database-level UNIQUE constraint that makes a double settlement impossible even under a race.',
    mechanism:
      'The engine completes one full, real payment for the target user — initiate, challenge, sign with a real Ed25519 credential, authorize — through to SETTLED, then immediately resubmits the exact same authorize request a second time.',
    attackerDevice:
      'A device holding a copy of the already-used, real signed request (e.g. captured off the wire or from a compromised client) — it does not need the user’s private key, only the request it already sent once.',
    targetDescription: 'A real live SETTLED transaction (settled in the last 10 minutes) selected from the discovery feed, or — as a fallback — one the engine completes and settles itself before replaying.',
    usesVictimSession: true,
    usesAttackerSession: false,
    assumptions: ['The attacker obtained a real captured session cookie for the payer (a byte-for-byte copy of the original signed request is not required — the nonce/ledger guard rejects any re-authorize attempt on an already-consumed transaction before a signature is even checked).'],
    limitations: [
      'When falling back to a self-created transaction, the "replay" is a literal byte-for-byte resend, since the engine holds the original request in that case — the live-transaction path instead demonstrates the broader guarantee that ANY resubmission against a settled transaction fails, which is the stronger and more general claim.',
    ],
  },

  IDOR_CROSS_USER: {
    id: 'IDOR_CROSS_USER',
    name: 'Cross-User IDOR — Same-Network Attacker',
    category: 'Authorization / IDOR',
    severity: 'HIGH',
    whatItIs:
      'An Insecure Direct Object Reference (IDOR) attempt. A second, fully authenticated device — sitting on the same local network as the victim’s devices — tries to read and act on the victim’s transaction and credential records by guessing/using their real ids, using nothing but its own (different) session.',
    howItAffectsTheModel:
      'If ownership were not checked server-side, being on the same network or simply knowing a transaction id would be enough to read another customer’s payment details or attempt to act on their account.',
    attackerGoal:
      "Read another user's transaction/timeline data, or authorize/revoke against their account, using only the attacker's own valid login.",
    expectedDetectionLayer: 'Authorization / Ownership checks (Authorization layer)',
    expectedDetectionFiles: [
      'backend/src/api/routes.ts (payer_user_id !== req.userId checks on GET /payment/:id, GET /transactions/:id/timeline, POST /payment/:id/authorize, POST /credentials/:id/revoke)',
    ],
    preconditions: [
      'Two distinct real users exist — one victim, one attacker — each with their own login',
      'Victim has at least one settled transaction and one registered credential to target',
    ],
    expectedOutcome:
      'Every cross-user read and write returns NOT_FOUND rather than leaking existence or content, because every query is scoped to req.userId from the attacker’s own session cookie — the attacker cannot widen access by editing a path parameter no matter what id they supply.',
    mechanism:
      'The engine establishes two real, independent sessions (attacker + victim) and, using ONLY the attacker’s session cookie, calls GET /payment/:id, GET /transactions/:id/timeline, POST /payment/:id/authorize, and POST /credentials/:id/revoke against the victim’s real ids.',
    attackerDevice:
      'A separate, fully legitimate device with its own real login — modeling "Laptop 3" sitting on the same Wi-Fi/LAN as the two legitimate devices and attempting to reach the other account’s data.',
    targetDescription: 'A real live transaction selected from the discovery feed (any status), plus a separate attacker account.',
    usesVictimSession: false,
    usesAttackerSession: true,
    networkHonestyNote:
      'PRISM’s network micro-fingerprint check (networkChanged in backend/src/modules/context/network.ts) intentionally treats any two private-subnet IPs as "unchanged" — so an attacker on the same LAN as the victim will NOT be flagged by network/subnet detection. This scenario deliberately demonstrates that: the block you will see here comes entirely from the ownership/authorization check, not from network detection, and the dashboard says so explicitly rather than implying otherwise.',
    assumptions: ['The attacker has their own valid PRISM login (this is not a check on the login step itself).'],
    limitations: [
      'Does not test whether transaction ids are guessable/enumerable in the first place (they are random UUIDs) — only what happens once an id is known.',
    ],
  },

  FORGED_WEBAUTHN_ASSERTION: {
    id: 'FORGED_WEBAUTHN_ASSERTION',
    name: 'Forged / Wrong WebAuthn Assertion',
    category: 'Identity (WebAuthn)',
    severity: 'HIGH',
    whatItIs:
      'Two real cryptographic identity attacks in sequence: (1) an attacker who has obtained the victim’s session cookie (e.g. a copied/stolen cookie on a shared network) but not their passkey’s private key tries to authorize a payment by claiming the victim’s real credential id while signing with a different key it controls; (2) after the victim’s device is revoked (the real "stolen device" response), the same physical device tries to keep using its now-revoked key.',
    howItAffectsTheModel:
      'This is the core PERSON check: a payment is only supposed to be approved by the specific private key bound to the account. If a stolen session cookie were enough on its own, or a revoked device kept working, the biometric/passkey step would be theater.',
    attackerGoal:
      'Get a payment cryptographically "approved" without possessing the victim’s real passkey private key, or keep using a device after it has been reported stolen and revoked.',
    expectedDetectionLayer: 'Identity / PERSON layer (WebAuthn assertion verification)',
    expectedDetectionFiles: [
      'backend/src/modules/identity/webauthn.ts (verifyAssertion / verifyPaymentAssertion)',
      'backend/src/api/routes.ts (POST /payment/:id/authorize, step 5)',
    ],
    preconditions: [
      'Target user has (or the engine creates) a real registered passkey',
      'The engine can call the revoke-credential endpoint as the victim to demonstrate the second sub-case',
    ],
    expectedOutcome:
      'The forged-signature attempt fails cryptographic verification with failureCode SIG_INVALID (the signature simply does not verify against the stored public key for the claimed credential id). The post-revocation attempt fails with AUTH_FAILED because the credential’s revoked_at is set.',
    mechanism:
      'The engine registers a real Ed25519 credential for the victim, then (a) crafts an assertion signed by a DIFFERENT, attacker-controlled Ed25519 key but labelled with the victim’s real credential id, and submits it to /payment/:id/authorize using the victim’s session; then (b) calls the real POST /credentials/:id/revoke as the victim, and attempts one more real authorize signed by the now-revoked original key.',
    attackerDevice:
      'A device that has obtained the victim’s session cookie but generates and signs with its own private key — it never has access to the real hardware-bound authenticator.',
    targetDescription: 'A real live transaction selected from the discovery feed for sub-attack (a); sub-attack (b) additionally needs the engine to hold the victim credential\'s private key, so it only runs when no captured session was pasted.',
    usesVictimSession: true,
    usesAttackerSession: false,
    assumptions: ['The attacker obtained the victim’s session cookie but not their authenticator private key.'],
    limitations: [
      'This does not model a compromised authenticator itself (e.g. a jailbroken secure enclave) — only the case where the attacker lacks the private key.',
    ],
  },

  SESSION_JWT_TAMPER: {
    id: 'SESSION_JWT_TAMPER',
    name: 'Session Cookie Forgery (JOSE alg-confusion / payload tamper)',
    category: 'Session Forgery',
    severity: 'MEDIUM',
    whatItIs:
      'Two classic JOSE/JWT forgery techniques against the session cookie: (a) rewriting the token header to alg:"none" and stripping the signature; (b) swapping the `sub` (user id) claim to a different user while keeping the original, now-mismatched signature.',
    howItAffectsTheModel:
      'A successful forgery would let an attacker mint a session for any user id without ever authenticating — a complete bypass of login.',
    attackerGoal: 'Obtain a valid-looking session for an arbitrary user without signing in.',
    expectedDetectionLayer: 'Session verification (Identity / session layer)',
    expectedDetectionFiles: [
      'backend/src/modules/keys/keyManager.ts (verifySession, explicit algorithms allowlist)',
      'backend/src/api/middleware/session.ts (attachSession / requireSession)',
    ],
    preconditions: ['Target user has a real session cookie for the engine to decode and mutate'],
    expectedOutcome:
      'Both forged tokens are treated as anonymous by the session middleware and refused with failureCode AUTH_FAILED (401) on a protected route, while the genuine, unmodified cookie continues to authenticate normally.',
    mechanism:
      'The engine logs the victim in for real to obtain a genuine session JWT, decodes its header/payload, then builds (a) an alg:none variant and (b) a payload-swapped variant with the stale original signature, and submits each as the session cookie to GET /api/v1/me.',
    attackerDevice: 'A device that intercepted or otherwise obtained a real session cookie and is rewriting it offline before replaying it.',
    targetDescription: 'One target user whose real session cookie is captured and mutated by the engine — a live transaction may be selected for narrative context but is not itself required.',
    usesVictimSession: true,
    usesAttackerSession: false,
    assumptions: ['The attacker obtained a genuine session cookie to use as raw material for forgery.'],
    limitations: [],
  },

  STEPUP_BRUTEFORCE: {
    id: 'STEPUP_BRUTEFORCE',
    name: 'Semantic Step-Up Brute Force',
    category: 'Social Engineering / Brute Force',
    severity: 'MEDIUM',
    whatItIs:
      'A brute-force attempt against the "last two digits of the amount" comprehension check that PRISM issues for a high-risk payment, hoping to guess the two-digit answer before running out of attempts.',
    howItAffectsTheModel:
      'The semantic step-up exists to catch social-engineering fraud where a genuine user is manipulated into approving a payment. If its two-digit answer could be brute-forced, the control would add friction without adding real security.',
    attackerGoal: "Guess the correct two-digit answer to push a STEP_UP payment through without the payer's real comprehension.",
    expectedDetectionLayer: 'Semantic verification + rate limiting (Semantic layer)',
    expectedDetectionFiles: [
      'backend/src/modules/semantic/intentCheck.ts (per-transaction attempt cap)',
      'backend/src/api/middleware/rateLimiter.ts (strictLimiter on /payment/:id/step-up)',
    ],
    preconditions: [
      'A payee the target user has never paid before is available, so the run can reliably trip the risk engine’s NEW_PAYEE + NO_BASELINE signals into STEP_UP',
    ],
    expectedOutcome:
      'Wrong guesses are refused with failureCode STEP_UP_FAILED, and the transaction is blocked terminally once the attempt cap (3 wrong answers) is reached — there is no reset path, so exhausting the cap ends the run’s ability to keep guessing.',
    mechanism:
      'The engine registers a real credential, signs a real payment approval to a never-before-paid payee for an amount designed to reach STEP_UP_REQUIRED, then submits a sequence of incorrect two-digit guesses to POST /payment/:id/step-up until the attempt cap is hit or exhausted.',
    attackerDevice: 'The device that received the STEP_UP challenge and is guessing at the same session — models an attacker who has taken over an in-progress approval flow.',
    targetDescription: 'A real live transaction already at STEP_UP_REQUIRED selected from the discovery feed, or — as a fallback — one the engine creates itself.',
    usesVictimSession: true,
    usesAttackerSession: false,
    assumptions: [
      'This run needs the live risk engine to actually reach STEP_UP_REQUIRED for the amount/payee combination used; PRISM’s risk thresholds are policy-owned and can legitimately produce APPROVE or BLOCK instead on a given run — if so, this is reported honestly as SIMULATED rather than forcing a result.',
    ],
    limitations: ['A sufficiently pressured genuine victim reading the digits aloud to a scammer is a social problem this control reduces, not eliminates.'],
  },

  QR_OVERLAY_SWAP: {
    id: 'QR_OVERLAY_SWAP',
    name: 'QR Code Overlay (Sticker-Swap) Fraud',
    category: 'QR / Receiving Payments',
    severity: 'HIGH',
    whatItIs:
      'The classic UPI/QR sticker-swap scam: a fraudster pastes a look-alike code over a shop’s real one. A static QR just encodes an account number, so the swap is invisible — the customer scans, sees an ordinary-looking payment screen, and pays the fraudster with no warning. This reproduces the swap against PRISM’s Receive flow three ways: (1) the attacker’s own, honestly-signed request displayed in place of the merchant’s — no forgery needed, exactly like the real scam; (2) the same code photographed and scanned a second time; (3) a hand-crafted, unsigned code, the low-effort version of the same sticker.',
    howItAffectsTheModel:
      'PRISM’s QR is deliberately not a bearer instrument: the code carries a signed reference, never a name, an account number, or an amount (see dynamicQr.ts). If the overlay succeeded silently, the entire "receive" side of PRISM would be exactly as vulnerable as a static-QR wallet is today, no matter how strong the payer-side controls are.',
    attackerGoal:
      "Get a customer's device to resolve a scanned code to the attacker's own account while the customer believes they scanned the merchant's.",
    expectedDetectionLayer: 'Dynamic QR (QR layer)',
    expectedDetectionFiles: [
      'backend/src/modules/qr/dynamicQr.ts (createRequest / scan / verifyToken)',
      'backend/src/api/routes.ts (POST /qr/request, POST /qr/scan)',
    ],
    preconditions: [
      'Two distinct real users exist — one plays the customer, a second plays the overlay attacker',
      'PRISM backend reachable at the configured local URL',
    ],
    expectedOutcome:
      'Sub-attack 1 is not rejected by the server at all — the attacker’s code is genuinely theirs and genuinely signed — but POST /qr/scan resolves it from the database and returns the attacker’s REAL name and handle, never a spoofed merchant identity, so the review screen a customer sees before approving names the true recipient. Sub-attack 2 (scanning the exact same code a second time) is refused with QR_ALREADY_USED. Sub-attack 3 (a hand-crafted, unsigned code) is refused with QR_INVALID_SIGNATURE before any database lookup happens.',
    mechanism:
      'The engine establishes two real, independent sessions — a customer and a separate overlay attacker. The attacker mints a real, validly-signed QR payment request for their own account (POST /qr/request) — this is "the sticker". The customer’s session then scans it once (POST /qr/scan); the engine inspects the resolved payeeName/payeeHandle in the real response against the attacker’s real identity. The engine then resubmits the identical, now-consumed token a second time (POST /qr/scan again), and separately submits a hand-built, unsigned token of the same shape — both as the customer.',
    attackerDevice:
      "A second, fully legitimate PRISM account displaying its OWN real QR code in place of a shop's — modelling a fraudster who needs no forged signature at all, only physical or digital access to overlay a genuine code of their own.",
    targetDescription:
      'Two real accounts: a customer (the target user) and a second real account the engine selects to play the overlay attacker.',
    usesVictimSession: true,
    usesAttackerSession: true,
    assumptions: [
      'The attacker can physically or digitally place their own QR code where a customer will scan it (e.g. a paper sticker, a compromised display) — this scenario does not test that placement step itself, only what happens once the customer’s device resolves the code.',
    ],
    limitations: [
      'A customer who does not read the recipient name before approving is not protected by this control alone — PRISM exposes the true identity truthfully; a human still has to look at it. The same honest limitation the semantic step-up documents for social engineering applies here.',
    ],
  },
};

export function listCatalog(): ScenarioDefinition[] {
  return Object.values(CATALOG);
}

export function getScenario(id: string): ScenarioDefinition | undefined {
  return CATALOG[id as ScenarioId];
}
