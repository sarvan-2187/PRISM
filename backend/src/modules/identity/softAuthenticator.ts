/**
 * Headless software WebAuthn authenticator — TEST SUPPORT ONLY.
 *
 * A stand-in for a platform authenticator (Windows Hello, a phone) so the full
 * payment pipeline can be exercised end to end without a browser. It holds an
 * Ed25519 key, exports a COSE public key that @simplewebauthn/server can verify,
 * and turns an assertion challenge into a valid AuthenticationResponseJSON.
 *
 * Never imported by the running server. Used by payment.e2e.ts and available to
 * S3's smoke/attack scripts.
 *
 * Ed25519 (COSE alg -8, kty OKP, crv Ed25519) is verified by
 * @simplewebauthn/server@9 via WebCrypto, stable on the Node version in use.
 */
import crypto from 'crypto';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server/script/deps';
import { config } from '../../config/env';

/**
 * CBOR COSE_Key for an OKP / Ed25519 public key:
 *   { 1: 1 (kty OKP), 3: -8 (alg EdDSA), -1: 6 (crv Ed25519), -2: <32 pubkey bytes> }
 * Deterministic encoding: 10 header bytes (a4 01 01 03 27 20 06 21 58 20) + 32.
 */
function coseEd25519(publicKeyRaw: Buffer): Buffer {
  if (publicKeyRaw.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${publicKeyRaw.length}`);
  }
  return Buffer.concat([
    Buffer.from([
      0xa4, // map(4)
      0x01, 0x01, // 1 => 1
      0x03, 0x27, // 3 => -8
      0x20, 0x06, // -1 => 6
      0x21, 0x58, 0x20, // -2 => bytes(32)
    ]),
    publicKeyRaw,
  ]);
}

/** Raw 32-byte Ed25519 public key out of a Node KeyObject (via JWK `x`). */
function rawEd25519PublicKey(publicKey: crypto.KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('could not export Ed25519 public key');
  return Buffer.from(jwk.x, 'base64url');
}

const b64url = (b: Buffer): string => b.toString('base64url');

export interface SignOptions {
  origin?: string;
  rpId?: string;
  /** Authenticator sign counter. Kept at 0 — the server stores but does not trust it. */
  counter?: number;
  /** User-present flag. Default true. */
  up?: boolean;
  /** User-verified flag. Default true (payments require userVerification). */
  uv?: boolean;
}

export interface SoftCredential {
  /** base64url — goes into credentials.id (TEXT PK) and response.id / rawId. */
  credentialId: string;
  /** CBOR COSE_Key — goes into credentials.public_key (BYTEA). */
  cosePublicKey: Buffer;
  /** Test-only, in memory. */
  privateKeyPem: string;
  /**
   * Turn an assertion challenge (options.challenge, already base64url) into a
   * signed AuthenticationResponseJSON. The challenge string is embedded verbatim
   * in clientDataJSON — exactly what a browser echoes back.
   */
  sign(challengeB64url: string, opts?: SignOptions): AuthenticationResponseJSON;
}

export function createSoftCredential(userId: string): SoftCredential {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const cosePublicKey = coseEd25519(rawEd25519PublicKey(publicKey));
  const credentialId = crypto.randomBytes(16).toString('base64url');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

  const sign = (challengeB64url: string, opts: SignOptions = {}): AuthenticationResponseJSON => {
    const origin = opts.origin ?? config.webauthn.expectedOrigin;
    const rpId = opts.rpId ?? config.webauthn.rpId;
    const counter = opts.counter ?? 0;
    const up = opts.up ?? true;
    const uv = opts.uv ?? true;

    const clientData = {
      type: 'webauthn.get',
      challenge: challengeB64url,
      origin,
      crossOrigin: false,
    };
    const clientDataJSON = Buffer.from(JSON.stringify(clientData), 'utf8');

    // authenticatorData: rpIdHash(32) || flags(1) || signCount(4) = 37 bytes.
    const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
    let flags = 0;
    if (up) flags |= 0x01; // UP
    if (uv) flags |= 0x04; // UV
    const signCount = Buffer.alloc(4);
    signCount.writeUInt32BE(counter >>> 0, 0);
    const authData = Buffer.concat([rpIdHash, Buffer.from([flags]), signCount]);

    // Signature over authData || SHA-256(clientDataJSON). Ed25519 => raw 64 bytes.
    const clientDataHash = crypto.createHash('sha256').update(clientDataJSON).digest();
    const signature = crypto.sign(null, Buffer.concat([authData, clientDataHash]), privateKey);

    return {
      id: credentialId,
      rawId: credentialId,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: b64url(Buffer.from(userId, 'utf8')),
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      type: 'public-key',
    };
  };

  return { credentialId, cosePublicKey, privateKeyPem, sign };
}
