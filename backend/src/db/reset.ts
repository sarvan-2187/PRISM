/**
 * Reset to a clean demo state.  Usage: npm run db:reset
 *
 * Wipes transactions, ledger entries, audit rows and registered passkeys, then
 * reseeds. Use this between full demo rehearsals: the risk engine grades an
 * amount against the payer's LARGEST settled payment, so once a large payment
 * settles the thresholds move and a scenario that blocked before will only
 * step up. Resetting keeps the rehearsal repeatable.
 *
 * Redis keys are left alone; they expire on their own within 15 minutes.
 */
import pool, { query } from './pool';

async function reset() {
  await query('TRUNCATE ledger_entries, audit_logs, transactions, credentials, accounts, users CASCADE');
  console.log('[Reset] Cleared transactions, ledger, audit, passkeys and accounts.');
  console.log('[Reset] Now run: npm run db:seed');
  await pool.end();
}

reset().catch(async (err) => {
  console.error('[Reset] Failed:', err.message);
  await pool.end();
  process.exit(1);
});
