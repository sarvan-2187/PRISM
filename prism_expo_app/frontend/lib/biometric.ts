/**
 * Face ID / fingerprint, via expo-local-authentication.
 *
 * What this does and does not prove — worth being exact, because it is the
 * difference between the app and a passkey:
 *
 *   A passkey's user-verification flag is carried INSIDE the signature the
 *   authenticator produces, so the server knows a human was verified. This is
 *   a LOCAL check. The server is told it happened and records the claim, but
 *   cannot verify it: a modified client could skip the prompt entirely.
 *
 * It is still worth doing. Without it the device code proves only possession
 * of an unlocked phone; with it, an attacker holding the phone still cannot
 * approve a payment. That restores the "person" half of Person × Device for
 * anyone who has not already been compromised at the OS level.
 */
import * as LocalAuthentication from 'expo-local-authentication';

export type BiometricResult =
  | { ok: true; verified: boolean }
  | { ok: false; reason: string };

/** Is there hardware, and has the user enrolled anything on it? */
export async function biometricAvailable(): Promise<boolean> {
  try {
    const [hardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hardware && enrolled;
  } catch {
    return false;
  }
}

/**
 * Prompt, and say plainly what is being authorized.
 *
 * `prompt` should name the action, never just "authenticate" — a person who
 * is being coached through a scam deserves one more chance to read what they
 * are agreeing to.
 *
 * Returns `verified: false` (not an error) when the device simply has no
 * biometrics enrolled, so a phone without a fingerprint set up is not locked
 * out of its own account. The server records the distinction.
 */
export async function requireBiometric(prompt: string): Promise<BiometricResult> {
  if (!(await biometricAvailable())) return { ok: true, verified: false };
  try {
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: prompt,
      cancelLabel: 'Cancel',
      // Falling back to the device passcode keeps a wet or unreadable finger
      // from becoming a dead end mid-payment.
      disableDeviceFallback: false,
    });
    if (res.success) return { ok: true, verified: true };
    return { ok: false, reason: 'Not verified. The payment was not sent.' };
  } catch {
    return { ok: false, reason: 'The device could not run a biometric check.' };
  }
}
