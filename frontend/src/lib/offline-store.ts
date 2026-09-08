/**
 * Offline authorization storage — BLACKOUT (FC-01-A).
 *
 * Two things live here, both namespaced by userId so a shared browser
 * profile (dev-login switches accounts in one tab) never shows one payer's
 * armed grant to another:
 *
 *   the ARMED GRANT   what /offline/grant issued while online — the capped,
 *                     signed capability that lets THIS device approve a
 *                     payment with no server to ask.
 *   the OUTBOX        approvals signed during a blackout, waiting to be
 *                     redeemed on reconnect. Each entry names an ordinary
 *                     transaction that was already locked online; the
 *                     voucher is just the proof it was approved.
 *
 * The outbox is deliberately visible and copyable on the Offline page: it is
 * exactly what an attacker who stole the device would have, and watching a
 * copy of it get refused on replay is the second half of what the card asks.
 *
 * localStorage only, wrapped in try/catch everywhere: a private window, a
 * cleared site, or a blocked storage API must degrade to "nothing armed",
 * never throw through the UI.
 */

export interface AllowedPayee {
  accountId: string;
  displayName: string;
  handle: string;
}

export interface GrantBody {
  typ: 'prism.offline.grant.v2';
  grantId: string;
  payerUserId: string;
  payerAccountId: string;
  credentialIds: string[];
  currency: string;
  maxAmountMinor: number;
  allowedPayees: AllowedPayee[];
  issuedAt: number;
  notAfter: number;
}

export interface ArmedGrant {
  token: string;
  grant: GrantBody;
}

/**
 * One offline approval, awaiting settlement.
 *
 * Note what is NOT here: any amount, payee or hash the device made up. The
 * transaction was locked by the server before the blackout and `intentHash`
 * is the server's own value, handed to this browser while it was still
 * online. The device only ever adds a signature over it.
 */
export interface OfflineVoucher {
  /** The grant token, proving this device was armed while online. */
  token: string;
  txId: string;
  intentHash: string;
  assertion: unknown;
  /** Device clock at signing — recorded for display, never trusted as a bound. */
  approvedAtMs: number;
  /** Display-only copies so the outbox renders with no network. */
  amountFormatted: string;
  payeeName: string;
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

/**
 * The armed grant, or null when there is none this device may still spend.
 *
 * Past notAfter this returns null: the grant window is the bound on
 * APPROVING offline. Vouchers already in the outbox are unaffected — each
 * carries its own copy of the token, and the server allows a reconnect
 * grace after the window for submitting one.
 */
export function loadGrant(userId: string): ArmedGrant | null {
  const armed = readJson<ArmedGrant>(grantKey(userId));
  if (!armed) return null;
  // A grant from the earlier slot-based design cannot be spent by this code.
  if (armed.grant?.typ !== 'prism.offline.grant.v2') return null;
  if (Math.floor(Date.now() / 1000) > armed.grant.notAfter) return null;
  return armed;
}

export function clearGrant(userId: string): void {
  try {
    localStorage.removeItem(grantKey(userId));
  } catch {
    /* best-effort */
  }
}

/** Does this armed grant cover this payment? UI guidance only — the server decides. */
export function grantCovers(
  armed: ArmedGrant | null,
  payeeHandle: string,
  amountMinor: number
): boolean {
  if (!armed) return false;
  if (amountMinor > armed.grant.maxAmountMinor) return false;
  return armed.grant.allowedPayees.some((p) => p.handle === payeeHandle);
}

export function loadOutbox(userId: string): OfflineVoucher[] {
  return readJson<OfflineVoucher[]>(outboxKey(userId)) ?? [];
}

export function addVoucher(userId: string, voucher: OfflineVoucher): boolean {
  const outbox = loadOutbox(userId).filter((v) => v.txId !== voucher.txId);
  outbox.push(voucher);
  return writeJson(outboxKey(userId), outbox);
}

export function hasVoucherFor(userId: string, txId: string): boolean {
  return loadOutbox(userId).some((v) => v.txId === txId);
}

/** Drop a voucher once the server has answered — settled OR terminally refused. */
export function removeVoucher(userId: string, txId: string): void {
  writeJson(
    outboxKey(userId),
    loadOutbox(userId).filter((v) => v.txId !== txId)
  );
}
