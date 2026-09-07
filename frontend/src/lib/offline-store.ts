/**
 * Offline authorization storage — BLACKOUT (FC-01-A).
 *
 * Two things live here, both namespaced by userId so a shared browser
 * profile (dev-login switches accounts in one tab) never shows one payer's
 * armed grant to another:
 *
 *   the ARMED GRANT   what /offline/grant issued while online — the capped,
 *                     signed capability this device can spend without asking.
 *   the OUTBOX        vouchers produced while offline, waiting to be
 *                     redeemed on reconnect. This is deliberately visible and
 *                     copyable on the Offline page: it is exactly what an
 *                     attacker who stole the device would have, and the
 *                     demo's whole second half is showing that copy get
 *                     rejected on replay.
 *
 * localStorage only, wrapped in try/catch everywhere: a private window, a
 * cleared site, or a blocked storage API must degrade to "nothing armed",
 * never throw through the UI.
 */
import type { LockedIntent } from './offline-intent';

export interface AllowedPayee {
  accountId: string;
  displayName: string;
  handle: string;
}

export interface OfflineSlot {
  txId: string;
  nonce: string;
}

export interface GrantBody {
  typ: 'prism.offline.grant.v1';
  grantId: string;
  payerUserId: string;
  payerAccountId: string;
  credentialIds: string[];
  currency: string;
  maxAmountMinor: number;
  allowedPayees: AllowedPayee[];
  slots: OfflineSlot[];
  issuedAt: number;
  notAfter: number;
}

export interface ArmedGrant {
  token: string;
  grant: GrantBody;
}

export interface OfflineVoucher {
  token: string;
  intent: LockedIntent;
  intentHash: string;
  assertion: unknown;
  /** Device clock at signing — display only, never trusted for any gate. */
  approvedAtMs: number;
}

const grantKey = (userId: string) => `prism.offline.grant.${userId}`;
const outboxKey = (userId: string) => `prism.offline.outbox.${userId}`;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function saveGrant(userId: string, armed: ArmedGrant): boolean {
  return writeJson(grantKey(userId), armed);
}

export function loadGrant(userId: string): ArmedGrant | null {
  const armed = readJson<ArmedGrant>(grantKey(userId));
  if (!armed) return null;
  if (Math.floor(Date.now() / 1000) > armed.grant.notAfter) return null; // display-only staleness check
  return armed;
}

export function clearGrant(userId: string): void {
  try {
    localStorage.removeItem(grantKey(userId));
  } catch {
    /* best-effort */
  }
}

export function loadOutbox(userId: string): OfflineVoucher[] {
  return readJson<OfflineVoucher[]>(outboxKey(userId)) ?? [];
}

export function addVoucher(userId: string, voucher: OfflineVoucher): boolean {
  const outbox = loadOutbox(userId);
  outbox.push(voucher);
  return writeJson(outboxKey(userId), outbox);
}

/** Remove one voucher after it has been redeemed (settled OR terminally failed) — either way this device is done with it. */
export function removeVoucher(userId: string, nonce: string): void {
  const outbox = loadOutbox(userId).filter((v) => v.intent.nonce !== nonce);
  writeJson(outboxKey(userId), outbox);
}
