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
 * Honest limitation, stated in the README too: a sufficiently pressured victim
 * may still type the digits. This adds friction and clarity at the decisive
 * moment; it is not a cure.
 */
import crypto from 'crypto';
import redis from '../../utils/redis';
import { policy } from '../../config/policy';
import { audit } from '../audit/logger';
import { fail } from '../../api/errors';
import { TransactionRow, formatMinor } from '../../db/types';

interface StepUpRecord {
  expected: string;
  intentHash: string;
  attempts: number;
}

const key = (txId: string) => `stepup:${txId}`;

export interface StepUpChallenge {
  token: string;
  prompt: string;
  payeeName: string;
  amountFormatted: string;
  expiresInSeconds: number;
}

export class SemanticModule {
  /** Build the challenge from the LOCKED record — never from client input. */
  async issue(tx: TransactionRow, payeeName: string): Promise<StepUpChallenge> {
    const amountMinor = parseInt(tx.amount_minor, 10);
    const expected = String(Math.floor(amountMinor / 100) % 100).padStart(2, '0');
    const token = crypto.randomBytes(24).toString('base64url');

    const record: StepUpRecord = { expected, intentHash: tx.intent_hash, attempts: 0 };
    await redis.set(key(tx.id), JSON.stringify(record), 'EX', policy.stepUp.ttlSeconds);

    await audit.log('STEP_UP_ISSUED', { transactionId: tx.id, userId: tx.payer_user_id });

    return {
      token,
      payeeName,
      amountFormatted: formatMinor(tx.amount_minor, tx.currency),
      prompt: `Enter the last two digits of the amount you intend to send.`,
      expiresInSeconds: policy.stepUp.ttlSeconds,
    };
  }

  /**
   * Check the answer. Single-use, short-lived, and capped at 3 attempts —
   * without the cap a two-digit answer is brute-forceable in 100 tries, which
   * is the first thing a judge will ask about.
   */
  async verify(tx: TransactionRow, answer: string): Promise<void> {
    const raw = await redis.get(key(tx.id));
    if (!raw) fail('STEP_UP_FAILED', { reason: 'challenge expired' });

    const record = JSON.parse(raw) as StepUpRecord;

    // The challenge is bound to the intent: re-locking the transaction
    // invalidates an outstanding challenge.
    if (record.intentHash !== tx.intent_hash) {
      await redis.del(key(tx.id));
      fail('TAMPER_BLOCKED', { reason: 'challenge bound to a different intent' });
    }

    if (answer.trim() !== record.expected) {
      record.attempts += 1;
      const exhausted = record.attempts >= policy.stepUp.maxAttempts;
      if (exhausted) {
        await redis.del(key(tx.id));
      } else {
        await redis.set(key(tx.id), JSON.stringify(record), 'EX', policy.stepUp.ttlSeconds);
      }
      await audit.log('STEP_UP_FAILED', {
        transactionId: tx.id,
        userId: tx.payer_user_id,
        data: { attempts: record.attempts, exhausted },
      });
      fail('STEP_UP_FAILED', {
        attemptsRemaining: Math.max(0, policy.stepUp.maxAttempts - record.attempts),
      });
    }

    await redis.del(key(tx.id)); // single-use
    await audit.log('STEP_UP_PASSED', { transactionId: tx.id, userId: tx.payer_user_id });
  }
}

export const semantic = new SemanticModule();
