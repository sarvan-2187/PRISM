/**
 * Everything the app remembers, in expo-secure-store (Keychain on iOS,
 * EncryptedSharedPreferences on Android).
 *
 * Two secrets live here and they do different jobs. The DEVICE SECRET signs
 * payments and never changes; the SESSION TOKEN is a signed 8-hour credential
 * that only proves who is signed in. Losing the session is an inconvenience;
 * losing the device secret is losing the ability to authorize at all, which
 * is why unpairing is deliberate rather than a side effect of signing out.
 */
import * as SecureStore from 'expo-secure-store';

const K_API = 'prism.apiBase';
const K_EMAIL = 'prism.email';
const K_TOKEN = 'prism.session';
const K_DEVICE = 'prism.deviceId';
const K_SECRET = 'prism.secret';
const K_PUBKEY = 'prism.serverPublicKey';

export interface Pairing {
  deviceId: string;
  /** base64url. Decoded to bytes only inside otp.derive. */
  secret: string;
}

async function get(k: string) {
  try {
    return await SecureStore.getItemAsync(k);
  } catch {
    return null;
  }
}
async function set(k: string, v: string) {
  try {
    await SecureStore.setItemAsync(k, v);
  } catch {
    /* a device with no keystore cannot persist; the session still works in memory */
  }
}
async function del(k: string) {
  try {
    await SecureStore.deleteItemAsync(k);
  } catch {
    /* nothing to remove */
  }
}

/** Where the PRISM App API lives. Typed in, because the LAN address changes. */
export const getApiBase = () => get(K_API).then((v) => v ?? '');
export const setApiBase = (url: string) => set(K_API, url.trim().replace(/\/+$/, ''));

export const getEmail = () => get(K_EMAIL);
export const setEmail = (e: string) => set(K_EMAIL, e);

export const getToken = () => get(K_TOKEN);
export const setToken = (t: string) => set(K_TOKEN, t);
export const clearToken = () => del(K_TOKEN);

export async function getPairing(): Promise<Pairing | null> {
  const [deviceId, secret] = await Promise.all([get(K_DEVICE), get(K_SECRET)]);
  if (!deviceId || !secret) return null;
  return { deviceId, secret };
}

export async function setPairing(p: Pairing): Promise<void> {
  await set(K_DEVICE, p.deviceId);
  await set(K_SECRET, p.secret);
}

/** Unpair. The server row is revoked separately; this is the phone's half. */
export async function clearPairing(): Promise<void> {
  await del(K_DEVICE);
  await del(K_SECRET);
  await del(K_TOKEN);
  await del(K_PUBKEY);
}

/**
 * The server's Ed25519 public key (JWK), fetched once and cached.
 *
 * Verifying a web-portal step-up token needs this before the app trusts
 * anything it says about payee or amount — the same rule PRISM Authenticator
 * follows, and the reason this app checks a signature at all rather than
 * just decoding the payload.
 */
export const getServerKey = () => get(K_PUBKEY);
export const setServerKey = (jwk: string) => set(K_PUBKEY, jwk);
