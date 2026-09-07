/**
 * Attack: Insecure Direct Object Reference (IDOR) across users
 *
 * Protection under test: ownership checks on every transaction-scoped route
 * in backend/src/api/routes.ts — e.g.
 *   if (tx.payer_user_id !== req.userId) fail('NOT_FOUND');
 * on GET /payment/:id and GET /transactions/:id/timeline, and the
 * `WHERE id = $1 AND user_id = $2` clause on POST /credentials/:id/revoke.
 * This is what closes scaffold bug C10 (PLAN.md §2.7): the session cookie
 * supplies req.userId server-side, and every query is scoped to it — a
 * client can never widen its own access by editing a path parameter.
 *
 * We are logged in as Asha AND Priya (two real sessions from setup) and try
 * to read/act on each other's records.
 */
import { get, post } from '../lib/api.mjs';
import { loadState } from '../lib/state.mjs';
import * as p from '../lib/print.mjs';

async function tryRead(label, cookie, path) {
  const res = await get(path, { cookie });
  console.log(`    ${label}: -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  return res;
}

async function main() {
  const state = loadState();
  const asha = state.users.asha;
  const priya = state.users.priya;
  if (!asha.settledTxId) {
    throw new Error("Missing Asha's settledTxId — rerun npm run setup");
  }
  // Note: seed.ts only ever makes Asha the payer in the synthetic history
  // (PLAN.md §4, M0 seed) — Priya is a payee, not a payer, so she owns no
  // transactions of her own to target in the other direction. The
  // ownership check is symmetric in the code either way; we test the
  // direction the seed data actually gives us a real transaction for.

  p.section('IDOR — Cross-User Access to Transactions and Credentials');
  p.target('GET', '/api/v1/payment/:id (and /transactions/:id/timeline, /credentials/:id/revoke)');

  let allBlocked = true;

  p.step(`Priya (${priya.userId}) attempting to read Asha's transaction ${asha.settledTxId}`);
  const r3 = await tryRead('GET /payment/:id', priya.cookie, `/api/v1/payment/${asha.settledTxId}`);
  if (!(r3.status === 404 && r3.body?.failureCode === 'NOT_FOUND')) allBlocked = false;

  const r3b = await tryRead(
    'GET /transactions/:id/timeline',
    priya.cookie,
    `/api/v1/transactions/${asha.settledTxId}/timeline`
  );
  if (!(r3b.status === 404 && r3b.body?.failureCode === 'NOT_FOUND')) allBlocked = false;

  p.step("Asha attempting to revoke one of Priya's credentials");
  const priyaCreds = await get('/api/v1/credentials', { cookie: priya.cookie });
  const targetCredId = priyaCreds.body?.[0]?.id;
  if (targetCredId) {
    const r4 = await post(`/api/v1/credentials/${targetCredId}/revoke`, {}, { cookie: asha.cookie });
    console.log(`    POST /credentials/:id/revoke: -> ${r4.status} ${JSON.stringify(r4.body)}`);
    if (!(r4.status === 404 && r4.body?.failureCode === 'NOT_FOUND')) allBlocked = false;

    // Confirm it's untouched: Priya should still see it, not revoked.
    const stillThere = await get('/api/v1/credentials', { cookie: priya.cookie });
    const stillActive = stillThere.body?.some((c) => c.id === targetCredId);
    console.log(`    Verification: Priya's credential still active -> ${stillActive}`);
    if (!stillActive) allBlocked = false;
  } else {
    console.log('    (Priya has no credentials to target — skipping this sub-case)');
  }

  if (allBlocked) {
    p.pass('every cross-user access attempt returned NOT_FOUND; no cross-tenant leakage or mutation');
    p.finish('PASS');
  } else {
    p.vulnerability('At least one cross-user access or mutation succeeded. See the responses above.');
    p.finish('VULNERABILITY');
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exitCode = 2;
});
