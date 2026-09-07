/**
 * Client-side WebAuthn handling using @simplewebauthn/browser.
 * The intentHash MUST be passed as the challenge for authentication
 * to cryptographically bind the passkey signature to the transaction.
 */
import {
  startRegistration,
  startAuthentication,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

export const webauthnClient = {

  /**
   * Trigger the device passkey registration flow.
   * @param options - Options object from /auth/register/options
   */
  async register(options: PublicKeyCredentialCreationOptionsJSON): Promise<any> {
    // TODO: return await startRegistration(options)
    // Returns the credential response to send to /auth/register/verify
    throw new Error('Not implemented');
  },

  /**
   * Trigger the device passkey authentication flow.
   * The options.challenge MUST be the intentHash from IntentLock —
   * this is what makes the user's signature specific to this transaction.
   * @param options - Options object from /auth/login/options (challenge = intentHash)
   */
  async authenticate(options: PublicKeyCredentialRequestOptionsJSON): Promise<any> {
    // TODO: return await startAuthentication(options)
    // Returns the assertion response to send to /auth/login/verify
    throw new Error('Not implemented');
  },
};
