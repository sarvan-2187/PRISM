/**
 * Offline authorization — BLACKOUT (FC-01-A).
 *
 * "The device goes fully offline mid-payment — no network, no server
 * reachable, no live check against anything. Authentication must still
 * complete locally and stay replay-proof when connectivity returns."
 *
 * Three phases, in order:
 *   ARM     while online — issues a capped, payee-restricted, single-use-
 *           slot grant and stores it in this browser only.
 *   SPEND   with no network at all — builds and signs a payment locally
 *           using one of the grant's slots. Nothing here calls the server.
 *   REDEEM  on reconnect — the voucher is sent once; the server re-runs
 *           live risk and policy before it settles.
 *
 * An offline approval is a proof of authenticity, not a promise of
 * settlement: it can still be refused on reconnect. The outbox below is
 * shown in full, including the raw voucher JSON, on purpose — it is exactly
 * what an attacker who captured this device would have, and rejecting a
 * replay of it live is the second half of what this card demands.
 */
import { useCallback, useEffect, useState } from 'react';
import { WifiOff, Wifi, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useOnline } from '@/lib/useOnline';
import { intentHash, type LockedIntent } from '@/lib/offline-intent';
import { webauthn, describeWebAuthnError } from '@/lib/webauthn-client';
import {
  ArmedGrant,
  OfflineVoucher,
  addVoucher,
  loadGrant,
  loadOutbox,
  removeVoucher,
  saveGrant,
} from '@/lib/offline-store';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type SyncOutcome = { ok: boolean; message: string };

export default function Offline() {
  const { me, refresh } = useSession();
  const online = useOnline();
  const userId = me?.userId ?? '';

  const [armed, setArmed] = useState<ArmedGrant | null>(null);
  const [arming, setArming] = useState(false);
  const [armError, setArmError] = useState<string | null>(null);

  const [outbox, setOutbox] = useState<OfflineVoucher[]>([]);
  const [spentCount, setSpentCount] = useState(0); // slots used by vouchers already synced away

  const [payeeAccountId, setPayeeAccountId] = useState('');
  const [rupees, setRupees] = useState('');
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const [syncBusy, setSyncBusy] = useState(false);
  const [results, setResults] = useState<Record<string, SyncOutcome>>({});

  const refreshOutbox = useCallback(() => {
    if (userId) setOutbox(loadOutbox(userId));
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    setArmed(loadGrant(userId));
    refreshOutbox();
  }, [userId, refreshOutbox]);

  const arm = useCallback(async () => {
    setArming(true);
    setArmError(null);
    try {
      const { token, grant } = await api.offlineGrantIssue();
      saveGrant(userId, { token, grant });
      setArmed({ token, grant });
      setSpentCount(0);
    } catch (err) {
      // details.reason carries the specific cause (e.g. "no passkey
      // registered"); err.message is only the generic catalogue text.
      const reason = err instanceof ApiError ? (err.details?.reason as string | undefined) : undefined;
      setArmError(
        reason ?? (err instanceof ApiError ? err.message : 'Could not reach PRISM to arm this device.')
      );
    } finally {
      setArming(false);
    }
  }, [userId]);

  const usedNonces = new Set([...outbox.map((v) => v.intent.nonce)]);
  const slotsTotal = armed?.grant.slots.length ?? 0;
  const slotsLeft = armed ? Math.max(0, slotsTotal - outbox.length - spentCount) : 0;
  const notAfterMs = armed ? armed.grant.notAfter * 1000 : 0;
  const grantLive = Boolean(armed) && notAfterMs > Date.now();

  async function payOffline() {
    if (!armed) return;
    setPayBusy(true);
    setPayError(null);
    try {
      const payee = armed.grant.allowedPayees.find((p) => p.accountId === payeeAccountId);
      if (!payee) throw new Error('Choose a recipient from the list PRISM already knows.');
      const amountMinor = Math.round(Number(rupees) * 100);
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw new Error('Enter a valid amount.');
      }
      if (amountMinor > armed.grant.maxAmountMinor) {
        throw new Error(
          `This grant caps offline payments at ₹${(armed.grant.maxAmountMinor / 100).toLocaleString('en-IN')}.`
        );
      }
      const slot = armed.grant.slots.find((s) => !usedNonces.has(s.nonce));
      if (!slot) throw new Error('No offline slots left on this grant. Reconnect and arm again.');

      const now = Math.floor(Date.now() / 1000);
      const intent: LockedIntent = {
        amountMinor,
        createdAt: now,
        currency: armed.grant.currency,
        expiresAt: now + 900,
        lockVersion: 1,
        nonce: slot.nonce,
        payeeAccountId: payee.accountId,
        payerUserId: armed.grant.payerUserId,
        txId: slot.txId,
      };
      const hash = await intentHash(intent);

      // No network call anywhere above this line, and none below it either —
      // startAuthentication talks only to the local platform authenticator.
      const assertion = await webauthn.approve({ challenge: hash, userVerification: 'required' });

      const voucher: OfflineVoucher = {
        token: armed.token,
        intent,
        intentHash: hash,
        assertion,
        approvedAtMs: Date.now(),
      };
      addVoucher(userId, voucher);
      refreshOutbox();
      setRupees('');
      setPayeeAccountId('');
    } catch (err) {
      setPayError(err instanceof Error ? describeWebAuthnErrorSafe(err) : 'Could not approve offline.');
    } finally {
      setPayBusy(false);
    }
  }

  const syncOne = useCallback(
    async (voucher: OfflineVoucher) => {
      try {
        const result = await api.offlineRedeem({
          token: voucher.token,
          intent: voucher.intent,
          intentHash: voucher.intentHash,
          assertion: voucher.assertion,
        });
        setResults((r) => ({
          ...r,
          [voucher.intent.nonce]: { ok: true, message: `Settled · ${result.balanceFormatted}` },
        }));
        removeVoucher(userId, voucher.intent.nonce);
        setSpentCount((n) => n + 1);
        await refresh();
      } catch (err) {
        const message = err instanceof ApiError ? `${err.failureCode} — ${err.message}` : 'Could not reach PRISM.';
        setResults((r) => ({ ...r, [voucher.intent.nonce]: { ok: false, message } }));
        // ApiError means the request actually reached the server and got a
        // real answer back — a terminal one (TAMPER_BLOCKED, REPLAY_BLOCKED,
        // RISK_BLOCKED, …) is done: this device gets no second attempt at
        // that slot. RATE_LIMITED is the one server response worth retrying.
        // Anything that is NOT an ApiError (the fetch itself threw — still
        // offline) leaves the voucher queued for the next sync.
        if (err instanceof ApiError && err.failureCode !== 'RATE_LIMITED') {
          removeVoucher(userId, voucher.intent.nonce);
          setSpentCount((n) => n + 1);
        }
      }
      refreshOutbox();
    },
    [userId, refresh, refreshOutbox]
  );

  const syncAll = useCallback(async () => {
    setSyncBusy(true);
    for (const voucher of loadOutbox(userId)) {
      await syncOne(voucher);
    }
    setSyncBusy(false);
  }, [userId, syncOne]);

  // Auto-sync the moment the browser reports it's back online — this is what
  // makes "reconnect → settles" happen without a click in the demo.
  useEffect(() => {
    if (online && outbox.length > 0 && !syncBusy) void syncAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  return (
    <div className="animate-enter-up grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-h2 font-semibold max-md:text-h3">Offline authorization</h1>
        <Badge variant={online ? 'success' : 'destructive'} className="ml-auto">
          {online ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
          {online ? 'Online' : 'Offline'}
        </Badge>
      </div>
      <p className="max-w-[70ch] text-pretty text-small text-secondary-foreground">
        Arm this device while online. Then it can approve a payment with{' '}
        <strong className="font-medium text-foreground">zero network</strong> — the passkey prompt
        is local hardware and needs no server. An offline approval is proof of who approved
        exactly what, not a promise the money moves: PRISM still runs live risk and policy the
        moment this reconnects, and can still refuse it.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-body-lg">
            <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
            Grant
          </CardTitle>
          <CardDescription>
            A signed, capped capability: a fixed number of single-use slots, an amount ceiling, and
            a payee allow-list drawn from accounts you have already settled with. Nothing on this
            device can widen any of those — doing so breaks a signature it has no key for.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {grantLive && armed ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-small">
              <dt className="text-secondary-foreground">Slots left</dt>
              <dd className="m-0 font-medium tabular">
                {slotsLeft} of {slotsTotal}
              </dd>
              <dt className="text-secondary-foreground">Per-payment cap</dt>
              <dd className="m-0 font-medium tabular">
                ₹{(armed.grant.maxAmountMinor / 100).toLocaleString('en-IN')}
              </dd>
              <dt className="text-secondary-foreground">Allowed recipients</dt>
              <dd className="m-0 font-medium">
                {armed.grant.allowedPayees.map((p) => p.displayName).join(', ') || 'none'}
              </dd>
              <dt className="text-secondary-foreground">Expires</dt>
              <dd className="m-0 font-medium tabular">
                {new Date(notAfterMs).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
              </dd>
            </dl>
          ) : (
            <p className="text-small text-secondary-foreground">
              {armed ? 'The last grant on this device has expired.' : 'Not armed on this device yet.'}
            </p>
          )}
          {armError && (
            <Alert variant="destructive">
              <AlertDescription>{armError}</AlertDescription>
            </Alert>
          )}
          <Button onClick={arm} disabled={arming || !online} variant={grantLive ? 'secondary' : 'default'}>
            {arming ? 'Arming…' : grantLive ? 'Re-arm (new grant)' : 'Arm this device'}
          </Button>
          {!online && !grantLive && (
            <p className="text-caption text-muted-foreground">
              Arming needs a network connection — do this before the blackout.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-body-lg">Pay with no network</CardTitle>
          <CardDescription>
            Restricted to what the grant allows. Try this after turning DevTools → Network →
            Offline on, to see the passkey prompt fire with nothing reachable.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!grantLive || !armed ? (
            <p className="text-small text-secondary-foreground">Arm this device first.</p>
          ) : armed.grant.allowedPayees.length === 0 ? (
            <p className="text-small text-secondary-foreground">
              No settled payees yet — offline mode has nobody to pay. Send one ordinary payment
              online first, then re-arm.
            </p>
          ) : (
            <>
              <div>
                <Label className="mb-2 block">Recipient</Label>
                <div className="flex flex-wrap gap-2">
                  {armed.grant.allowedPayees.map((p) => (
                    <button
                      key={p.accountId}
                      type="button"
                      onClick={() => setPayeeAccountId(p.accountId)}
                      className={cn(
                        'rounded-full border px-3 py-1.5 text-small transition-colors duration-hover',
                        payeeAccountId === p.accountId
                          ? 'border-primary bg-primary-subtle text-primary'
                          : 'border-border-strong text-secondary-foreground hover:bg-accent'
                      )}
                    >
                      {p.displayName}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label htmlFor="offline-amount" className="mb-2 block">
                  Amount (₹, cap ₹{(armed.grant.maxAmountMinor / 100).toLocaleString('en-IN')})
                </Label>
                <Input
                  id="offline-amount"
                  inputMode="decimal"
                  value={rupees}
                  onChange={(e) => setRupees(e.target.value)}
                  placeholder="2000"
                />
              </div>
              {payError && (
                <Alert variant="destructive">
                  <AlertDescription>{payError}</AlertDescription>
                </Alert>
              )}
              <Button onClick={payOffline} disabled={payBusy || slotsLeft === 0 || !payeeAccountId}>
                {payBusy
                  ? 'Waiting for your passkey…'
                  : slotsLeft === 0
                    ? 'No slots left'
                    : 'Approve offline'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-body-lg">Outbox</CardTitle>
          <CardDescription>
            What this device is holding, unsettled. This is what a thief would have if the device
            were stolen right now — copy a voucher below to see it rejected on replay.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {outbox.length === 0 ? (
            <p className="text-small text-secondary-foreground">Nothing queued.</p>
          ) : (
            <>
              <Button onClick={() => void syncAll()} disabled={!online || syncBusy} block>
                {syncBusy ? 'Syncing…' : `Sync now (${outbox.length})`}
              </Button>
              <ul className="grid gap-2">
                {outbox.map((v) => {
                  const payee = armed?.grant.allowedPayees.find((p) => p.accountId === v.intent.payeeAccountId);
                  const outcome = results[v.intent.nonce];
                  return (
                    <li key={v.intent.nonce} className="rounded-md border border-border-strong p-3 text-small">
                      <div className="flex items-center justify-between gap-3">
                        <span>
                          ₹{(v.intent.amountMinor / 100).toLocaleString('en-IN')} to{' '}
                          {payee?.displayName ?? v.intent.payeeAccountId}
                        </span>
                        {outcome ? (
                          <Badge variant={outcome.ok ? 'success' : 'destructive'}>{outcome.message}</Badge>
                        ) : (
                          <Badge variant="warning">Awaiting settlement</Badge>
                        )}
                      </div>
                      <details className="mt-2">
                        <summary className="cursor-pointer text-caption text-secondary-foreground">
                          Raw voucher (what an attacker would have)
                        </summary>
                        <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 text-caption">
                          {JSON.stringify(v, null, 2)}
                        </pre>
                      </details>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** describeWebAuthnError expects an unknown; this keeps payOffline's catch block terse. */
function describeWebAuthnErrorSafe(err: Error): string {
  return err.name && ['NotAllowedError', 'InvalidStateError', 'SecurityError'].includes(err.name)
    ? describeWebAuthnError(err)
    : err.message;
}
