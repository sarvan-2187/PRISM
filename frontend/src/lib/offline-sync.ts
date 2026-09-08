/**
 * Redeem queued offline approvals — BLACKOUT (FC-01-A).
 *
 * Shared by the Review screen and the Offline page so "reconnect and it
 * settles" happens wherever the payer happens to be standing, rather than
 * only on one page they might never open.
 *
 * Each voucher is submitted exactly once per attempt and removed as soon as
 * the server gives a real answer — settled OR terminally refused. Only a
 * transport failure (still offline) leaves it queued to try again. The
 * server is the authority on single use: its replay guard is keyed to the
 * transaction's own nonce, so re-sending a voucher can never settle twice.
 */
import { api, ApiError, OfflineError } from './api-client';
import { loadOutbox, removeVoucher, type OfflineVoucher } from './offline-store';

export interface SyncOutcome {
  txId: string;
  ok: boolean;
  /** Server failure code when refused, e.g. REPLAY_BLOCKED / RISK_BLOCKED. */
  failureCode?: string;
  message: string;
}

export async function syncOne(userId: string, voucher: OfflineVoucher): Promise<SyncOutcome> {
  try {
    const result = await api.offlineRedeem({
      token: voucher.token,
      txId: voucher.txId,
      intentHash: voucher.intentHash,
      assertion: voucher.assertion,
      approvedAt: Math.floor(voucher.approvedAtMs / 1000),
    });
    removeVoucher(userId, voucher.txId);
    return {
      txId: voucher.txId,
      ok: true,
      message: `Settled · balance ${result.balanceFormatted}`,
    };
  } catch (err) {
    if (err instanceof ApiError) {
      // A real server answer. Anything but a rate limit is final for this
      // device: it does not get to keep retrying a refused approval.
      if (err.failureCode !== 'RATE_LIMITED') removeVoucher(userId, voucher.txId);
      return {
        txId: voucher.txId,
        ok: false,
        failureCode: err.failureCode,
        message: `${err.failureCode} — ${err.message}`,
      };
    }
    // Still offline, or the connection died mid-flight: stays queued.
    return {
      txId: voucher.txId,
      ok: false,
      message:
        err instanceof OfflineError ? 'Still offline — stays queued.' : 'Could not reach PRISM.',
    };
  }
}

/** Redeem everything queued for this user, oldest first. */
export async function syncOutbox(userId: string): Promise<SyncOutcome[]> {
  const out: SyncOutcome[] = [];
  for (const voucher of loadOutbox(userId)) {
    out.push(await syncOne(userId, voucher));
  }
  return out;
}
