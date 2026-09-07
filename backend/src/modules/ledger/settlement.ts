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
import { getClient, query } from '../../db/pool';
import { SettlementCapabilityRow, TransactionRow } from '../../db/types';
import { audit } from '../audit/logger';
import { fail, PrismError } from '../../api/errors';
import { attestationChain } from '../attestation/chain';
import { intentLock } from '../intent/intentLock';

export interface SettlementResult {
  settledAt: Date;
  payerBalanceMinor: number;
  mode: 'NORMAL' | 'DURESS';
}

/** Handle of the account duress-held funds are parked in. Resolved once. */
let quarantineAccountId: string | null = null;
async function quarantineAccount(): Promise<string> {
  if (!quarantineAccountId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM accounts WHERE handle = 'quarantine@prism'`
    );
    if (!rows[0]) throw new Error('quarantine account missing — run migration 002');
    quarantineAccountId = rows[0].id;
  }
  return quarantineAccountId;
}

export class SettlementModule {
  /**
   * Debit the payer, credit the destination, flip the status — all or nothing.
   *
   * A payment reaches this method only with a settlement capability: a MAC'd
   * record minted from a complete, verified authorization chain. This method
   * re-verifies that chain and CONSUMES the capability inside the same
   * transaction as the ledger write, so "was this payment authorized" is
   * answered from durable state at the instant the money moves — not by
   * trusting the caller. Skipping a control upstream is now a failed chain
   * verification here, not a missed code review.
   *
   * DURESS mode: the payer is genuinely debited (so the receipt is honest and
   * the observer sees a normal balance), but the credit goes to the quarantine
   * account instead of the payee, and status is DURESS_HELD.
   */
  async settle(tx: TransactionRow, cap: SettlementCapabilityRow): Promise<SettlementResult> {
    // Cheap cryptographic checks first, before taking any lock.
    attestationChain.verifyCapabilityShape(cap);
    if (cap.transaction_id !== tx.id) {
      fail('CAPABILITY_INVALID', { reason: 'capability is for a different transaction' });
    }
    if (!intentLock.verifyHash(tx, cap.intent_hash)) {
      fail('CAPABILITY_INVALID', { reason: 'capability intent hash does not match the record' });
    }

    const amount = parseInt(tx.amount_minor, 10);
    const duress = cap.mode === 'DURESS';
    const destId = duress ? await quarantineAccount() : tx.payee_account_id;
    const [firstId, secondId] = [tx.payer_account_id, destId].sort();

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Plain FOR UPDATE, not NOWAIT: a concurrent duplicate should queue and
      // then fail below, rather than erroring on lock contention.
      await client.query('SELECT id FROM accounts WHERE id IN ($1,$2) ORDER BY id FOR UPDATE', [
        firstId,
        secondId,
      ]);

      const { rows: current } = await client.query<{ status: string }>(
        'SELECT status FROM transactions WHERE id = $1 FOR UPDATE',
        [tx.id]
      );
      const st = current[0]?.status;
      if (st === 'SETTLED' || st === 'DURESS_HELD') {
        throw new PrismError(409, 'REPLAY_BLOCKED', 'This payment has already been processed.');
      }

      // Re-verify the chain against a fresh recompute, under the row lock.
      const chain = await attestationChain.verify(tx.id, cap.attempt, tx.intent_hash, { client });
      if (!chain.ok) fail('CHAIN_INVALID', { reason: chain.reason });
      if (chain.tipHash !== cap.chain_tip_hash) {
        fail('CHAIN_INVALID', { reason: 'chain tip moved since the capability was minted' });
      }
      const missing = cap.required_stages.filter((s) => !chain.stagesPresent.includes(s as never));
      if (missing.length > 0) {
        fail('CHAIN_INCOMPLETE', { reason: `missing: ${missing.join(', ')}`, missing });
      }

      // Consume the capability. Zero rows updated = someone else consumed it
      // first (or it was consumed and this is a replay). This is replay
      // defence layer 3, DB-enforced, in the same transaction as the money.
      const { rowCount: consumed } = await client.query(
        `UPDATE settlement_capabilities SET consumed_at = NOW()
          WHERE id = $1 AND consumed_at IS NULL`,
        [cap.id]
      );
      if (!consumed) fail('REPLAY_BLOCKED', { reason: 'settlement capability already consumed' });

      const { rows: payer } = await client.query<{ balance_minor: string }>(
        'SELECT balance_minor FROM accounts WHERE id = $1',
        [tx.payer_account_id]
      );
      if (parseInt(payer[0].balance_minor, 10) < amount) {
        throw new PrismError(402, 'INSUFFICIENT_FUNDS', 'Insufficient balance.');
      }

      const { rows: debited } = await client.query<{ balance_minor: string }>(
        'UPDATE accounts SET balance_minor = balance_minor - $2 WHERE id = $1 RETURNING balance_minor',
        [tx.payer_account_id, amount]
      );
      await client.query('UPDATE accounts SET balance_minor = balance_minor + $2 WHERE id = $1', [
        destId,
        amount,
      ]);

      // UNIQUE (transaction_id, direction) — layer 4, fires if this tx ever settled.
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor)
         VALUES ($1,$2,'DEBIT',$4), ($1,$3,'CREDIT',$4)`,
        [tx.id, tx.payer_account_id, destId, amount]
      );

      await client.query(
        `UPDATE transactions SET status = $2, settled_at = NOW() WHERE id = $1`,
        [tx.id, duress ? 'DURESS_HELD' : 'SETTLED']
      );

      if (duress) {
        await client.query(
          `INSERT INTO duress_alerts (transaction_id, user_id) VALUES ($1, $2)
           ON CONFLICT (transaction_id) DO NOTHING`,
          [tx.id, tx.payer_user_id]
        );
      }

      await client.query('COMMIT');

      await audit.log(duress ? 'DURESS_TRIGGERED' : 'PAYMENT_SETTLED', {
        transactionId: tx.id,
        userId: tx.payer_user_id,
        data: { amountMinor: amount, mode: cap.mode },
      });

      return {
        settledAt: new Date(),
        payerBalanceMinor: parseInt(debited[0].balance_minor, 10),
        mode: cap.mode,
      };
    } catch (err) {
      await client.query('ROLLBACK');
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
