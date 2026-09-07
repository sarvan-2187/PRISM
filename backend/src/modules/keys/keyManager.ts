/**
 * Key Management Module
 *
 * The only module that touches key material. Everything else asks this module
 * to sign or verify and never sees a key. That boundary is the whole point:
 * a QR signing key leaking into application code means an attacker can forge
 * valid payment QRs.
 *
 * Two keys, two jobs, deliberately different algorithms:
 *   - QR tokens      : Ed25519 (EdDSA). Asymmetric, so verification never
 *                      needs the signing key, and a printed sticker cannot
 *                      produce a valid signature.
 *   - Session cookies: HS256. Symmetric is correct here — the same process
 *                      issues and checks them.
 *
 * Simplification (labelled): in production the Ed25519 private key would live
 * in an HSM with a rotation policy. Here it comes from QR_SIGNING_KEY, or is
 * generated at boot if that is unset. The `kid` claim is already wired so that
 * rotation is an operational change, not a code change.
 */
import {
  SignJWT,
  jwtVerify,
  generateKeyPair,
  importPKCS8,
  exportPKCS8,
  type JWTPayload,
  type KeyLike,
} from 'jose';
import crypto from 'crypto';
import { config } from '../../config/env';

const sessionSecret = new TextEncoder().encode(config.jwtSecret);

interface QrKeys {
  privateKey: KeyLike;
  publicKey: KeyLike;
  kid: string;
}

let qrKeysPromise: Promise<QrKeys> | null = null;

async function loadQrKeys(): Promise<QrKeys> {
  if (config.qrSigningKeyPem) {
    const privateKey = await importPKCS8(config.qrSigningKeyPem, 'EdDSA');
    // Ed25519 public key is derivable from the private key via Node's KeyObject.
    const publicKey = crypto.createPublicKey(privateKey as crypto.KeyObject) as unknown as KeyLike;
    return { privateKey, publicKey, kid: kidFor(config.qrSigningKeyPem) };
  }

  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const pem = await exportPKCS8(privateKey);
  const kid = kidFor(pem);
  console.warn(
    `[Keys] No QR_SIGNING_KEY set — generated an ephemeral Ed25519 keypair (kid=${kid}).\n` +
      `[Keys] QR tokens will not survive a restart. Fine for a demo, not for production.`
  );
  return { privateKey, publicKey, kid };
}

function kidFor(pem: string): string {
  return 'qr-' + crypto.createHash('sha256').update(pem).digest('hex').slice(0, 12);
}

/** Lazily initialised once, then shared. */
function qrKeys(): Promise<QrKeys> {
  if (!qrKeysPromise) qrKeysPromise = loadQrKeys();
  return qrKeysPromise;
}

export class KeyManagementModule {
  /** Sign a QR token. Ed25519, with the key id in the header for rotation. */
  async signQrToken(payload: JWTPayload, expiresInSeconds: number): Promise<string> {
    const { privateKey, kid } = await qrKeys();
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
      .sign(privateKey);
  }

  /**
   * Verify a QR token against the Ed25519 public key.
   * Throws on a bad signature or an expired token — callers translate that
   * into QR_INVALID_SIGNATURE / QR_EXPIRED rather than leaking jose errors.
   */
  async verifyQrToken(token: string): Promise<JWTPayload> {
    const { publicKey } = await qrKeys();
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ['EdDSA'] });
    return payload;
  }

  /** Issue a session cookie value after a successful passkey login. */
  async signSession(userId: string, expiresInSeconds: number): Promise<string> {
    return new SignJWT({ sub: userId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
      .sign(sessionSecret);
  }

  /** Verify a session cookie. Throws if forged or expired. */
  async verifySession(token: string): Promise<{ userId: string }> {
    const { payload } = await jwtVerify(token, sessionSecret, { algorithms: ['HS256'] });
    if (!payload.sub) throw new Error('session token has no subject');
    return { userId: payload.sub };
  }

  /** Exposed so the QR module can stamp the current kid into its payload. */
  async currentKid(): Promise<string> {
    return (await qrKeys()).kid;
  }
}

export const keyManager = new KeyManagementModule();
