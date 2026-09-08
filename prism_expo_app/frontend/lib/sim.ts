/**
 * Cellular identity, for SIM-swap detection.
 *
 * WHAT THIS IS NOT: the phone number, the IMSI, the ICCID or the IMEI. None
 * of those are readable by an ordinary app. iOS has never exposed a phone
 * number, and Android 10+ throws SecurityException for the SIM and device
 * serials unless the app is carrier-privileged. Anything claiming to "bind to
 * the SIM number" on a normal app is claiming something the OS does not allow.
 *
 * WHAT IT IS: carrier name plus MCC/MNC — the network the SIM belongs to.
 * That is far too coarse to identify a person (millions share it), which is
 * exactly why it is safe to collect. Its value is not identity, it is CHANGE:
 * this phone was on Jio/405-857 when it paired, and now it is not.
 *
 * A SIM swap is one of the fraud paths PRISM exists to address, and it is the
 * one a passkey cannot see: the attacker who swapped the SIM may still be
 * holding the same handset.
 *
 * The whole reading is client-asserted. The server cannot verify it, records
 * it as reported, and uses it to ask for MORE proof — never as proof itself.
 */
import * as Cellular from 'expo-cellular';
import { sha256 } from '@noble/hashes/sha2.js';

export interface SimIdentity {
  /** A stable, non-identifying digest of carrier + MCC + MNC. */
  fingerprint: string;
  carrier: string | null;
  mcc: string | null;
  mnc: string | null;
  country: string | null;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Never throws and never blocks a payment. A tablet with no modem, a denied
 * permission or an eSIM mid-switch all return `null` fields — and "unknown"
 * must read as "no evidence", not as "changed", or every Wi-Fi-only device
 * would look like a SIM swap.
 */
export async function readSim(): Promise<SimIdentity> {
  const empty: SimIdentity = {
    fingerprint: 'unknown',
    carrier: null,
    mcc: null,
    mnc: null,
    country: null,
  };
  try {
    const [carrier, mcc, mnc, country] = await Promise.all([
      Cellular.getCarrierNameAsync(),
      Cellular.getMobileCountryCodeAsync(),
      Cellular.getMobileNetworkCodeAsync(),
      Cellular.getIsoCountryCodeAsync(),
    ]);
    if (!carrier && !mcc && !mnc) return empty;

    // Hashed before it leaves the phone: the server needs to know whether it
    // changed, not which network it is.
    const raw = `${carrier ?? ''}|${mcc ?? ''}|${mnc ?? ''}`.toLowerCase();
    return {
      fingerprint: hex(sha256(new TextEncoder().encode(raw))).slice(0, 16),
      carrier: carrier ?? null,
      mcc: mcc ?? null,
      mnc: mnc ?? null,
      country: country ?? null,
    };
  } catch {
    return empty;
  }
}

/** For the Device screen: what the user would recognise. */
export function describeSim(sim: SimIdentity): string {
  if (sim.fingerprint === 'unknown') return 'No SIM detected';
  const net = [sim.mcc, sim.mnc].filter(Boolean).join('-');
  return [sim.carrier ?? 'Unknown carrier', net, sim.country?.toUpperCase()]
    .filter(Boolean)
    .join(' · ');
}
