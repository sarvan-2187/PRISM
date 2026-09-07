/**
 * Identity Module — WebAuthn / passkeys.
 *
 * Registration is ordinary. Authentication is not: the challenge we hand the
 * authenticator is the intent hash, so the signature that comes back is over
 * the transaction itself rather than over a random number. That is PRISM's
 * core mechanism (N1), and it needs no custom cryptography — only a standard
 * API used deliberately instead of incidentally.
 *
 * PRISM never sees a fingerprint. The biometric unlocks a private key on the
 * device; we only ever receive a signature. (Standard WebAuthn behaviour, not
 * something we invented — worth saying because users assume otherwise.)
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server/script/deps';
import { query } from '../../db/pool';
import redis from '../../utils/redis';
import { config } from '../../config/env';
import { policy } from '../../config/policy';
import { CredentialRow, UserRow } from '../../db/types';
import { audit } from '../audit/logger';
import { fail, PrismError } from '../../api/errors';

const regChallengeKey = (userId: string) => `challenge:reg:${userId}`;
const authChallengeKey = (txId: string) => `challenge:auth:${txId}`;
const loginChallengeKey = (userId: string) => `challenge:login:${userId}`;

export class IdentityModule {
  // ── Registration ──────────────────────────────────────────────────────

  async registrationOptions(user: UserRow) {
    const existing = await this.credentialsFor(user.id);

    const options = await generateRegistrationOptions({
      rpID: config.webauthn.rpId,
      rpName: config.webauthn.rpName,
      userID: user.id,
      userName: user.email,
      userDisplayName: user.display_name,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: Buffer.from(c.id, 'base64url'),
        type: 'public-key' as const,
        transports: (c.transports ?? undefined) as never,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        // A payment must be approved by a human, verified locally.
        userVerification: 'required',
      },
    });

    await redis.set(
      regChallengeKey(user.id),
      options.challenge,
      'EX',
      policy.regChallengeTtlSeconds
    );
    return options;
  }

  async verifyRegistration(userId: string, response: RegistrationResponseJSON): Promise<void> {
    const expectedChallenge = await redis.get(regChallengeKey(userId));
    if (!expectedChallenge) fail('AUTH_FAILED', { reason: 'registration challenge expired' });

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.webauthn.expectedOrigins,
      expectedRPID: config.webauthn.rpId,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      fail('AUTH_FAILED', { reason: 'registration not verified' });
    }

    const { credentialID, credentialPublicKey, counter, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;

    await query(
      `INSERT INTO credentials
         (id, user_id, public_key, counter, device_type, backed_up, transports)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [
        Buffer.from(credentialID).toString('base64url'),
        userId,
        Buffer.from(credentialPublicKey),
        counter,
        credentialDeviceType,
        credentialBackedUp,
        response.response.transports ?? null,
      ]
    );

    await redis.del(regChallengeKey(userId));
    await audit.log('PASSKEY_REGISTERED', { userId, data: { credentialDeviceType } });
  }

  // ── Login (session establishment, not payment approval) ───────────────

  async loginOptions(user: UserRow) {
    const creds = await this.credentialsFor(user.id);
    if (creds.length === 0) fail('AUTH_FAILED', { reason: 'no passkey registered' });

    const options = await generateAuthenticationOptions({
      rpID: config.webauthn.rpId,
      allowCredentials: creds.map((c) => ({
        id: Buffer.from(c.id, 'base64url'),
        type: 'public-key' as const,
      })),
      userVerification: 'required',
    });

    await redis.set(loginChallengeKey(user.id), options.challenge, 'EX', policy.challengeTtlSeconds);
    return options;
  }

  async verifyLogin(userId: string, response: AuthenticationResponseJSON): Promise<void> {
    const expected = await redis.get(loginChallengeKey(userId));
    if (!expected) fail('AUTH_FAILED', { reason: 'login challenge expired' });
    await this.verifyAssertion(userId, response, expected);
    await redis.del(loginChallengeKey(userId));
    await audit.log('LOGIN_SUCCEEDED', { userId });
  }

  // ── Payment approval: the challenge IS the intent hash ────────────────

  /**
   * Issue an assertion challenge bound to one exact transaction.
   *
   * `intentHash` is base64url of sha256(canonical intent) — the same string
   * stored in transactions.intent_hash. It is handed to the library as the raw
   * 32 sha256 bytes (`isoBase64URL.toBuffer`), NOT as a string: given a string,
   * @simplewebauthn/server v9 treats it as arbitrary text and re-encodes it
   * (base64url(utf8(intentHash))), so the browser would sign a value that is not
   * the intent hash and verification — which compares against the raw hash —
   * would always fail with SIG_INVALID. Passing bytes makes the library encode
   * them straight back to `intentHash`, so `options.challenge` === the stored
   * hash exactly, with zero re-encoding drift. This is the N1 mechanism.
   */
  async paymentChallenge(userId: string, txId: string, intentHash: string) {
    const creds = await this.credentialsFor(userId);
    if (creds.length === 0) fail('AUTH_FAILED', { reason: 'no passkey registered' });

    const options = await generateAuthenticationOptions({
      rpID: config.webauthn.rpId,
      // Raw 32 hash bytes, never the base64url string — see the note above.
      challenge: isoBase64URL.toBuffer(intentHash, 'base64url'),
      allowCredentials: creds.map((c) => ({
        id: Buffer.from(c.id, 'base64url'),
        type: 'public-key' as const,
      })),
      userVerification: 'required',
    });

    await redis.set(authChallengeKey(txId), intentHash, 'EX', policy.challengeTtlSeconds);
    await audit.log('CHALLENGE_ISSUED', {
      transactionId: txId,
      userId,
      data: { challengeIsIntentHash: true },
    });
    return options;
  }

  /**
   * Verify a payment assertion against the intent hash.
   * A signature produced for a different transaction fails here — not because
   * we compare amounts, but because the signed bytes are simply different.
   */
  async verifyPaymentAssertion(
    userId: string,
    txId: string,
    intentHash: string,
    response: AuthenticationResponseJSON
  ): Promise<void> {
    const issued = await redis.get(authChallengeKey(txId));
    if (!issued) fail('INTENT_EXPIRED', { reason: 'challenge no longer fresh' });
    if (issued !== intentHash) fail('TAMPER_BLOCKED', { reason: 'challenge/intent mismatch' });

    await this.verifyAssertion(userId, response, intentHash);
    await redis.del(authChallengeKey(txId));
    await audit.log('ASSERTION_VERIFIED', { transactionId: txId, userId });
  }

  // ── Shared assertion verification ─────────────────────────────────────

  private async verifyAssertion(
    userId: string,
    response: AuthenticationResponseJSON,
    expectedChallenge: string
  ): Promise<void> {
    const { rows } = await query<CredentialRow>(
      'SELECT * FROM credentials WHERE id = $1 AND user_id = $2',
      [response.id, userId]
    );
    const credential = rows[0];
    if (!credential) fail('SIG_INVALID', { reason: 'unknown credential' });
    if (credential.revoked_at) fail('AUTH_FAILED', { reason: 'credential revoked' });

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: config.webauthn.expectedOrigins,
        expectedRPID: config.webauthn.rpId,
        requireUserVerification: true,
        authenticator: {
          credentialID: Buffer.from(credential.id, 'base64url'),
          credentialPublicKey: credential.public_key,
          counter: Number(credential.counter),
          transports: (credential.transports ?? undefined) as never,
        },
      });
    } catch (err) {
      const message = (err as Error).message;
      // simplewebauthn reports origin and RP mismatches as plain errors;
      // translate so the failure catalogue stays meaningful.
      if (/origin|rpid/i.test(message)) fail('ORIGIN_MISMATCH', { reason: message });
      fail('SIG_INVALID', { reason: message });
    }

    if (!verification.verified) fail('SIG_INVALID', { reason: 'assertion not verified' });

    // Counter is recorded but NOT used to detect clones: several major
    // platform authenticators always return 0, so treating a non-increment as
    // an attack would produce false blocks. Stored for forensics only.
    await query(
      'UPDATE credentials SET counter = $2, last_used_at = NOW() WHERE id = $1',
      [credential.id, verification.authenticationInfo.newCounter]
    );
  }

  async credentialsFor(userId: string): Promise<CredentialRow[]> {
    const { rows } = await query<CredentialRow>(
      'SELECT * FROM credentials WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );
    return rows;
  }

  /** Stolen-device response: kill every passkey on it. */
  async revokeCredential(userId: string, credentialId: string): Promise<void> {
    const { rowCount } = await query(
      'UPDATE credentials SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [credentialId, userId]
    );
    if (!rowCount) throw new PrismError(404, 'NOT_FOUND', 'No such active credential.');
    await audit.log('CREDENTIAL_REVOKED', { userId, data: { credentialId } });
  }
}

export const identity = new IdentityModule();
