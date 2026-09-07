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

// ── Attestation keys ──────────────────────────────────────────────────
//
// Three purpose-specific keys derived from one root by HKDF. Deriving with
// distinct `info` strings is not key reuse: the outputs are independent, and a
// value MAC'd for one purpose can never verify as another. That domain
// separation is the point — without it an authorization receipt and a QR token
// signed by the same key are mutually confusable.
//
// PRISM_ATTESTATION_ROOT is preferred. Falling back to JWT_SECRET keeps an
// existing dev environment working without a new variable; it is sound because
// JWT_SECRET is already required and high-entropy, and HKDF separates the
// purposes. It is announced at boot so nobody mistakes it for a deployment.
const HKDF_SALT = Buffer.from('prism/attestation/v1');

function deriveKey(info: string, length = 32): Buffer {
  const root = Buffer.from(config.attestationRoot ?? config.jwtSecret, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', root, HKDF_SALT, Buffer.from(info), length));
}

const attestKey = deriveKey('prism/attest/v1');
const capabilityKey = deriveKey('prism/capability/v1');
// Offline authorization grant (003, BLACKOUT). Its own key, so a grant can
// never verify as a step MAC, a capability MAC, or a receipt signature.
const grantKey = deriveKey('prism/offline-grant/v1');

if (!config.attestationRoot) {
  console.warn(
    '[Keys] PRISM_ATTESTATION_ROOT not set — deriving attestation keys from JWT_SECRET.\n' +
      '[Keys] Sound (HKDF, separate info strings) but it ties two lifetimes together. Set it for a real deployment.'
  );
}

/**
 * The Ed25519 receipt key, derived deterministically from the same root.
 *
 * Deliberately NOT generated at boot the way the QR key is: an ephemeral key
 * makes every receipt unverifiable after a restart, which defeats the entire
 * point of handing someone a receipt they can check offline. Deriving it means
 * it survives restarts with no key file to manage, and the public half is
 * stable enough to publish.
 */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function loadReceiptKeys(): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject; kid: string } {
  const seed = deriveKey('prism/receipt/v1', 32);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = crypto.createPublicKey(privateKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const kid = 'rcpt-' + crypto.createHash('sha256').update(spki).digest('hex').slice(0, 12);
  return { privateKey, publicKey, kid };
}

const receiptKeys = loadReceiptKeys();

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

  // ── Authorization attestation ───────────────────────────────────────

  /**
   * MAC an authorization-chain step. HMAC, not a signature, because the
   * verifier and the signer are the same process — asymmetry would buy nothing
   * and cost a key-distribution problem. What it does buy: an attacker who can
   * write to the database but cannot read the key still cannot forge a step.
   */
  macStep(rowHash: string): string {
    return crypto.createHmac('sha256', attestKey).update(rowHash, 'utf8').digest('base64url');
  }

  /** MAC a settlement capability. Separate key, so a step MAC can never pass as one. */
  macCapability(canonical: string): string {
    return crypto.createHmac('sha256', capabilityKey).update(canonical, 'utf8').digest('base64url');
  }

  /**
   * MAC an offline authorization grant (003, BLACKOUT). Same rationale as
   * macCapability: HMAC, not a signature — this server both issues the grant
   * (while online) and redeems it (on reconnect), so asymmetry would buy
   * nothing. A distinct key means a grant can never verify as a step MAC, a
   * capability MAC, or a receipt signature, and vice versa.
   */
  macGrant(canonical: string): string {
    return crypto.createHmac('sha256', grantKey).update(canonical, 'utf8').digest('base64url');
  }

  /**
   * Constant-time MAC comparison. A plain !== leaks how much of the MAC
   * matched, which is enough to forge one byte at a time.
   */
  macMatches(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  /** Sign an authorization receipt. Ed25519, so anyone can verify without a secret. */
  signReceipt(canonical: string): string {
    return crypto.sign(null, Buffer.from(canonical, 'utf8'), receiptKeys.privateKey).toString('base64url');
  }

  /** Verify a receipt with the public half — the same check a third party runs. */
  verifyReceipt(canonical: string, signature: string): boolean {
    try {
      return crypto.verify(
        null,
        Buffer.from(canonical, 'utf8'),
        receiptKeys.publicKey,
        Buffer.from(signature, 'base64url')
      );
    } catch {
      return false;
    }
  }

  /** The published receipt key, as a JWK plus a PEM for offline verifiers. */
  receiptPublicKey(): { kid: string; jwk: crypto.JsonWebKey; pem: string } {
    return {
      kid: receiptKeys.kid,
      jwk: receiptKeys.publicKey.export({ format: 'jwk' }),
      pem: receiptKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    };
  }
}

export const keyManager = new KeyManagementModule();
