/**
 * Payment Ledger — move the money correctly, exactly once.
 *
 * Authentication decides *whether* money should move; this decides *how*.
 * Without atomicity a crash between debit and credit destroys or duplicates
 * money — a correctness failure no amount of authentication strength repairs.
 *
 * This is also the final, independent replay defence. Even a perfectly forged
 * approval cannot settle twice, because ledger_entries carries a UNIQUE
 * constraint on (transaction_id, direction). That is enforced by the database,
 * not by the code path above it.
 */
import { getClient } from '../../db/pool';
import { TransactionRow } from '../../db/types';
import { audit } from '../audit/logger';
import { fail, PrismError } from '../../api/errors';

export interface SettlementResult {
  settledAt: Date;
  payerBalanceMinor: number;
}

export class SettlementModule {
  /**
   * Debit the payer, credit the payee, flip the status — all or nothing.
   *
   * Accounts are locked in a deterministic order (by id) so two payments
   * between the same pair in opposite directions cannot deadlock.
   */
  async settle(tx: TransactionRow): Promise<SettlementResult> {
    const client = await getClient();
    const amount = parseInt(tx.amount_minor, 10);
    const [firstId, secondId] = [tx.payer_account_id, tx.payee_account_id].sort();

    try {
      await client.query('BEGIN');

      // Plain FOR UPDATE, not NOWAIT: a concurrent duplicate should queue and
      // then fail the status check, rather than erroring on lock contention.
      await client.query('SELECT id FROM accounts WHERE id IN ($1,$2) ORDER BY id FOR UPDATE', [
        firstId,
        secondId,
      ]);

      const { rows: current } = await client.query<{ status: string }>(
        'SELECT status FROM transactions WHERE id = $1 FOR UPDATE',
        [tx.id]
      );
      if (current[0]?.status === 'SETTLED') {
        throw new PrismError(409, 'REPLAY_BLOCKED', 'This payment has already been processed.');
      }

      const { rows: payer } = await client.query<{ balance_minor: string }>(
        'SELECT balance_minor FROM accounts WHERE id = $1',
        [tx.payer_account_id]
      );
      const balance = parseInt(payer[0].balance_minor, 10);
      if (balance < amount) {
        throw new PrismError(402, 'INSUFFICIENT_FUNDS', 'Insufficient balance.');
      }

      const { rows: debited } = await client.query<{ balance_minor: string }>(
        'UPDATE accounts SET balance_minor = balance_minor - $2 WHERE id = $1 RETURNING balance_minor',
        [tx.payer_account_id, amount]
      );
      await client.query(
        'UPDATE accounts SET balance_minor = balance_minor + $2 WHERE id = $1',
        [tx.payee_account_id, amount]
      );

      // The UNIQUE (transaction_id, direction) constraint fires here if this
      // transaction has ever settled before.
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor)
         VALUES ($1,$2,'DEBIT',$4), ($1,$3,'CREDIT',$4)`,
        [tx.id, tx.payer_account_id, tx.payee_account_id, amount]
      );

      await client.query(
        `UPDATE transactions SET status = 'SETTLED', settled_at = NOW() WHERE id = $1`,
        [tx.id]
      );

      await client.query('COMMIT');

      await audit.log('PAYMENT_SETTLED', {
        transactionId: tx.id,
        userId: tx.payer_user_id,
        data: { amountMinor: amount },
      });

      // Balance captured by the debit UPDATE above, inside the committed
      // transaction — it is this payment's result, not a later concurrent state.
      return {
        settledAt: new Date(),
        payerBalanceMinor: parseInt(debited[0].balance_minor, 10),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      // A unique violation here means a concurrent request already settled it.
      if ((err as { code?: string }).code === '23505') {
        fail('REPLAY_BLOCKED', { reason: 'settlement already recorded' });
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export const settlement = new SettlementModule();
