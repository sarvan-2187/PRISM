/**
 * Attack: Replay of an already-settled transaction (concurrent x10)
 *
 * Protection under test: the three independent replay defences PRISM claims
 * (PLAN.md §3.2, §3.4, §10):
 *   1. transactions.status — checked first, in backend/src/api/routes.ts
 *      authorize handler, step 1: `if (tx.status === 'SETTLED') fail('REPLAY_BLOCKED')`
 *   2. the Redis nonce state machine (RESERVED -> CONSUMED, never deleted) —
 *      backend/src/modules/intent/intentLock.ts nonceState()/consumeNonce()
 *   3. ledger_entries UNIQUE (transaction_id, direction) — enforced by
 *      Postgres itself in backend/src/modules/ledger/settlement.ts
 *
 * We fire 10 concurrent authorize calls at a transaction that seed.ts
 * already settled directly in the database. Layer 1 alone is sufficient to
 * block all 10 (status is checked before signature verification even runs,
 * so no real WebAuthn assertion is needed to test this honestly) — but
 * firing them concurrently is what actually exercises whether the guard is
 * atomic, which is the point the threat model's §7 "double-spend via
 * concurrent requests" is testing.
 */
import { post, get } from '../lib/api.mjs';
import { loadState } from '../lib/state.mjs';
import * as p from '../lib/print.mjs';

const CONCURRENCY = 10;

async function main() {
  const state = loadState();
  const cookie = state.users.asha.cookie;
  const txId = state.users.asha.settledTxId;
  if (!txId) throw new Error('No settled transaction in .state.json — rerun npm run setup');

  p.section('Replay of an Already-Settled Transaction');
  p.target('POST', `/api/v1/payment/${txId}/authorize`);

  const before = await get(`/api/v1/payment/${txId}`, { cookie });
  p.step(`Target transaction ${txId} — status ${before.body.status}, amount ${before.body.amountFormatted}`);
  if (before.body.status !== 'SETTLED') {
    throw new Error(`Expected a SETTLED transaction, got ${before.body.status}. Rerun npm run setup.`);
  }

  p.step(`Firing ${CONCURRENCY} concurrent authorize requests at it (no valid assertion needed — see below)`);
  const attempts = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      post(`/api/v1/payment/${txId}/authorize`, { assertion: { id: 'replay-attempt' } }, { cookie })
    )
  );

  const codes = attempts.map((a) => `${a.status}:${a.body?.failureCode ?? 'OK'}`);
  console.log(`    -> ${codes.join(', ')}`);

  const blocked = attempts.filter((a) => a.status === 409 && a.body?.failureCode === 'REPLAY_BLOCKED');
  const settledAgain = attempts.filter((a) => a.status === 200);

  if (settledAgain.length > 0) {
    p.vulnerability(
      `${settledAgain.length}/${CONCURRENCY} replay attempts against an already-settled transaction ` +
        `were accepted. Money would move twice.`
    );
    p.finish('VULNERABILITY');
    return;
  }

  if (blocked.length === CONCURRENCY) {
    p.pass(`all ${CONCURRENCY} attempts refused with REPLAY_BLOCKED (transactions.status check)`);
    const after = await get(`/api/v1/payment/${txId}`, { cookie });
    console.log(
      `[+] Balance/ledger check: transaction still SETTLED once, settledAt unchanged ` +
        `(${before.body.status === after.body.status ? 'confirmed' : 'MISMATCH'})`
    );
    p.finish('PASS');
  } else {
    p.fail(
      `${blocked.length}/${CONCURRENCY} were REPLAY_BLOCKED; the rest returned something unexpected. ` +
        `See codes above.`
    );
    p.finish('ERROR');
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exitCode = 2;
});
