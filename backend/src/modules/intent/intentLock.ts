/**
 * Intent-Lock Module — the heart of PRISM.
 *
 * Freezes a transaction into an immutable record, hashes it, and hands back
 * a hash that becomes the WebAuthn challenge. That single move converts a
 * signature meaning "I am Asha" into one meaning "I, Asha, approve exactly
 * ₹5,000 to exactly Priya, in transaction txn_91f".
 *
 * Nothing in the hashed set is ever UPDATEd. Changing an amount does not edit
 * a transaction — it creates a new one with a new id, nonce and hash, which is
 * precisely why a captured assertion cannot be replayed against altered
 * details.
 */
import crypto from 'crypto';
import { query, getClient } from '../../db/pool';
import redis from '../../utils/redis';
import { generateNonce } from '../../utils/crypto';
import { intentHash, hashesMatch, LockedIntent } from '../../utils/canonical';
import { policy, isDisabled } from '../../config/policy';
import { TransactionRow } from '../../db/types';
import { audit } from '../audit/logger';
import { PrismError } from '../../api/errors';
import { attestationChain } from '../attestation/chain';

export interface LockRequest {
  payerUserId: string;
  payerAccountId: string;
  payeeAccountId: string;
  amountMinor: number;
  /** Set when this intent supersedes an earlier one (an amendment). */
  amendedFrom?: string;
}

export interface LockResult {
  txId: string;
  intentHash: string;
  expiresAt: Date;
}

/** Nonce lifecycle states. Stored in Redis, distinct so failures stay distinct. */
export type NonceState = 'RESERVED' | 'CONSUMED';

const nonceKey = (nonce: string) => `nonce:${nonce}`;

export class IntentLockModule {
  /**
   * Freeze the intent. The nonce is deliberately NOT returned to the client:
   * it has no client-side use, and handing it out only invites experiments.
   */
  async lock(req: LockRequest): Promise<LockResult> {
    if (!Number.isInteger(req.amountMinor) || req.amountMinor <= 0) {
      throw new PrismError(400, 'INVALID_AMOUNT', 'Amount must be a positive integer in paise.');
    }

    const txId = crypto.randomUUID();
    const nonce = generateNonce();
    const createdAt = Math.floor(Date.now() / 1000);
    const expiresAt = createdAt + policy.intentTtlSeconds;

    const intent: LockedIntent = {
      amountMinor: req.amountMinor,
      createdAt,
      currency: policy.currency,
      expiresAt,
      lockVersion: 1,
      nonce,
      payeeAccountId: req.payeeAccountId,
      payerUserId: req.payerUserId,
      txId,
    };
    const hash = intentHash(intent);

    // Insert the row and write the chain root (INTENT_LOCKED, rooted in the
    // intent hash) in one transaction: a transaction without its chain root, or
    // a chain root without its transaction, is not a state the system can act on.
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO transactions
           (id, payer_user_id, payer_account_id, payee_account_id, amount_minor,
            currency, intent_hash, nonce, lock_version, created_at, expires_at, status, amended_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,to_timestamp($9),to_timestamp($10),'PENDING',$11)`,
        [
          txId,
          req.payerUserId,
          req.payerAccountId,
          req.payeeAccountId,
          req.amountMinor,
          policy.currency,
          hash,
          nonce,
          createdAt,
          expiresAt,
          req.amendedFrom ?? null,
        ]
      );
      await attestationChain.append(
        txId,
        'INTENT_LOCKED',
        {
          amountMinor: req.amountMinor,
          payeeAccountId: req.payeeAccountId,
          currency: policy.currency,
          createdAt,
          expiresAt,
          amendedFrom: req.amendedFrom ?? null,
        },
        { client }
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Replay defence layer 1. RESERVED now, CONSUMED at settlement — never
    // deleted, because a missing key is indistinguishable from an expired one
    // and the failure catalogue needs REPLAY_BLOCKED separate from
    // INTENT_EXPIRED.
    await redis.set(nonceKey(nonce), 'RESERVED', 'EX', policy.nonceTtlSeconds);

    await audit.log('INTENT_LOCKED', {
      transactionId: txId,
      userId: req.payerUserId,
      data: { amountMinor: req.amountMinor, payeeAccountId: req.payeeAccountId, intentHash: hash },
    });

    return { txId, intentHash: hash, expiresAt: new Date(expiresAt * 1000) };
  }

  /** Load a transaction, or 404. */
  async get(txId: string): Promise<TransactionRow> {
    const { rows } = await query<TransactionRow>('SELECT * FROM transactions WHERE id = $1', [txId]);
    if (!rows[0]) throw new PrismError(404, 'NOT_FOUND', 'No such transaction.');
    return rows[0];
  }

  /**
   * Recompute the hash from what the database actually holds and compare it
   * against the value the client is asking us to honour.
   *
   * This is the check that catches transaction tampering: the attacker holds a
   * genuine signature over the original hash, but the record they want settled
   * hashes to something else.
   */
  verifyHash(tx: TransactionRow, claimedHash: string): boolean {
    if (isDisabled('intentLock')) return true; // demo-only; see policy.ts

    const recomputed = intentHash({
      amountMinor: parseInt(tx.amount_minor, 10),
      createdAt: Math.floor(tx.created_at.getTime() / 1000),
      currency: tx.currency,
      expiresAt: Math.floor(tx.expires_at.getTime() / 1000),
      lockVersion: tx.lock_version,
      nonce: tx.nonce,
      payeeAccountId: tx.payee_account_id,
      payerUserId: tx.payer_user_id,
      txId: tx.id,
    });
    return hashesMatch(recomputed, tx.intent_hash) && hashesMatch(recomputed, claimedHash);
  }

  /** Has the 90-second window closed? */
  isExpired(tx: TransactionRow): boolean {
    if (isDisabled('expiryGuard')) return false;
    return tx.expires_at.getTime() <= Date.now();
  }

  async nonceState(nonce: string): Promise<NonceState | null> {
    if (isDisabled('replayGuard')) return 'RESERVED';
    return (await redis.get(nonceKey(nonce))) as NonceState | null;
  }

  /** Called exactly once, at settlement. Marked, never deleted. */
  async consumeNonce(nonce: string): Promise<void> {
    await redis.set(nonceKey(nonce), 'CONSUMED', 'EX', policy.nonceTtlSeconds);
  }

  /**
   * Record a terminal refusal against the transaction.
   *
   * Guarded so a refusal can never overwrite an already-terminal state. The
   * unguarded version could flip a SETTLED transaction to BLOCKED while the
   * ledger entries and the moved balances stayed exactly where they were —
   * a settled payment that reads as refused, with the money gone. `settle()`
   * holds a row lock; this write did not, so the two could interleave.
   */
  async markFailed(txId: string, failureCode: string, status: 'BLOCKED' | 'EXPIRED'): Promise<void> {
    await query(
      `UPDATE transactions SET status = $2, failure_code = $3
        WHERE id = $1 AND status <> 'SETTLED'`,
      [txId, status, failureCode]
    );
  }
}

export const intentLock = new IntentLockModule();
