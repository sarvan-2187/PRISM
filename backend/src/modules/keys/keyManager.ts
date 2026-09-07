/**
 * Key Management Module
 * ISOLATED: only this module reads raw key material from environment.
 * All other modules call this module for signing/verification — never touch keys directly.
 * Uses `jose` for JWT operations.
 */
import { SignJWT, jwtVerify, importSecret } from 'jose';
import { config } from '../../config/env';

const KEY_REGISTRY = {
  JWT: () => new TextEncoder().encode(config.jwtSecret),
  QR:  () => new TextEncoder().encode(config.qrSigningKey),
};

export class KeyManagementModule {

  /**
   * Sign a payload as a JWT.
   * @param payload - Claims to embed (must be a plain object)
   * @param keyType - 'JWT' for auth tokens, 'QR' for QR code payloads
   * @param expiresIn - ISO duration or seconds (e.g., '5m', '60s')
   */
  async signPayload(
    payload: Record<string, any>,
    keyType: 'QR' | 'JWT',
    expiresIn: string = '5m'
  ): Promise<string> {
    // TODO: 1. const secret = await importSecret(KEY_REGISTRY[keyType]())
    // TODO: 2. Return new SignJWT(payload)
    //            .setProtectedHeader({ alg: 'HS256' })
    //            .setIssuedAt()
    //            .setExpirationTime(expiresIn)
    //            .sign(secret)
    throw new Error('Not implemented');
  }

  /**
   * Verify and decode a signed token.
   * Throws jose errors (JWTExpired, JWSSignatureVerificationFailed) if invalid.
   */
  async verifySignature(
    token: string,
    keyType: 'QR' | 'JWT'
  ): Promise<Record<string, any>> {
    // TODO: 1. const secret = await importSecret(KEY_REGISTRY[keyType]())
    // TODO: 2. const { payload } = await jwtVerify(token, secret)
    // TODO: 3. Return payload as Record<string, any>
    throw new Error('Not implemented');
  }
}
