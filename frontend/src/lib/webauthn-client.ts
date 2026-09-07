/**
 * WebAuthn browser wrapper.
 *
 * The important thing this file does NOT do: compute or re-encode a challenge.
 * The server sends options whose `challenge` is already the intent hash in
 * base64url, and they are passed to the authenticator untouched. Every bug in
 * this area comes from something helpfully re-encoding on the way through.
 */
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
} from '@simplewebauthn/browser';
// Derive the option types from the functions themselves rather than importing
// them: @simplewebauthn moves these between packages across versions, and this
// spelling cannot drift out of sync with the installed one.
type RegistrationOptions = Parameters<typeof startRegistration>[0];
type AuthenticationOptions = Parameters<typeof startAuthentication>[0];

export const webauthn = {
  supported: () => browserSupportsWebAuthn(),

  /** True when the device has a built-in authenticator (Touch ID, Windows Hello). */
  platformAvailable: () => platformAuthenticatorIsAvailable(),

  register: (options: RegistrationOptions) => startRegistration(options),

  /**
   * Approve a payment. `options.challenge` is the intent hash — the signature
   * that comes back is over this exact transaction and is void for any other.
   */
  approve: (options: AuthenticationOptions) => startAuthentication(options),
};

/** Turn a WebAuthn exception into something worth showing a user. */
export function describeWebAuthnError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  switch (name) {
    case 'NotAllowedError':
      return 'Approval was cancelled or timed out.';
    case 'InvalidStateError':
      return 'A passkey is already registered on this device.';
    case 'SecurityError':
      return 'This page is not a secure context. Use http://localhost or HTTPS.';
    default:
      return (err as Error)?.message ?? 'Passkey verification failed.';
  }
}
