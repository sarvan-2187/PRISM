/**
 * Pairing lifecycle for the PRISM Authenticator.
 *
 * The ONLY file that reads or writes `authenticator_devices`. Secrets leave
 * here in exactly two directions and no others:
 *   - once, to the portal, at the moment of pairing (so it can be rendered as
 *     a QR for the phone's camera), and
 *   - into otp.derive, inside this process.
 * Nothing else in the app ever sees a device secret.
 */
import { randomBytes } from 'crypto';
import { query } from '../../db/pool';

/** Pairing window. Long enough to pick up a phone, short enough that an
 *  abandoned QR on a shared screen is worthless. */
export const PAIRING_TTL_SECONDS = 120;

const SECRET_BYTES = 32;

export interface DeviceRow {
  id: string;
  user_id: string;
  secret: Buffer;
  status: 'PENDING' | 'ACTIVE' | 'REVOKED';
  label: string | null;
  created_at: Date;
  confirmed_at: Date | null;
  expires_at: Date | null;
}

export interface PairingOffer {
  deviceId: string;
  /** base64url. Displayed to the user's own screen, never transmitted back. */
  secret: string;
  expiresAt: string;
  expiresInSeconds: number;
}

/**
 * Begin pairing: mint a PENDING device with a fresh secret.
 *
 * Any earlier PENDING row for this user is dropped first, so repeatedly
 * opening the pairing screen cannot accumulate live secrets. An existing
 * ACTIVE device is left alone until the new one is confirmed: losing your
 * working second factor because you opened a screen would be a bad trade.
 */
export async function startPairing(userId: string): Promise<PairingOffer> {
  await query(`DELETE FROM authenticator_devices WHERE user_id = $1 AND status = 'PENDING'`, [
    userId,
  ]);

  const secret = randomBytes(SECRET_BYTES);
  const { rows } = await query<{ id: string; expires_at: Date }>(
    `INSERT INTO authenticator_devices (user_id, secret, status, expires_at)
     VALUES ($1, $2, 'PENDING', NOW() + ($3 || ' seconds')::interval)
     RETURNING id, expires_at`,
    [userId, secret, String(PAIRING_TTL_SECONDS)]
  );

  return {
    deviceId: rows[0].id,
    secret: secret.toString('base64url'),
    expiresAt: rows[0].expires_at.toISOString(),
    expiresInSeconds: PAIRING_TTL_SECONDS,
  };
}

/**
 * Finish pairing. Supersedes any previously active device for this user.
 *
 * Scoped by user_id as well as id: a device id is not a capability, and
 * without this a leaked id would let one account confirm another's pairing.
 */
export async function confirmPairing(userId: string, deviceId: string): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM authenticator_devices
      WHERE id = $1 AND user_id = $2 AND status = 'PENDING' AND expires_at > NOW()`,
    [deviceId, userId]
  );
  if (!rows[0]) return false;

  // Revoke first: the partial unique index allows only one ACTIVE row per
  // user, so promoting before revoking would violate it.
  await query(
    `UPDATE authenticator_devices SET status = 'REVOKED'
      WHERE user_id = $1 AND status = 'ACTIVE'`,
    [userId]
  );
  await query(
    `UPDATE authenticator_devices
        SET status = 'ACTIVE', confirmed_at = NOW(), expires_at = NULL
      WHERE id = $1`,
    [deviceId]
  );
  return true;
}

/** The user's active device, or null. The secret comes back with it. */
export async function activeDeviceFor(userId: string): Promise<DeviceRow | null> {
  const { rows } = await query<DeviceRow>(
    `SELECT * FROM authenticator_devices WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

/** Does this user have a second device at all? Cheap: never selects the secret. */
export async function hasActiveDevice(userId: string): Promise<boolean> {
  const { rows } = await query<{ one: number }>(
    `SELECT 1 AS one FROM authenticator_devices
      WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
}

/** Lost-phone response. One-way, exactly like credential revocation. */
export async function revokeActive(userId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE authenticator_devices SET status = 'REVOKED'
      WHERE user_id = $1 AND status = 'ACTIVE'`,
    [userId]
  );
  return (rowCount ?? 0) > 0;
}

/** Safe summary for the settings screen. Never includes the secret. */
export async function describeActive(
  userId: string
): Promise<{ deviceId: string; label: string | null; confirmedAt: string } | null> {
  const { rows } = await query<{ id: string; label: string | null; confirmed_at: Date }>(
    `SELECT id, label, confirmed_at FROM authenticator_devices
      WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [userId]
  );
  if (!rows[0]) return null;
  return {
    deviceId: rows[0].id,
    label: rows[0].label,
    confirmedAt: rows[0].confirmed_at.toISOString(),
  };
}
