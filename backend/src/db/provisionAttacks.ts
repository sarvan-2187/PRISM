/**
 * Headless attack-suite provisioner.  Usage:  npm run provision:attacks
 *
 * Does what attacks/setup/provision.mjs does but with the software
 * authenticator instead of Playwright: registers a passkey for Asha and Priya,
 * logs them in, and writes attacks/.state.json with their session cookies plus
 * the ids the attacks need. No browser required.
 *
 * The same asha cookie it writes can be pasted into the browser devtools
 * (Application -> Cookies -> localhost:5173 -> prism_session) so the sender's
 * Timeline is viewable while the attacks run against the very same session.
 */
import fs from 'fs';
import path from 'path';
import pool, { query } from './pool';
import { config } from '../config/env';
import { createSoftCredential } from '../modules/identity/softAuthenticator';

const API = `http://localhost:${config.port}/api/v1`;
const STATE_PATH = path.join(__dirname, '..', '..', '..', 'attacks', '.state.json');

async function api(
  method: string,
  route: string,
  body?: unknown,
  cookie?: string
): Promise<{ status: number; body: any; cookie: string | null }> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  const m = sc && /prism_session=[^;]+/.exec(sc);
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* text */
  }
  return { status: res.status, body: parsed, cookie: m ? m[0] : null };
}

async function provision(email: string): Promise<{ userId: string; cookie: string }> {
  const u = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (!u.rows[0]) throw new Error(`no user ${email} — run npm run db:seed`);
  const userId = u.rows[0].id;

  // Hold the private key ourselves, so replace whatever passkey is there.
  const cred = createSoftCredential(userId);
  await query('DELETE FROM credentials WHERE user_id = $1', [userId]);
  await query(
    `INSERT INTO credentials (id, user_id, public_key, counter, device_type, backed_up, transports)
     VALUES ($1, $2, $3, 0, 'singleDevice', false, '{internal}')`,
    [cred.credentialId, userId, cred.cosePublicKey]
  );

  const opts = await api('POST', '/auth/login/options', { email });
  if (opts.status !== 200) throw new Error(`login/options ${email}: ${JSON.stringify(opts.body)}`);
  const verify = await api('POST', '/auth/login/verify', {
    email,
    response: cred.sign(opts.body.challenge),
  });
  if (verify.status !== 200 || !verify.cookie) {
    throw new Error(`login/verify ${email}: ${verify.status} ${JSON.stringify(verify.body)}`);
  }
  return { userId, cookie: verify.cookie };
}

async function main(): Promise<void> {
  const redis = (await import('../utils/redis')).default;
  const rl = await redis.keys('rl:*');
  if (rl.length) await redis.del(...rl);

  const asha = await provision('asha@prism.demo');
  const priya = await provision('priya@prism.demo');

  const hist = await api('GET', '/transactions', undefined, asha.cookie);
  const settled = (hist.body ?? []).find((t: any) => t.status === 'SETTLED');
  const histP = await api('GET', '/transactions', undefined, priya.cookie);
  const settledP = (histP.body ?? []).find((t: any) => t.status === 'SETTLED');
  const payees = (await api('GET', '/payees', undefined, asha.cookie)).body ?? [];

  const state = {
    provisionedAt: new Date().toISOString(),
    users: {
      asha: { userId: asha.userId, cookie: asha.cookie, settledTxId: settled?.txId ?? null },
      priya: { userId: priya.userId, cookie: priya.cookie, settledTxId: settledP?.txId ?? null },
    },
    knownPayeeAccountId: payees.find((p: any) => p.knownPayee)?.accountId ?? null,
    strangerPayeeAccountId: payees.find((p: any) => !p.knownPayee)?.accountId ?? null,
  };

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`\n[provision] Wrote ${STATE_PATH}`);
  console.log('[provision] Asha session cookie (paste into browser devtools to watch her Timeline):\n');
  console.log(`    ${asha.cookie}\n`);
  console.log('[provision] Attacks ready:  cd attacks && npm run attack:tamper');
  await redis.quit();
  await pool.end();
}

main().catch(async (err) => {
  console.error('[provision] FAILED:', err);
  await pool.end();
  process.exit(1);
});
