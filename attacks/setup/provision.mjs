/**
 * One-time setup for the attack suite.
 *
 * Registers a fresh passkey (via a CDP virtual authenticator — see
 * ../lib/webauthn.mjs) for each seeded demo account, logs in, and saves the
 * resulting session cookies plus a few real ids (a settled transaction, a
 * known payee, a never-paid payee) to attacks/.state.json.
 *
 * This is the ONLY script in the suite that needs a browser. Every attack
 * script downstream is plain HTTP against localhost:4000, using the cookies
 * this script produces.
 *
 * Run: npm run setup   (from attacks/)
 */
import * as wa from '../lib/webauthn.mjs';
import { get } from '../lib/api.mjs';
import { saveState } from '../lib/state.mjs';

const USERS = [
  { key: 'asha', email: 'asha@prism.demo' },
  { key: 'priya', email: 'priya@prism.demo' },
];

async function provisionUser(page, context, email) {
  console.log(`[setup] Registering a new passkey for ${email}...`);
  await wa.registerPasskey(page, email);
  console.log(`[setup] Logging in as ${email}...`);
  const { userId } = await wa.login(page, email);
  const cookie = await wa.sessionCookie(context);
  if (!cookie) throw new Error(`No session cookie set after login for ${email}`);
  console.log(`[setup] ${email} -> userId ${userId}, session established.`);
  return { userId, cookie };
}

async function main() {
  const { context, page, close } = await wa.launch();
  const state = { provisionedAt: new Date().toISOString(), users: {} };

  try {
    for (const u of USERS) {
      state.users[u.key] = await provisionUser(page, context, u.email);
    }

    // A real, already-settled transaction for each user (from seed.ts —
    // 20 synthetic payments inserted directly into Postgres). Used by the
    // replay and IDOR attacks so they don't need to complete a live payment.
    for (const u of USERS) {
      const cookie = state.users[u.key].cookie;
      const history = await get('/api/v1/transactions', { cookie });
      const settled = (history.body ?? []).find((t) => t.status === 'SETTLED');
      state.users[u.key].settledTxId = settled?.txId ?? null;
    }

    // Payees, from Asha's point of view: one she has paid before (for a
    // "normal" fresh intent) and one she never has (for context/risk tests).
    const payeesRes = await get('/api/v1/payees', { cookie: state.users.asha.cookie });
    const payees = payeesRes.body ?? [];
    state.knownPayeeAccountId = payees.find((p) => p.knownPayee)?.accountId ?? null;
    state.strangerPayeeAccountId = payees.find((p) => !p.knownPayee)?.accountId ?? null;

    saveState(state);
    console.log('\n[setup] Wrote attacks/.state.json:');
    console.log(
      JSON.stringify(
        {
          asha: { userId: state.users.asha.userId, settledTxId: state.users.asha.settledTxId },
          priya: { userId: state.users.priya.userId, settledTxId: state.users.priya.settledTxId },
          knownPayeeAccountId: state.knownPayeeAccountId,
          strangerPayeeAccountId: state.strangerPayeeAccountId,
        },
        null,
        2
      )
    );
    console.log('\n[setup] Done. You can now run the attack scripts.');
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error('[setup] FAILED:', err.message);
  process.exitCode = 2;
});
