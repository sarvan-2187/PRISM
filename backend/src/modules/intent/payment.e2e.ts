/**
 * End-to-end payment-correctness harness.  Run: npm run test:e2e
 *
 * Preconditions:
 *   docker compose up -d
 *   npm run db:migrate && npm run db:seed
 *   npm run dev            (separate terminal — the harness drives it over HTTP)
 *
 * Drives the real booted server, because the authorize pipeline ordering is the
 * security design and lives only in routes.ts — calling module functions
 * directly would not exercise it. Uses the headless software authenticator so no
 * browser is needed.
 *
 * Scenarios: A happy path · B replay · C expiry · D tamper · E revocation.
 * Every row it creates is deleted on exit and account balances are restored;
 * pass --keep to leave state for inspection.
 *
 * Maps to PLAN.md S1 tasks 1.1–1.6 and 1.8.
 */
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { query } from '../../db/pool';
import pool from '../../db/pool';
import redis from '../../utils/redis';
import { config } from '../../config/env';
import { policy } from '../../config/policy';
import { createSoftCredential, SoftCredential } from '../identity/softAuthenticator';

const BASE = `http://localhost:${config.port}`;
const API = `${BASE}/api/v1`;
const KEEP = process.argv.includes('--keep');
const ASHA_EMAIL = 'asha@prism.demo';
const PRIYA_HANDLE = 'priya@prism';
const AMOUNT = 50_000; // ₹500 in paise
const STARTED_AT = new Date();

let cookie = '';

interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function apiCall(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      // A stable UA so context fingerprinting has something to work with.
      'user-agent': 'prism-e2e/1.0',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = /prism_session=[^;]+/.exec(setCookie);
    if (m) cookie = m[0];
  }
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* leave as text */
  }
  return { status: res.status, body: parsed };
}

function expectFail(r: ApiResult, status: number, code: string, label: string): void {
  assert.equal(r.status, status, `${label}: expected HTTP ${status}, got ${r.status} — ${JSON.stringify(r.body)}`);
  assert.equal(
    r.body?.failureCode,
    code,
    `${label}: expected failureCode ${code}, got ${JSON.stringify(r.body)}`
  );
}

// ── Shared fixture state ────────────────────────────────────────────────
let ashaUserId = '';
let ashaAccountId = '';
let priyaAccountId = '';
let ashaBalance0 = 0n;
let priyaBalance0 = 0n;
let cred: SoftCredential;
const createdTxIds: string[] = [];
const createdCredIds: string[] = [];
const createdUserIds: string[] = [];
const createdAccountIds: string[] = [];

async function preflight(): Promise<void> {
  let health: ApiResult;
  try {
    const res = await fetch(`${BASE}/health`);
    health = { status: res.status, body: await res.json() };
  } catch {
    throw new Error(
      `Cannot reach ${BASE}/health. Start the stack first:\n` +
        `  docker compose up -d\n  cd backend && npm run db:migrate && npm run db:seed && npm run dev`
    );
  }
  assert.equal(health.status, 200, `/health not ok: ${JSON.stringify(health.body)}`);
  assert.equal(health.body.ok, true, `/health not ok: ${JSON.stringify(health.body)}`);
}

async function setup(): Promise<void> {
  // TEST-ONLY: clear this host's rate-limit counters.
  //
  // strictLimiter allows 20 requests per 5 minutes across /auth/*, and each run
  // of this harness spends 4 of them. Running it repeatedly — which is exactly
  // what you do while developing — exhausts the budget and every scenario then
  // fails at login with RATE_LIMITED. The limiter is doing its job; the harness
  // is the abusive client. Clearing only our own rl:* keys keeps the control
  // fully armed for real traffic and makes the suite deterministic.
  const rlKeys = await redis.keys('rl:*');
  if (rlKeys.length) {
    await redis.del(...rlKeys);
    console.log(`  setup: cleared ${rlKeys.length} rate-limit counters (test-only)`);
  }

  const u = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [ASHA_EMAIL]);
  assert.ok(u.rows[0], `seed missing — no user ${ASHA_EMAIL}. Run npm run db:seed.`);
  ashaUserId = u.rows[0].id;

  const pa = await query<{ id: string; balance_minor: string }>(
    'SELECT id, balance_minor FROM accounts WHERE user_id = $1 ORDER BY created_at LIMIT 1',
    [ashaUserId]
  );
  ashaAccountId = pa.rows[0].id;
  ashaBalance0 = BigInt(pa.rows[0].balance_minor);

  const pe = await query<{ id: string; balance_minor: string }>(
    'SELECT id, balance_minor FROM accounts WHERE handle = $1',
    [PRIYA_HANDLE]
  );
  priyaAccountId = pe.rows[0].id;
  priyaBalance0 = BigInt(pe.rows[0].balance_minor);

  // Register a software passkey directly, then log in for real — this also
  // exercises the (now fixed) assertion-verification path for login.
  cred = createSoftCredential(ashaUserId);
  createdCredIds.push(cred.credentialId);
  await query(
    `INSERT INTO credentials (id, user_id, public_key, counter, device_type, backed_up, transports)
     VALUES ($1, $2, $3, 0, 'singleDevice', false, '{internal}')`,
    [cred.credentialId, ashaUserId, cred.cosePublicKey]
  );

  const opts = await apiCall('POST', '/auth/login/options', { email: ASHA_EMAIL });
  assert.equal(opts.status, 200, `login/options: ${JSON.stringify(opts.body)}`);
  const verify = await apiCall('POST', '/auth/login/verify', {
    email: ASHA_EMAIL,
    response: cred.sign(opts.body.challenge),
  });
  assert.equal(verify.status, 200, `login/verify failed: ${JSON.stringify(verify.body)}`);
  assert.ok(cookie, 'no session cookie after login');
}

async function initiate(): Promise<{ txId: string; intentHash: string }> {
  const r = await apiCall('POST', '/payment/initiate', {
    payeeAccountId: priyaAccountId,
    amountMinor: AMOUNT,
  });
  assert.equal(r.status, 201, `initiate: ${JSON.stringify(r.body)}`);
  createdTxIds.push(r.body.txId);
  return { txId: r.body.txId, intentHash: r.body.intentHash };
}

/**
 * Spend long enough on the (notional) review screen that the server's own
 * deliberation measurement does not read as hasty.
 *
 * Deliberation is measured server-side from the INTENT_LOCKED audit row, not
 * from anything the client asserts, so a script that initiates and authorizes
 * in the same millisecond genuinely looks reflexive and HASTY_APPROVAL fires.
 * That is the control working, not a test defect — so the harness waits the
 * way a human would.
 */
async function deliberate(): Promise<void> {
  await new Promise((r) => setTimeout(r, policy.hastyApprovalMs + 400));
}

async function ledgerCount(txIds: string[]): Promise<number> {
  const r = await query<{ c: string }>(
    'SELECT COUNT(*)::text AS c FROM ledger_entries WHERE transaction_id = ANY($1)',
    [txIds]
  );
  return parseInt(r.rows[0].c, 10);
}

// ── Scenario A — happy path (1.1, 1.2, 1.6) ─────────────────────────────
async function scenarioA(): Promise<void> {
  const { txId, intentHash } = await initiate();

  const view = await apiCall('GET', `/payment/${txId}`);
  assert.equal(view.body.amountMinor, AMOUNT, 'A: server amount');
  assert.equal(view.body.intentHash, intentHash, 'A: server intent hash');
  assert.equal(view.body.status, 'PENDING', 'A: initial status');

  await deliberate();

  const ch = await apiCall('POST', `/payment/${txId}/challenge`);
  assert.equal(ch.status, 200, `A: challenge ${JSON.stringify(ch.body)}`);
  assert.equal(ch.body.challenge, intentHash, 'A: options.challenge IS the intent hash (the fix)');

  const auth = await apiCall('POST', `/payment/${txId}/authorize`, {
    assertion: cred.sign(ch.body.challenge),
  });
  assert.equal(auth.status, 200, `A: authorize ${JSON.stringify(auth.body)}`);
  assert.equal(auth.body.decision, 'APPROVED', `A: decision ${JSON.stringify(auth.body)}`);

  const tx = await query<{ status: string; settled_at: Date | null }>(
    'SELECT status, settled_at FROM transactions WHERE id = $1',
    [txId]
  );
  assert.equal(tx.rows[0].status, 'SETTLED', 'A: status SETTLED');
  assert.ok(tx.rows[0].settled_at, 'A: settled_at set');

  const payer = await query<{ balance_minor: string }>(
    'SELECT balance_minor FROM accounts WHERE id = $1',
    [ashaAccountId]
  );
  const payee = await query<{ balance_minor: string }>(
    'SELECT balance_minor FROM accounts WHERE id = $1',
    [priyaAccountId]
  );
  assert.equal(BigInt(payer.rows[0].balance_minor), ashaBalance0 - BigInt(AMOUNT), 'A: payer debited');
  assert.equal(BigInt(payee.rows[0].balance_minor), priyaBalance0 + BigInt(AMOUNT), 'A: payee credited');

  const entries = await query<{ direction: string; amount_minor: string }>(
    'SELECT direction, amount_minor FROM ledger_entries WHERE transaction_id = $1',
    [txId]
  );
  assert.deepEqual(
    entries.rows.map((e) => `${e.direction}:${e.amount_minor}`).sort(),
    [`CREDIT:${AMOUNT}`, `DEBIT:${AMOUNT}`],
    'A: double-entry ledger (one DEBIT, one CREDIT)'
  );

  const nonce = await query<{ nonce: string }>('SELECT nonce FROM transactions WHERE id = $1', [txId]);
  assert.equal(await redis.get(`nonce:${nonce.rows[0].nonce}`), 'CONSUMED', 'A: nonce CONSUMED');

  const tl = await apiCall('GET', `/transactions/${txId}/timeline`);
  const events: string[] = tl.body.events.map((e: { event: string }) => e.event);
  for (const want of [
    'INTENT_LOCKED',
    'CHALLENGE_ISSUED',
    'ASSERTION_VERIFIED',
    'CONTEXT_EVALUATED',
    'RISK_EVALUATED',
    'PAYMENT_SETTLED',
  ]) {
    assert.ok(events.includes(want), `A: timeline missing ${want} — got ${events.join(', ')}`);
  }

  console.log('  A · happy path: SETTLED, balances moved, nonce CONSUMED, timeline complete');
}

// ── Scenario B — replay (1.3) ──────────────────────────────────────────
async function scenarioB(): Promise<void> {
  const txId = createdTxIds[0]; // the settled one from A

  const b1 = await apiCall('POST', `/payment/${txId}/authorize`, {
    assertion: cred.sign('x'.repeat(43)),
  });
  expectFail(b1, 409, 'REPLAY_BLOCKED', 'B1 (status SETTLED)');

  // Force the row back to PENDING; the nonce is already CONSUMED from A.
  await query(`UPDATE transactions SET status = 'PENDING' WHERE id = $1`, [txId]);
  const reCh = await apiCall('POST', `/payment/${txId}/challenge`);
  assert.equal(reCh.status, 200, `B2: challenge ${JSON.stringify(reCh.body)}`);
  const b2 = await apiCall('POST', `/payment/${txId}/authorize`, {
    assertion: cred.sign(reCh.body.challenge),
  });
  expectFail(b2, 409, 'REPLAY_BLOCKED', 'B2 (nonce CONSUMED)');

  assert.equal(await ledgerCount([txId]), 2, 'B: no extra ledger rows');

  const blocked = await query<{ event_data: Record<string, unknown> }>(
    `SELECT event_data FROM audit_logs WHERE transaction_id = $1 AND event_type = 'PAYMENT_BLOCKED'`,
    [txId]
  );
  assert.ok(
    blocked.rows.some((r) => r.event_data.failureCode === 'REPLAY_BLOCKED'),
    'B: audit records REPLAY_BLOCKED'
  );

  console.log('  B · replay: 409 REPLAY_BLOCKED at status layer and nonce layer, no double-spend');
}

// ── Scenario C — expiry (1.4) ─────────────────────────────────────────
async function scenarioC(): Promise<void> {
  const a = await initiate();
  await query(`UPDATE transactions SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [a.txId]);
  const cCh = await apiCall('POST', `/payment/${a.txId}/challenge`);
  expectFail(cCh, 410, 'INTENT_EXPIRED', 'C (challenge path)');
  const cRow = await query<{ status: string }>('SELECT status FROM transactions WHERE id = $1', [a.txId]);
  assert.equal(cRow.rows[0].status, 'EXPIRED', 'C: status EXPIRED after challenge');

  const b = await initiate();
  const bCh = await apiCall('POST', `/payment/${b.txId}/challenge`);
  assert.equal(bCh.status, 200, 'C: challenge issued while valid');
  await query(`UPDATE transactions SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [b.txId]);
  const bAuth = await apiCall('POST', `/payment/${b.txId}/authorize`, {
    assertion: cred.sign(bCh.body.challenge),
  });
  expectFail(bAuth, 410, 'INTENT_EXPIRED', 'C (authorize path)');
  const bRow = await query<{ status: string; failure_code: string | null }>(
    'SELECT status, failure_code FROM transactions WHERE id = $1',
    [b.txId]
  );
  assert.equal(bRow.rows[0].status, 'EXPIRED', 'C: status EXPIRED after authorize');
  assert.equal(bRow.rows[0].failure_code, 'INTENT_EXPIRED', 'C: failure_code');
  assert.notEqual('INTENT_EXPIRED', 'REPLAY_BLOCKED'); // C7: distinct from replay

  assert.equal(await ledgerCount([a.txId, b.txId]), 0, 'C: no money moved');
  console.log('  C · expiry: 410 INTENT_EXPIRED on both paths, distinct from REPLAY_BLOCKED');
}

// ── Scenario D — tamper (1.5) ─────────────────────────────────────────
async function scenarioD(): Promise<void> {
  const a = await initiate();
  const aCh = await apiCall('POST', `/payment/${a.txId}/challenge`);
  const aAssertion = cred.sign(aCh.body.challenge);
  const dAmount = await apiCall('POST', `/payment/${a.txId}/authorize`, {
    assertion: aAssertion,
    amountMinor: 5_000_000, // "resubmit with a bigger amount"
  });
  expectFail(dAmount, 403, 'TAMPER_BLOCKED', 'D (amount swap)');

  const aRow = await query<{ status: string; failure_code: string | null; nonce: string }>(
    'SELECT status, failure_code, nonce FROM transactions WHERE id = $1',
    [a.txId]
  );
  assert.equal(aRow.rows[0].status, 'BLOCKED', 'D: status BLOCKED');
  assert.equal(aRow.rows[0].failure_code, 'TAMPER_BLOCKED', 'D: failure_code');
  assert.equal(await redis.get(`nonce:${aRow.rows[0].nonce}`), 'RESERVED', 'D: nonce untouched on a blocked path');

  const audit = await query<{ event_data: Record<string, unknown> }>(
    `SELECT event_data FROM audit_logs WHERE transaction_id = $1 AND event_type = 'PAYMENT_BLOCKED'`,
    [a.txId]
  );
  assert.ok(
    audit.rows.some((r) => r.event_data.failureCode === 'TAMPER_BLOCKED'),
    'D: audit records TAMPER_BLOCKED with the claimed values'
  );

  // Fresh tx, tamper via a mismatched body intentHash (the other step-4 path).
  const b = await initiate();
  const bCh = await apiCall('POST', `/payment/${b.txId}/challenge`);
  const wrongHash = crypto.createHash('sha256').update('not-the-intent').digest('base64url');
  const dHash = await apiCall('POST', `/payment/${b.txId}/authorize`, {
    assertion: cred.sign(bCh.body.challenge),
    intentHash: wrongHash,
  });
  expectFail(dHash, 403, 'TAMPER_BLOCKED', 'D (hash claim mismatch)');

  assert.equal(await ledgerCount([a.txId, b.txId]), 0, 'D: no money moved');
  console.log('  D · tamper: 403 TAMPER_BLOCKED on amount swap and hash-claim mismatch, nonce kept');
}

// ── Scenario E — credential revocation (1.8) ──────────────────────────
// Uses a throwaway user so the assertion "no active credential" is exact and
// Asha's real credentials are never touched.
async function scenarioE(): Promise<void> {
  const stamp = Date.now();
  const email = `e2e-revoke-${stamp}@prism.test`;
  const nu = await query<{ id: string }>(
    `INSERT INTO users (email, display_name) VALUES ($1, 'E2E Revoke') RETURNING id`,
    [email]
  );
  const userId = nu.rows[0].id;
  createdUserIds.push(userId);
  const na = await query<{ id: string }>(
    `INSERT INTO accounts (user_id, display_name, handle, balance_minor, is_external)
     VALUES ($1, 'E2E Revoke', $2, 100000, false) RETURNING id`,
    [userId, `e2e-revoke-${stamp}`]
  );
  createdAccountIds.push(na.rows[0].id);

  const eCred = createSoftCredential(userId);
  createdCredIds.push(eCred.credentialId);
  await query(
    `INSERT INTO credentials (id, user_id, public_key, counter, device_type, backed_up, transports)
     VALUES ($1, $2, $3, 0, 'singleDevice', false, '{internal}')`,
    [eCred.credentialId, userId, eCred.cosePublicKey]
  );

  const ashaCookie = cookie;
  try {
    const opts = await apiCall('POST', '/auth/login/options', { email });
    assert.equal(opts.status, 200, `E: login/options ${JSON.stringify(opts.body)}`);
    const login = await apiCall('POST', '/auth/login/verify', {
      email,
      response: eCred.sign(opts.body.challenge),
    });
    assert.equal(login.status, 200, `E: login ${JSON.stringify(login.body)}`);

    const list = await apiCall('GET', '/credentials');
    assert.ok(
      Array.isArray(list.body) && list.body.some((c: { id: string }) => c.id === eCred.credentialId),
      'E: credential listed'
    );

    const rev = await apiCall('POST', `/credentials/${eCred.credentialId}/revoke`);
    assert.equal(rev.status, 200, `E: revoke ${JSON.stringify(rev.body)}`);

    const a = await initiate();
    const aCh = await apiCall('POST', `/payment/${a.txId}/challenge`);
    expectFail(aCh, 401, 'AUTH_FAILED', 'E (challenge after revoke)');

    // Verify-side guard: issue a challenge while active, revoke, then authorize.
    await query(`UPDATE credentials SET revoked_at = NULL WHERE id = $1`, [eCred.credentialId]);
    const b = await initiate();
    const bCh = await apiCall('POST', `/payment/${b.txId}/challenge`);
    assert.equal(bCh.status, 200, 'E: challenge issued while active');
    const bAssertion = eCred.sign(bCh.body.challenge);
    await query(`UPDATE credentials SET revoked_at = NOW() WHERE id = $1`, [eCred.credentialId]);
    const bAuth = await apiCall('POST', `/payment/${b.txId}/authorize`, {
      assertion: bAssertion,
    });
    expectFail(bAuth, 401, 'AUTH_FAILED', 'E (authorize with revoked credential)');

    assert.equal(await ledgerCount([a.txId, b.txId]), 0, 'E: no money moved');
    console.log('  E · revocation: 401 AUTH_FAILED at challenge issue and at assertion verify');
  } finally {
    cookie = ashaCookie;
    await redis.del(`challenge:login:${userId}`);
  }
}

async function closingInvariant(): Promise<void> {
  const moved = await ledgerCount(createdTxIds);
  assert.equal(moved, 2, `invariant: only the happy path moved money (got ${moved} ledger rows)`);
  console.log('  invariant: exactly one transaction settled; every blocked attempt has an audit row');
}

async function cleanup(): Promise<void> {
  if (KEEP) {
    console.log('  --keep: leaving all state in place');
    return;
  }
  try {
    if (createdTxIds.length) {
      const nonces = await query<{ nonce: string }>(
        'SELECT nonce FROM transactions WHERE id = ANY($1)',
        [createdTxIds]
      );
      await query('DELETE FROM ledger_entries WHERE transaction_id = ANY($1)', [createdTxIds]);
      await query('DELETE FROM audit_logs WHERE transaction_id = ANY($1)', [createdTxIds]);
      await query('DELETE FROM transactions WHERE id = ANY($1)', [createdTxIds]);
      for (const { nonce } of nonces.rows) await redis.del(`nonce:${nonce}`);
      for (const id of createdTxIds) await redis.del(`challenge:auth:${id}`);
    }
    if (createdCredIds.length)
      await query('DELETE FROM credentials WHERE id = ANY($1)', [createdCredIds]);
    if (createdUserIds.length) {
      await query('DELETE FROM audit_logs WHERE user_id = ANY($1)', [createdUserIds]);
      await query('DELETE FROM accounts WHERE id = ANY($1)', [createdAccountIds]);
      await query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    if (ashaAccountId)
      await query('UPDATE accounts SET balance_minor = $2 WHERE id = $1', [ashaAccountId, ashaBalance0.toString()]);
    if (priyaAccountId)
      await query('UPDATE accounts SET balance_minor = $2 WHERE id = $1', [priyaAccountId, priyaBalance0.toString()]);
    if (ashaUserId) {
      // Login audit rows this run wrote for Asha (transaction_id NULL, so not
      // caught by the per-transaction sweep above).
      await query(
        `DELETE FROM audit_logs
          WHERE user_id = $1 AND transaction_id IS NULL AND created_at >= $2`,
        [ashaUserId, STARTED_AT.toISOString()]
      );
      await redis.del(`challenge:login:${ashaUserId}`);
      await redis.del(`ctx:baseline:${ashaUserId}`);
    }
    console.log('  cleanup: rows removed, balances restored');
  } catch (err) {
    console.error('  cleanup FAILED — inspect manually:', (err as Error).message);
  }
}

async function main(): Promise<void> {
  console.log('payment.e2e.ts — end-to-end payment correctness\n');
  await preflight();
  // setup() is INSIDE the try: it inserts a credential and registers it for
  // cleanup before it does anything that can fail. Left outside, a setup
  // failure (a rate-limited login, say) skipped cleanup entirely and leaked a
  // live passkey onto the demo account every time.
  try {
    await setup();
    await scenarioA();
    await scenarioB();
    await scenarioC();
    await scenarioD();
    await scenarioE();
    await closingInvariant();
  } finally {
    await cleanup();
    await redis.quit();
    await pool.end();
  }
  console.log('\npayment.e2e.ts: all scenarios passed');
}

main().catch(async (err) => {
  console.error('\npayment.e2e.ts: FAILED');
  console.error(err);
  try {
    await redis.quit();
    await pool.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
