/**
 * Real device sessions for the Attack Simulation Dashboard.
 *
 * A "legitimate device" in a scenario is a real PRISM session: a real
 * Ed25519 WebAuthn credential (via the headless softAuthenticator — the same
 * test-support module payment.e2e.ts uses to exercise the real pipeline
 * without a browser) inserted directly into `credentials` exactly like
 * payment.e2e.ts does, then a real POST /auth/login/verify over HTTP that
 * returns a real, cookie-bearing session. Nothing about the resulting
 * session is mocked — it is indistinguishable from one a browser produced.
 */
import { query } from '../../db/pool';
import { createSoftCredential, SoftCredential } from '../identity/softAuthenticator';
import { post, extractSessionCookie } from './httpClient';

export interface DeviceSession {
  userId: string;
  email: string;
  cookie: string;
  credential: SoftCredential;
}

/** Registers a fresh real passkey for `userId` and logs it in for real over HTTP. */
export async function establishDeviceSession(userId: string, email: string): Promise<DeviceSession> {
  const credential = createSoftCredential(userId);
  await query(
    `INSERT INTO credentials (id, user_id, public_key, counter, device_type, backed_up, transports)
     VALUES ($1, $2, $3, 0, 'singleDevice', false, '{internal}')`,
    [credential.credentialId, userId, credential.cosePublicKey]
  );

  const opts = await post('/api/v1/auth/login/options', { email });
  if (opts.status !== 200) {
    throw new Error(`login/options failed: ${opts.status} ${JSON.stringify(opts.body)}`);
  }
  const verify = await post('/api/v1/auth/login/verify', {
    email,
    response: credential.sign(opts.body.challenge),
  });
  const cookie = extractSessionCookie(verify.setCookie);
  if (verify.status !== 200 || !cookie) {
    throw new Error(`login/verify failed: ${verify.status} ${JSON.stringify(verify.body)}`);
  }

  return { userId, email, cookie, credential };
}

export interface ResolvedSession {
  cookie: string;
  /** Present only when the engine established the session itself (has the private key). Absent for a pasted, captured cookie. */
  credential?: SoftCredential;
  /** False when a real captured cookie was used — the honest "this was a real stolen session" signal. */
  selfEstablished: boolean;
}

/**
 * Use a captured cookie if the operator pasted one (the real stolen-session
 * demonstration); otherwise register a fresh passkey and log in as the payer
 * (a new, additional real session for that account — PRISM supports multiple
 * devices per user, so this is a genuine login, just not the captured one).
 */
export async function resolveSession(
  pastedCookie: string | undefined,
  userId: string,
  email: string
): Promise<ResolvedSession> {
  if (pastedCookie) return { cookie: pastedCookie, selfEstablished: false };
  const session = await establishDeviceSession(userId, email);
  return { cookie: session.cookie, credential: session.credential, selfEstablished: true };
}
