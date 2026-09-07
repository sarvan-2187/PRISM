/**
 * Small read-only helpers the attack engine uses to pick real, existing
 * accounts/payees/transactions to target — never fabricated ids.
 */
import { query } from '../../db/pool';
import { AccountRow, TransactionRow, UserRow } from '../../db/types';

export async function getUser(userId: string): Promise<UserRow> {
  const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!rows[0]) throw new Error(`No such user: ${userId}`);
  return rows[0];
}

export async function getPrimaryAccount(userId: string): Promise<AccountRow> {
  const { rows } = await query<AccountRow>(
    'SELECT * FROM accounts WHERE user_id = $1 ORDER BY created_at LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw new Error(`No account for user ${userId}`);
  return rows[0];
}

/** A payee this user has already settled a payment to — keeps the risk engine calm. */
export async function getKnownPayee(userId: string): Promise<AccountRow | null> {
  const { rows } = await query<AccountRow>(
    `SELECT a.* FROM accounts a
       JOIN transactions t ON t.payee_account_id = a.id AND t.status = 'SETTLED'
      WHERE t.payer_user_id = $1
      ORDER BY t.created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

/** A payee this user has never paid — reliably trips NEW_PAYEE / NO_BASELINE. */
export async function getNeverPaidPayee(userId: string): Promise<AccountRow | null> {
  const { rows } = await query<AccountRow>(
    `SELECT a.* FROM accounts a
      WHERE a.user_id IS DISTINCT FROM $1
        AND NOT EXISTS (
          SELECT 1 FROM transactions t
           WHERE t.payer_user_id = $1 AND t.payee_account_id = a.id AND t.status = 'SETTLED'
        )
      ORDER BY a.created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

export async function getMostRecentSettledTransaction(userId: string): Promise<TransactionRow | null> {
  const { rows } = await query<TransactionRow>(
    `SELECT * FROM transactions WHERE payer_user_id = $1 AND status = 'SETTLED'
      ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

export async function getTransaction(txId: string): Promise<TransactionRow> {
  const { rows } = await query<TransactionRow>('SELECT * FROM transactions WHERE id = $1', [txId]);
  if (!rows[0]) throw new Error(`No such transaction: ${txId}`);
  return rows[0];
}

/** A different real user than the one given — used as the attacker identity for IDOR. */
export async function getAnotherUser(excludeUserId: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>('SELECT * FROM users WHERE id <> $1 ORDER BY created_at LIMIT 1', [
    excludeUserId,
  ]);
  return rows[0] ?? null;
}

export interface LiveTransactionRow {
  id: string;
  payer_user_id: string;
  payer_email: string;
  payer_name: string;
  payee_name: string;
  payee_handle: string;
  amount_minor: string;
  status: string;
  created_at: Date;
  settled_at: Date | null;
}

/**
 * Real, currently-observable transactions: anything not yet in a terminal
 * state, plus anything settled in the last 10 minutes so a just-completed
 * payment stays selectable for the replay scenario. Read directly off the
 * same `transactions` table every ordinary page reads — nothing here is
 * synthesized, and a transaction created by an actual browser (Laptop 1/2)
 * appears exactly the same way one created by the Lab's own "run legitimate
 * transaction" helper does.
 */
export async function getLiveTransactions(): Promise<LiveTransactionRow[]> {
  const { rows } = await query<LiveTransactionRow>(
    `SELECT t.id, t.payer_user_id, u.email AS payer_email, u.display_name AS payer_name,
            payee.display_name AS payee_name, payee.handle AS payee_handle,
            t.amount_minor, t.status, t.created_at, t.settled_at
       FROM transactions t
       JOIN users u ON u.id = t.payer_user_id
       JOIN accounts payee ON payee.id = t.payee_account_id
      WHERE t.status IN ('PENDING', 'STEP_UP_REQUIRED')
         OR (t.status = 'SETTLED' AND t.settled_at > NOW() - INTERVAL '10 minutes')
      ORDER BY t.created_at DESC
      LIMIT 25`
  );
  return rows;
}

/** The real registered, non-revoked credential id for a user — id only, never the key. */
export async function getActiveCredentialId(userId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM credentials WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0]?.id ?? null;
}

export async function listTargetUsers(): Promise<
  Array<{ userId: string; email: string; displayName: string; balanceFormatted: string }>
> {
  const { rows } = await query<{
    id: string;
    email: string;
    display_name: string;
    balance_minor: string;
  }>(
    `SELECT u.id, u.email, u.display_name, a.balance_minor
       FROM users u
       JOIN accounts a ON a.user_id = u.id
      ORDER BY u.created_at`
  );
  const { formatMinor } = await import('../../db/types');
  return rows.map((r) => ({
    userId: r.id,
    email: r.email,
    displayName: r.display_name,
    balanceFormatted: formatMinor(r.balance_minor),
  }));
}
