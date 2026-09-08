/**
 * The signed step-up challenge, shared by every caller that can hand one to
 * a paired phone: the web portal's session-authed mint, the phone's own
 * session-less poll (deviceId-authed), and PRISM App's session-authed poll.
 * One signing path so the three callers can never drift into signing
 * different shapes of the same thing.
 *
 * Also owns the Redis acceptance window: the mint call that first asks for a
 * step-up (`/payment/:id/step-up/token` and its PRISM App equivalent) opens
 * it, and `pendingFor` below only re-signs for as long as it is still open —
 * polling on a timer can never keep a stale window alive.
 */
import { query } from '../../db/pool';
import { AccountRow, TransactionRow } from '../../db/types';
import { keyManager } from '../keys/keyManager';
import redis from '../../utils/redis';

/** Marks that an Authenticator code was issued for this transaction, and when. */
export const authWindowKey = (txId: string) => `stepup:auth:${txId}`;

/** Sign the challenge payload the Authenticator app verifies and displays. */
export async function mintChallenge(tx: TransactionRow, ttlSeconds: number): Promise<string> {
  const { rows } = await query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [
    tx.payee_account_id,
  ]);
  const seen = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM transactions
      WHERE payer_user_id = $1 AND payee_account_id = $2 AND status = 'SETTLED'`,
    [tx.payer_user_id, tx.payee_account_id]
  );
  return keyManager.signQrToken(
    {
      txId: tx.id,
      intentHash: tx.intent_hash,
      payee: rows[0]?.display_name ?? 'Unknown',
      payeeIsNew: parseInt(seen.rows[0].n, 10) === 0,
      amountMinor: parseInt(tx.amount_minor, 10),
      currency: tx.currency,
      score: tx.risk_score,
      reasons: tx.risk_reasons,
    },
    ttlSeconds
  );
}

export interface PendingChallenge {
  txId: string;
  token: string;
  expiresInSeconds: number;
}

/**
 * The paired user's live step-up, if any — what lets a phone that never
 * scanned a QR notice one is waiting and jump straight to the code screen.
 * Deliberately re-signs rather than storing the original token: Redis only
 * ever needs to remember that a window is open, not what was in it.
 */
export async function pendingFor(userId: string): Promise<PendingChallenge | null> {
  const { rows } = await query<TransactionRow>(
    `SELECT * FROM transactions
      WHERE payer_user_id = $1 AND status = 'STEP_UP_REQUIRED' AND step_up_mode = 'AUTHENTICATOR'
      ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const tx = rows[0];
  if (!tx) return null;

  const remaining = await redis.ttl(authWindowKey(tx.id));
  if (remaining <= 0) return null;

  const token = await mintChallenge(tx, remaining);
  return { txId: tx.id, token, expiresInSeconds: remaining };
}
