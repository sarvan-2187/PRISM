/**
 * Seed data.  Usage: npm run db:seed  (idempotent — safe to re-run)
 *
 * Mirrors the worked example in the architecture explainer so the demo
 * narrative and the documents agree: Asha pays Priya ₹5,000.
 *
 * The synthetic history matters more than it looks. The risk engine's
 * "unusual amount" and "new payee" signals are meaningless without a
 * baseline to deviate from, and a brand-new account would make every
 * payment look equally suspicious. This gives Asha a normal-looking past.
 */
import crypto from 'crypto';
import pool, { query } from './pool';
import { generateNonce } from '../utils/crypto';
import { intentHash } from '../utils/canonical';
import { policy } from '../config/policy';

const rupees = (n: number) => n * 100;

async function seed() {
  const existing = await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
  if (parseInt(existing.rows[0].count, 10) > 0) {
    console.log('[Seed] Users already present — nothing to do.');
    return;
  }

  // ── People ──────────────────────────────────────────────────────────
  const { rows: users } = await query<{ id: string; email: string }>(
    `INSERT INTO users (email, display_name) VALUES
       ('asha@prism.demo',  'Asha Menon'),
       ('priya@prism.demo', 'Priya Sharma')
     RETURNING id, email`
  );
  const asha = users.find((u) => u.email === 'asha@prism.demo')!;
  const priya = users.find((u) => u.email === 'priya@prism.demo')!;

  // ── Accounts ────────────────────────────────────────────────────────
  // Two known payees Asha has paid before, plus one external stranger the
  // risk engine has never seen — that stranger is the QR-swap / scam-call
  // recipient in the attack demos.
  // Two payees Asha pays regularly, and three she has never paid. The
  // strangers are what make the risk demo work: a never-paid recipient is the
  // strongest single signal the engine has, so the same amount to Priya and to
  // RAJESH K reaches two different decisions.
  const { rows: accounts } = await query<{ id: string; handle: string }>(
    `INSERT INTO accounts (user_id, display_name, handle, balance_minor, is_external) VALUES
       ($1, 'Asha Menon',       'asha@prism',    $3, FALSE),
       ($2, 'Priya Sharma',     'priya@prism',   $4, FALSE),
       (NULL, 'Kumar Stores',   'kumar@prism',   $5, TRUE),
       (NULL, 'Meena Electricals','meena@prism', $5, TRUE),
       (NULL, 'RAJESH K',       'rajesh@prism',  0,  TRUE),
       (NULL, 'SafeAccount Verify','safeacct@prism', 0, TRUE)
     RETURNING id, handle`,
    [asha.id, priya.id, rupees(120000), rupees(8000), rupees(15000)]
  );
  const byHandle = Object.fromEntries(accounts.map((a) => [a.handle, a.id]));

  // ── Synthetic history ───────────────────────────────────────────────
  // ~20 settled payments over the last 60 days: small amounts, two familiar
  // payees, evenings and weekday afternoons. This is Asha's "normal".
  const knownPayees = [byHandle['priya@prism'], byHandle['kumar@prism']];
  let seeded = 0;

  for (let i = 0; i < 20; i++) {
    const daysAgo = 60 - i * 3;
    const at = new Date(Date.now() - daysAgo * 86400_000);
    at.setHours(18 + (i % 4), 30, 0, 0); // evenings, the way she actually pays
    const amountMinor = rupees(200 + ((i * 137) % 1800)); // ₹200–₹2,000
    const payee = knownPayees[i % knownPayees.length];
    const nonce = generateNonce();
    const createdAt = Math.floor(at.getTime() / 1000);

    const txId = crypto.randomUUID();
    const hash = intentHash({
      amountMinor,
      createdAt,
      currency: policy.currency,
      expiresAt: createdAt + policy.intentTtlSeconds,
      lockVersion: 1,
      nonce,
      payeeAccountId: payee,
      payerUserId: asha.id,
      txId,
    });

    await query(
      `INSERT INTO transactions
         (id, payer_user_id, payer_account_id, payee_account_id, amount_minor,
          currency, intent_hash, nonce, created_at, expires_at, status,
          risk_score, risk_reasons, settled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SETTLED',5,'[]',$9)`,
      [
        txId,
        asha.id,
        byHandle['asha@prism'],
        payee,
        amountMinor,
        policy.currency,
        hash,
        nonce,
        at,
        new Date(at.getTime() + policy.intentTtlSeconds * 1000),
      ]
    );

    await query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, settled_at)
       VALUES ($1,$2,'DEBIT',$3,$4), ($1,$5,'CREDIT',$3,$4)`,
      [txId, byHandle['asha@prism'], amountMinor, at, payee]
    );
    seeded++;
  }

  console.log('[Seed] Done.');
  console.log(`  users:        Asha Menon (asha@prism.demo), Priya Sharma (priya@prism.demo)`);
  console.log(`  accounts:     asha@prism ₹1,20,000 · priya@prism ₹8,000`);
  console.log(`                known payees:  kumar@prism · meena@prism`);
  console.log(`                never paid:    rajesh@prism · safeacct@prism`);
  console.log(`  history:      ${seeded} settled payments over 60 days, ₹200–₹2,000, evenings`);
}

seed()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[Seed] Failed:', err.message);
    await pool.end();
    process.exit(1);
  });
