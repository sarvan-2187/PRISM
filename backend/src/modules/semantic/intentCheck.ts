/**
 * Semantic Verification Module.
 *
 * Every other module asks "is this the right person, on the right device,
 * approving the right transaction?" In social-engineering fraud the answer to
 * all three is yes and the money is still stolen. This module is the only one
 * that asks a different question: does the user actually understand what they
 * are about to do?
 *
 * The challenge — type the last two digits of the amount — is deliberately
 * not another biometric prompt. A thumb can be pressed reflexively while a
 * scammer talks. Reading and typing the real number cannot.
 *
 * ── The attempt cap is the load-bearing part ──────────────────────────────
 * A two-digit answer is guessable in 100 tries, so this control is only as
 * strong as its cap. The cap is counted PER TRANSACTION and lives in its own
 * Redis key, deliberately outside the challenge record: an earlier version
 * kept the counter inside the record, so re-authorizing issued a fresh
 * challenge with attempts back at zero and roughly 34 re-approvals covered
 * the whole keyspace. Exhausting the cap now blocks the transaction
 * terminally — there is no reset path, and a genuine user simply starts a
 * new payment.
 *
 * Honest limitation, stated in the README too: a sufficiently pressured
 * victim may still read the digits aloud and type them. This adds friction
 * and clarity at the decisive moment; it is not a cure.
 */
import redis from '../../utils/redis';
import { policy } from '../../config/policy';
import { audit } from '../audit/logger';
import { fail } from '../../api/errors';
import { intentLock } from '../intent/intentLock';
import { TransactionRow, formatMinor } from '../../db/types';

interface StepUpRecord {
  expected: string;
  intentHash: string;
}

const challengeKey = (txId: string) => `stepup:${txId}`;
const attemptsKey = (txId: string) => `stepup:attempts:${txId}`;
const passedKey = (txId: string) => `stepup:passed:${txId}`;

export interface StepUpChallenge {
  prompt: string;
  payeeName: string;
  amountFormatted: string;
  expiresInSeconds: number;
  attemptsRemaining: number;
}

export class SemanticModule {
  /** Wrong answers recorded against this transaction, across all challenges. */
  async attemptCount(txId: string): Promise<number> {
    return parseInt((await redis.get(attemptsKey(txId))) ?? '0', 10);
  }

  /**
   * Build the challenge from the LOCKED record — never from client input.
   * Refuses outright once the transaction's attempts are spent, so re-issuing
   * cannot be used to buy more guesses.
   */
  async issue(tx: TransactionRow, payeeName: string): Promise<StepUpChallenge> {
    const used = await this.attemptCount(tx.id);
    if (used >= policy.stepUp.maxAttempts) {
      await this.exhaust(tx);
      fail('STEP_UP_FAILED', { reason: 'verification attempts exhausted' });
    }

    const amountMinor = parseInt(tx.amount_minor, 10);
    const expected = String(Math.floor(amountMinor / 100) % 100).padStart(2, '0');

    const record: StepUpRecord = { expected, intentHash: tx.intent_hash };
    await redis.set(challengeKey(tx.id), JSON.stringify(record), 'EX', policy.stepUp.ttlSeconds);

    await audit.log('STEP_UP_ISSUED', {
      transactionId: tx.id,
      userId: tx.payer_user_id,
      data: { attemptsUsed: used },
    });

    return {
      payeeName,
      amountFormatted: formatMinor(tx.amount_minor, tx.currency),
      prompt: 'Enter the last two digits of the amount you intend to send.',
      expiresInSeconds: policy.stepUp.ttlSeconds,
      attemptsRemaining: policy.stepUp.maxAttempts - used,
    };
  }

  /**
   * Check the answer. Single-use per issuance, short-lived, and capped across
   * the transaction's whole life.
   */
  async verify(tx: TransactionRow, answer: string): Promise<void> {
    // Cap is checked before anything else, so an exhausted transaction cannot
    // be probed further even if a challenge record somehow survives.
    if ((await this.attemptCount(tx.id)) >= policy.stepUp.maxAttempts) {
      await this.exhaust(tx);
      fail('STEP_UP_FAILED', { reason: 'verification attempts exhausted', attemptsRemaining: 0 });
    }

    const raw = await redis.get(challengeKey(tx.id));
    if (!raw) fail('STEP_UP_FAILED', { reason: 'challenge expired' });
    const record = JSON.parse(raw) as StepUpRecord;

    // The challenge is bound to the intent: re-locking the transaction
    // invalidates any outstanding challenge.
    if (record.intentHash !== tx.intent_hash) {
      await redis.del(challengeKey(tx.id));
      fail('TAMPER_BLOCKED', { reason: 'challenge bound to a different intent' });
    }

    if (answer.trim() !== record.expected) {
      // INCR is atomic, so two concurrent wrong answers cannot both read the
      // same count and spend one attempt between them.
      const used = await redis.incr(attemptsKey(tx.id));
      await redis.expire(attemptsKey(tx.id), policy.stepUp.attemptTtlSeconds);

      const exhausted = used >= policy.stepUp.maxAttempts;
      // The challenge survives a wrong answer so a genuine user who mistyped
      // can simply try again. Destroying it per guess protected nothing —
      // the cap is counted per transaction, not per challenge — while forcing
      // an honest payer to re-approve with their passkey to get another go.
      if (exhausted) await redis.del(challengeKey(tx.id));
      await audit.log('STEP_UP_FAILED', {
        transactionId: tx.id,
        userId: tx.payer_user_id,
        data: { attemptsUsed: used, exhausted },
      });

      if (exhausted) await this.exhaust(tx);
      fail('STEP_UP_FAILED', {
        attemptsRemaining: Math.max(0, policy.stepUp.maxAttempts - used),
      });
    }

    await redis.del(challengeKey(tx.id)); // single-use

    // Remember that comprehension was verified for THIS transaction. Approval
    // still requires a fresh transaction-bound assertion, and that
    // re-authorization re-runs the risk engine — which would otherwise demand
    // the same check again, forever. The flag is keyed to the transaction, so
    // it cannot carry over to a different payment.
    await redis.set(passedKey(tx.id), '1', 'EX', policy.nonceTtlSeconds);
    await audit.log('STEP_UP_PASSED', { transactionId: tx.id, userId: tx.payer_user_id });
  }

  /** Has this exact transaction already cleared a comprehension check? */
  async hasPassed(txId: string): Promise<boolean> {
    return (await redis.get(passedKey(txId))) === '1';
  }

  /**
   * Terminal refusal. Blocking the transaction is what makes the cap real:
   * without it the payer could re-authorize and be handed a fresh challenge.
   * There is no reset — a genuine user starts a new payment, which is a new
   * intent with a new hash and a new nonce.
   */
  private async exhaust(tx: TransactionRow): Promise<void> {
    await redis.del(challengeKey(tx.id));
    if (tx.status !== 'BLOCKED') {
      await intentLock.markFailed(tx.id, 'STEP_UP_FAILED', 'BLOCKED');
      await audit.log('PAYMENT_BLOCKED', {
        transactionId: tx.id,
        userId: tx.payer_user_id,
        data: { failureCode: 'STEP_UP_FAILED', reason: 'semantic attempts exhausted' },
      });
    }
  }
}

export const semantic = new SemanticModule();
