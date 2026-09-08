/**
 * Offline authorization status — BLACKOUT (FC-01-A).
 *
 * "The device goes fully offline mid-payment — no network, no server
 * reachable, no live check against anything. Authentication must still
 * complete locally and stay replay-proof when connectivity returns."
 *
 * Payments are NOT made here. They are made the ordinary way, on Send and
 * Review. This page is the status and evidence screen for the mechanism
 * underneath:
 *
 *   ARMED    what /offline/grant sealed while this device was online — the
 *            cap, the payee allow-list, and the window. Home arms silently
 *            after sign-in; this is where you can see and refresh it.
 *   QUEUED   approvals signed during a blackout, waiting to be redeemed.
 *            Shown in full, raw voucher included, because that is exactly
 *            what an attacker who took the device would be holding — and
 *            replaying it settles nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { WifiOff, Wifi, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useOnline } from '@/lib/useOnline';
import { ArmedGrant, OfflineVoucher, loadGrant, loadOutbox, saveGrant } from '@/lib/offline-store';
import { syncOutbox, type SyncOutcome } from '@/lib/offline-sync';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';

export default function Offline() {
  const { me, refresh } = useSession();
  const online = useOnline();
  const userId = me?.userId ?? '';

  const [armed, setArmed] = useState<ArmedGrant | null>(null);
  const [arming, setArming] = useState(false);
  const [armError, setArmError] = useState<string | null>(null);

  const [outbox, setOutbox] = useState<OfflineVoucher[]>([]);
  const [syncBusy, setSyncBusy] = useState(false);
  const [results, setResults] = useState<Record<string, SyncOutcome>>({});

  const reload = useCallback(() => {
    if (!userId) return;
    setArmed(loadGrant(userId));
    setOutbox(loadOutbox(userId));
  }, [userId]);

  useEffect(reload, [reload, online]);

  const arm = useCallback(async () => {
    setArming(true);
    setArmError(null);
    try {
      const { token, grant } = await api.offlineGrantIssue();
      saveGrant(userId, { token, grant });
      setArmed({ token, grant });
    } catch (err) {
      // details.reason carries the specific cause (e.g. "no passkey
      // registered"); err.message is only the generic catalogue text.
      const reason =
        err instanceof ApiError ? (err.details?.reason as string | undefined) : undefined;
      setArmError(
        reason ??
          (err instanceof ApiError ? err.message : 'Could not reach PRISM to arm this device.')
      );
    } finally {
      setArming(false);
    }
  }, [userId]);

  const sync = useCallback(async () => {
    if (!userId) return;
    setSyncBusy(true);
    const outcomes = await syncOutbox(userId);
    setResults((r) => ({ ...r, ...Object.fromEntries(outcomes.map((o) => [o.txId, o])) }));
    reload();
    await refresh();
    setSyncBusy(false);
  }, [userId, reload, refresh]);

  // Reconnected with something queued: redeem it without being asked.
  useEffect(() => {
    if (online && userId && loadOutbox(userId).length > 0 && !syncBusy) void sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, userId]);

  const notAfterMs = armed ? armed.grant.notAfter * 1000 : 0;
  const grantLive = Boolean(armed) && notAfterMs > Date.now();

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
        Pay the normal way — this page is not a second payment screen. If the network dies while
        you are on the review screen, PRISM finishes the authentication{' '}
        <strong className="font-medium text-foreground">on the device</strong>: the passkey prompt
        is local hardware, and the fingerprint it signs was handed over while you still had a
        connection. The approval then settles on its own when you reconnect, exactly once.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-body-lg">
            <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
            Armed
          </CardTitle>
          <CardDescription>
            A signed, capped capability this device holds: an amount ceiling and a payee
            allow-list drawn from accounts you have already settled with. Nothing on this device
            can widen either — doing so breaks a signature it has no key for.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {grantLive && armed ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-small">
              <dt className="text-secondary-foreground">Offline cap</dt>
              <dd className="m-0 font-medium tabular">
                ₹{(armed.grant.maxAmountMinor / 100).toLocaleString('en-IN')} per payment
              </dd>
              <dt className="text-secondary-foreground">Can pay offline</dt>
              <dd className="m-0 font-medium">
                {armed.grant.allowedPayees.map((p) => p.displayName).join(', ') || 'nobody yet'}
              </dd>
              <dt className="text-secondary-foreground">Armed until</dt>
              <dd className="m-0 font-medium tabular">
                {new Date(notAfterMs).toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </dd>
            </dl>
          ) : (
            <p className="text-small text-secondary-foreground">
              {armed
                ? 'The last grant on this device has expired — re-arm to cover another blackout.'
                : 'Not armed on this device yet. Arming happens automatically on the home screen; it needs a registered passkey.'}
            </p>
          )}
          {armError && (
            <Alert variant="destructive">
              <AlertDescription>{armError}</AlertDescription>
            </Alert>
          )}
          <Button
            onClick={arm}
            disabled={arming || !online}
            variant={grantLive ? 'secondary' : 'default'}
          >
            {arming ? 'Arming…' : grantLive ? 'Re-arm this device' : 'Arm this device'}
          </Button>
          {!online && !grantLive && (
            <p className="text-caption text-muted-foreground">
              Arming needs a connection — it has to happen before the blackout, not during it.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-body-lg">Queued approvals</CardTitle>
          <CardDescription>
            Signed on this device with no network, waiting to settle. This is exactly what a thief
            would be holding if they took the device right now — and replaying it settles nothing,
            because the server accepts each one against its transaction&apos;s own nonce exactly
            once.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {outbox.length === 0 ? (
            <p className="text-small text-secondary-foreground">
              Nothing queued.{' '}
              <Link to="/pay" className="underline">
                Send a payment
              </Link>{' '}
              and pull the network mid-approval to see this work.
            </p>
          ) : (
            <>
              <Button onClick={() => void sync()} disabled={!online || syncBusy} block>
                {syncBusy ? 'Settling…' : `Settle now (${outbox.length})`}
              </Button>
              <ul className="grid gap-2">
                {outbox.map((v) => {
                  const outcome = results[v.txId];
                  return (
                    <li
                      key={v.txId}
                      className="rounded-md border border-border-strong p-3 text-small"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span>
                          {v.amountFormatted} to {v.payeeName}
                        </span>
                        {outcome ? (
                          <Badge variant={outcome.ok ? 'success' : 'destructive'}>
                            {outcome.message}
                          </Badge>
                        ) : (
                          <Badge variant="warning">Approved offline · awaiting settlement</Badge>
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
          {Object.values(results).some((r) => !r.ok) && (
            <Alert variant="warning">
              <AlertDescription>
                A queued approval was refused on reconnect. That is the system working: PRISM
                re-runs live risk and policy before it settles anything, so an offline approval
                proves who approved what — it never promises the money moves.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
