/**
 * PRISM Authenticator — the module's public surface.   OWNER: S2
 *
 * routes.ts calls only this file. Device secrets never leave devices.ts
 * except into the derivations below, and never appear in anything returned
 * from here apart from the one-time pairing offer the user photographs.
 *
 * Design: docs/superpowers/specs/2026-09-07-prism-authenticator-design.md
 */
import * as devices from './devices';
import { approvalCode, denialCode, loginCode, codesMatch } from './otp';
import { authWindowKey, mintChallenge, pendingFor } from './challenge';

export { PAIRING_TTL_SECONDS } from './devices';
export type { PairingOffer } from './devices';
export { authWindowKey } from './challenge';
export type { PendingChallenge } from './challenge';

export const authenticator = {
  // ── Pairing ──────────────────────────────────────────────────────────
  startPairing: devices.startPairing,
  confirmPairing: devices.confirmPairing,
  hasActiveDevice: devices.hasActiveDevice,
  describeActive: devices.describeActive,
  revokeActive: devices.revokeActive,

  /**
   * Which account an ACTIVE device id belongs to, or null. Never the secret:
   * the phone's pending-step-up poll only needs to know whose transactions
   * to look at, same rule as everything else in this module.
   */
  async userIdForDevice(deviceId: string): Promise<string | null> {
    const device = await devices.activeDeviceById(deviceId);
    return device?.user_id ?? null;
  },

  // ── Step-up challenge ────────────────────────────────────────────────
  // One signing path shared by the portal's session-authed mint and every
  // paired device's poll — see challenge.ts.
  mintChallenge,
  pendingFor,

  // ── Verification ─────────────────────────────────────────────────────
  // Three bindings, one primitive. That is the design: the same six digits
  // mean nothing outside the exact transaction, denial, or login challenge
  // they were derived for.
  //
  // Each returns false when the user has no paired device, so a caller can
  // never accidentally read "no second factor" as "verified".

  /** A payment step-up code, bound to that transaction's intent hash. */
  async verifyPaymentCode(userId: string, intentHash: string, submitted: string): Promise<boolean> {
    const device = await devices.activeDeviceFor(userId);
    if (!device) return false;
    return codesMatch(String(submitted ?? ''), approvalCode(device.secret, intentHash));
  },

  /**
   * The "this isn't me" code, bound to the same hash under a separate domain.
   *
   * On screen it is indistinguishable from an approval code, which is the
   * point: a victim being coached through a payment can read out six digits
   * that quarantine it rather than settle it.
   */
  async verifyDenialCode(userId: string, intentHash: string, submitted: string): Promise<boolean> {
    const device = await devices.activeDeviceFor(userId);
    if (!device) return false;
    return codesMatch(String(submitted ?? ''), denialCode(device.secret, intentHash));
  },

  /** A sign-in code, bound to that login's WebAuthn challenge. */
  async verifyLoginCode(userId: string, challenge: string, submitted: string): Promise<boolean> {
    const device = await devices.activeDeviceFor(userId);
    if (!device) return false;
    return codesMatch(String(submitted ?? ''), loginCode(device.secret, challenge));
  },
};
