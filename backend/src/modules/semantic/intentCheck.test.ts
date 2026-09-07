/**
 * Semantic step-up attempt cap.   Run: npm run test:semantic     OWNER: S2
 *
 * This exists because of a real bug. The first version kept the attempt
 * counter inside the challenge record, so re-authorizing issued a fresh
 * challenge with attempts back at zero — roughly 34 re-approvals covered all
 * 100 two-digit answers, and the control PRISM claims as its answer to
 * social-engineering fraud was decorative.
 *
 * The last case below is the one that matters: it re-issues after every wrong
 * answer, exactly as the bypass did, and asserts the guessing still stops.
 *
 * Needs Redis and Postgres running: docker compose up -d
 */
import assert from 'node:assert/strict';
import crypto from 'crypto';
import redis from '../../utils/redis';
import pool, { query } from '../../db/pool';
import { policy } from '../../config/policy';
import { semantic } from './intentCheck';
import { PrismError } from '../../api/errors';
import { TransactionRow } from '../../db/types';

/** Insert a throwaway PENDING transaction so the cap has something to block. */
async function makeTx(amountMinor: number): Promise<TransactionRow> {
  const { rows: accounts } = await query<{ id: string; user_id: string | null }>(
    `SELECT id, user_id FROM accounts ORDER BY is_external, handle LIMIT 2`
  );
  const payer = accounts.find((a) => a.user_id)!;
  const payee = accounts.find((a) => a.id !== payer.id)!;

  const { rows } = await query<TransactionRow>(
    `INSERT INTO transactions
       (payer_user_id, payer_account_id, payee_account_id, amount_minor,
        currency, intent_hash, nonce, expires_at, status)
     VALUES ($1,$2,$3,$4,'INR',$5,$6, NOW() + interval '10 minutes','PENDING')
     RETURNING *`,
    [
      payer.user_id,
      payer.id,
      payee.id,
      amountMinor,
      `test-${crypto.randomUUID()}`,
      `test-${crypto.randomUUID()}`,
    ]
  );
  return rows[0];
}

async function cleanup(txId: string) {
  await redis.del(`stepup:${txId}`, `stepup:attempts:${txId}`);
  await query('DELETE FROM audit_logs WHERE transaction_id = $1', [txId]);
  await query('DELETE FROM transactions WHERE id = $1', [txId]);
}

async function expectFailure(fn: () => Promise<unknown>, code: string, label: string) {
  try {
    await fn();
    assert.fail(`${label}: expected ${code}, but it succeeded`);
  } catch (err) {
    assert.ok(err instanceof PrismError, `${label}: expected PrismError, got ${String(err)}`);
    assert.equal(err.failureCode, code, label);
    return err;
  }
}

async function statusOf(txId: string): Promise<string> {
  const { rows } = await query<{ status: string; failure_code: string | null }>(
    'SELECT status, failure_code FROM transactions WHERE id = $1',
    [txId]
  );
  return `${rows[0].status}/${rows[0].failure_code ?? '-'}`;
}

async function run() {
  console.log('\nSemantic step-up');
  console.log(`  maxAttempts = ${policy.stepUp.maxAttempts} per TRANSACTION\n`);

  // ── 1. The correct answer passes ────────────────────────────────────
  // ₹5,000 -> "5000" -> last two digits "00".
  {
    const tx = await makeTx(500_000);
    const challenge = await semantic.issue(tx, 'Priya Sharma');
    assert.equal(challenge.attemptsRemaining, 3);
    assert.match(challenge.amountFormatted, /5,000/);
    await semantic.verify(tx, '00');
    console.log('  ✓ correct answer passes, challenge consumed');

    // Single-use: the same answer cannot be replayed against a spent challenge.
    await expectFailure(() => semantic.verify(tx, '00'), 'STEP_UP_FAILED', 'replayed challenge');
    console.log('  ✓ a consumed challenge cannot be reused');
    await cleanup(tx.id);
  }

  // ── 2. Three wrong answers exhaust and block ────────────────────────
  {
    const tx = await makeTx(4_800_000); // ₹48,000 -> expects "00"
    await semantic.issue(tx, 'RAJESH K');

    for (let i = 1; i <= policy.stepUp.maxAttempts; i++) {
      const err = await expectFailure(
        () => semantic.verify(tx, '99'),
        'STEP_UP_FAILED',
        `wrong answer ${i}`
      );
      assert.equal(
        (err.details as { attemptsRemaining: number }).attemptsRemaining,
        policy.stepUp.maxAttempts - i,
        `attemptsRemaining after ${i} wrong`
      );
      if (i < policy.stepUp.maxAttempts) await semantic.issue(tx, 'RAJESH K');
    }

    assert.equal(await statusOf(tx.id), 'BLOCKED/STEP_UP_FAILED');
    console.log('  ✓ 3 wrong answers block the transaction terminally');

    // ── 3. No reset path: even the correct answer is refused now ──────
    const fresh = { ...tx, status: 'BLOCKED' as const };
    await expectFailure(() => semantic.issue(fresh, 'RAJESH K'), 'STEP_UP_FAILED', 're-issue');
    await expectFailure(() => semantic.verify(fresh, '00'), 'STEP_UP_FAILED', 'correct answer');
    console.log('  ✓ exhausted transaction refuses both re-issue and the right answer');
    await cleanup(tx.id);
  }

  // ── 4. THE REGRESSION: brute force with re-issue between guesses ────
  // This is exactly what the bypass did. Every wrong answer is followed by a
  // fresh challenge, the way re-authorizing used to hand one out.
  {
    const tx = await makeTx(1_234_500); // ₹12,345 -> expects "45"
    let accepted = 0;
    let refused = 0;

    for (let guess = 0; guess < 100; guess++) {
      try {
        await semantic.issue(tx, 'RAJESH K');
      } catch {
        refused++;
        continue; // cap refuses to issue — correct behaviour
      }
      try {
        await semantic.verify(tx, String(guess).padStart(2, '0'));
        accepted++;
      } catch {
        refused++;
      }
    }

    assert.equal(accepted, 0, 'no guess may be accepted once the cap is spent');
    assert.equal(refused, 100, 'every one of the 100 guesses must be refused');
    assert.equal(await statusOf(tx.id), 'BLOCKED/STEP_UP_FAILED');

    const used = await semantic.attemptCount(tx.id);
    assert.equal(used, policy.stepUp.maxAttempts, 'counter must stop at the cap, not run to 100');
    console.log(`  ✓ 100 guesses with re-issue between each: 0 accepted, cap held at ${used}`);
    await cleanup(tx.id);
  }

  console.log('\nintentCheck.test.ts: all assertions passed\n');
}

run()
  .then(async () => {
    await pool.end();
    redis.disconnect();
  })
  .catch(async (err) => {
    console.error('\nFAILED:', err.message);
    await pool.end();
    redis.disconnect();
    process.exit(1);
  });
