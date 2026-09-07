/**
 * The one schema change the PRISM App needs, applied by the app's own server.
 *
 * `authorization_stage` is a Postgres enum, so a new stage has to exist in the
 * type before a row can name it. Adding it here rather than in the web
 * backend's migrations keeps the mobile feature self-contained: the web stack
 * neither knows nor cares that this value exists, and `npm run db:reset` on
 * that side is unaffected.
 *
 * Idempotent by construction (`IF NOT EXISTS`), so it runs on every boot and
 * survives a database reset without anyone remembering to re-run anything.
 */
import { query } from '../../../backend/src/db/pool';

export async function ensureAppSchema(): Promise<void> {
  // ALTER TYPE ... ADD VALUE cannot run inside a transaction that then uses
  // the value, which is why this happens at boot and not mid-payment.
  // ALTER TYPE ... ADD VALUE cannot run inside a transaction that then uses
  // the value, which is why this happens at boot and not mid-payment.
  await query(`ALTER TYPE authorization_stage ADD VALUE IF NOT EXISTS 'DEVICE_APPROVED'`);

  /*
   * The cellular network this device was on when it paired.
   *
   * NOT the SIM number, the IMSI or the ICCID: no ordinary app can read those
   * on either platform. This is a hash of carrier + MCC/MNC, which is far too
   * coarse to identify anyone and is stored for exactly one purpose — noticing
   * that it CHANGED. A SIM swap is a fraud path a passkey cannot see, because
   * the attacker may still be holding the same handset.
   */
  await query(
    `ALTER TABLE authenticator_devices ADD COLUMN IF NOT EXISTS sim_fingerprint TEXT`
  );
  console.log('[PRISM App] schema ready: DEVICE_APPROVED stage, sim_fingerprint column');
}
