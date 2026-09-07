/**
 * Everything the device remembers, in expo-secure-store (Keychain on iOS,
 * EncryptedSharedPreferences on Android).
 *
 * The secret is the whole security of this app: anyone holding it can mint
 * approval codes for any transaction. It is written once at pairing and read
 * only into otp.derive.
 */
import * as SecureStore from 'expo-secure-store';

const K_DEVICE_ID = 'prism.deviceId';
const K_SECRET = 'prism.secret';
const K_API = 'prism.apiBase';
const K_PUBKEY = 'prism.serverPublicKey';

export interface Pairing {
  deviceId: string;
  /** base64url, decoded to bytes only when deriving a code. */
  secret: string;
}

export async function savePairing(p: Pairing): Promise<void> {
  await SecureStore.setItemAsync(K_DEVICE_ID, p.deviceId);
  await SecureStore.setItemAsync(K_SECRET, p.secret);
}

export async function loadPairing(): Promise<Pairing | null> {
  const deviceId = await SecureStore.getItemAsync(K_DEVICE_ID);
  const secret = await SecureStore.getItemAsync(K_SECRET);
  if (!deviceId || !secret) return null;
  return { deviceId, secret };
}

/** Unpair. The server row is revoked separately; this is the phone's half. */
export async function clearPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(K_DEVICE_ID);
  await SecureStore.deleteItemAsync(K_SECRET);
}

/**
 * Where the portal lives. Typed in, not discovered: the demo runs on a LAN
 * whose address changes, and hardcoding a host is how the web client broke on
 * every device but the one that built it.
 */
export async function getApiBase(): Promise<string> {
  return (await SecureStore.getItemAsync(K_API)) ?? '';
}

export async function setApiBase(url: string): Promise<void> {
  await SecureStore.setItemAsync(K_API, url.trim().replace(/\/+$/, ''));
}

/** The server's Ed25519 public key (JWK), fetched once at pairing. */
export async function getServerKey(): Promise<string | null> {
  return SecureStore.getItemAsync(K_PUBKEY);
}

export async function setServerKey(jwk: string): Promise<void> {
  await SecureStore.setItemAsync(K_PUBKEY, jwk);
}
