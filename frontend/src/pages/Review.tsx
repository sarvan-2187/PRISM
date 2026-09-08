/**
 * Intent review and approval. The security-critical screen.
 *
 * NON-NEGOTIABLE: every value rendered here comes from api.payment(txId).
 * Nothing is read from a QR code, a card number, a URL parameter, or state
 * carried from the composer. That single rule is what defeats tampering: a
 * swapped sticker or a mistyped card can point somewhere, but the screen
 * shows what the server's locked record actually says.
 *
 * The countdown is the intent lock made visible. When it reaches zero the
 * approval window has closed and the transaction is dead: a new payment means
 * a new id, a new nonce and a new hash.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, ApiError, OfflineError, TransactionView } from '@/lib/api-client';
import { webauthn, describeWebAuthnError } from '@/lib/webauthn-client';
import { LiveLog } from '@/components/LiveLog';
import { usePoll } from '@/lib/usePoll';
import { useSession } from '@/lib/session';
import { useOnline } from '@/lib/useOnline';
import { addVoucher, grantCovers, hasVoucherFor, loadGrant, type ArmedGrant } from '@/lib/offline-store';
import { syncOutbox } from '@/lib/offline-sync';
import { isTerminal } from '@/lib/events';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** The four layers, plus the authorization they add up to. */
const STEPS = ['Person', 'Device', 'Transaction', 'Context', 'Authorization'] as const;

export default function Review() {
  const { txId = '' } = useParams();
  const navigate = useNavigate();
  const { refresh, me } = useSession();
  const online = useOnline();
  const [tx, setTx] = useState<TransactionView | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [armed, setArmed] = useState<ArmedGrant | null>(null);
  const [queuedOffline, setQueuedOffline] = useState(false);

  const userId = me?.userId ?? '';

  // What this device may still approve without a server. Re-read whenever
  // connectivity flips, because Home re-arms the moment it is back.
  useEffect(() => {
    if (!userId) return;
    setArmed(loadGrant(userId));
    setQueuedOffline(hasVoucherFor(userId, txId));
  }, [userId, txId, online]);

  // Connectivity is back and this payment was approved during the blackout:
  // redeem it now, without waiting for the payer to find the Offline page.
  // This is the "settles when the link returns" half of the card.
  useEffect(() => {
    if (!online || !userId || !hasVoucherFor(userId, txId)) return;
    let cancelled = false;
    void (async () => {
      const results = await syncOutbox(userId);
      if (cancelled) return;
      setQueuedOffline(hasVoucherFor(userId, txId));
      const mine = results.find((r) => r.txId === txId);
      if (!mine) return;
      await refresh();
      // Settled or refused, the outcome and its reasons belong on Status —
      // the same screen an online approval ends on.
      navigate(`/pay/${txId}/status`);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, userId, txId]);

  const load = useCallback(async () => {
    try {
      const fresh = await api.payment(txId);
      setTx(fresh);
      setRemaining(fresh.secondsRemaining);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? { code: err.failureCode, message: err.message }
          : err instanceof OfflineError
            ? { code: 'OFFLINE', message: "You're offline. This will load once you reconnect." }
            : { code: 'UNREACHABLE', message: 'Could not reach PRISM.' }
      );
    }
  }, [txId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The transaction never loaded because the browser was offline at the
  // time — retry the instant connectivity returns instead of leaving the
  // user stuck on "Cannot open this payment" until they refresh by hand.
  useEffect(() => {
    if (online && !tx) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  // Local countdown off the server's own secondsRemaining. The server decides
  // expiry; this only shows it.
  useEffect(() => {
    if (remaining <= 0) return;
    const t = setInterval(() => setRemaining((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [remaining]);

  // Observe-only: while this screen is waiting (not mid-approval itself), poll
  // the server's own authoritative record. If something else acting on this
  // exact transaction id — e.g. a demonstrated attack from the Live Attack
  // Lab — causes the server to reach a terminal state, this screen notices
  // and moves to Status, which renders whatever real reason PRISM recorded.
  // This poll never makes a decision itself; it only reads one that already
  // happened server-side.
  usePoll(() => api.payment(txId), 1500, {
    enabled: Boolean(tx) && !busy && !isTerminal(tx?.status ?? '') && remaining > 0,
    onData: (fresh) => {
      setTx(fresh);
      if (isTerminal(fresh.status)) navigate(`/pay/${txId}/status`);
    },
  });

  /**
   * Approve with no network at all — BLACKOUT (FC-01-A).
   *
   * Everything needed is already on this device. `tx.intentHash` is the
   * server's own value, computed when the payment was locked and handed over
   * while the link was still up, and the passkey prompt is local hardware.
   * So the signature that authorizes this exact payment can be produced with
   * nothing reachable — no /challenge call, no /authorize call.
   *
   * The result is queued, not sent. On reconnect it is redeemed once, and
   * once only: the server's replay guard is keyed to this transaction's own
   * nonce, so a copy of this voucher lifted off the device settles nothing.
   */
  async function approveOffline(armedGrant: ArmedGrant, current: TransactionView) {
    setBusy(true);
    setError(null);
    try {
      const assertion = await webauthn.approve({
        challenge: current.intentHash,
        userVerification: 'required',
      });
      addVoucher(userId, {
        token: armedGrant.token,
        txId: current.txId,
        intentHash: current.intentHash,
        assertion,
        approvedAtMs: Date.now(),
        amountFormatted: current.amountFormatted,
        payeeName: current.payeeName,
      });
      setQueuedOffline(true);
    } catch (err) {
      setError({ code: 'PASSKEY', message: describeWebAuthnError(err) });
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      // The challenge returned here IS the intent hash. The device signs that
      // exact value, so the signature is void for any other transaction.
      const options = await api.challenge(txId);
      const assertion = await webauthn.approve(options);
      const result = await api.authorize(txId, assertion);

      // Two server decisions both mean "a comprehension check is pending":
      // STEP_UP from the risk engine, CONFIRM_CHANGE from the policy
      // firewall's REQUIRE_SEMANTIC outcome. Matching only the first sent
      // the user to Status while a challenge sat waiting, which looked like
      // the second passkey prompt never happening.
      if (result.decision === 'STEP_UP' || result.decision === 'CONFIRM_CHANGE') {
        navigate(`/pay/${txId}/verify`);
        return;
      }
      await refresh();
      navigate(`/pay/${txId}/status`);
    } catch (err) {
      if (err instanceof OfflineError) {
        // The blackout landed mid-approval. Nothing was charged: settlement
        // only happens if /authorize's response reaches the browser.
        //
        // If this device was armed while it was still online, it does not
        // have to wait — it can complete the authentication locally right
        // now and queue the result. That is the whole point of the card.
        const grant = loadGrant(userId);
        if (tx && grantCovers(grant, tx.payeeHandle, tx.amountMinor)) {
          setBusy(false);
          await approveOffline(grant!, tx);
          return;
        }
        setError({
          code: 'OFFLINE',
          message: grant
            ? "You're offline, and this payment is outside what this device was armed for. Nothing was charged — reconnect and approve again."
            : "You're offline and this device was not armed for offline approval. Nothing was charged — reconnect and approve again.",
        });
      } else if (err instanceof ApiError) {
        // Terminal refusals belong on the status screen with the full reasons.
        if (
          ['RISK_BLOCKED', 'REPLAY_BLOCKED', 'TAMPER_BLOCKED', 'INTENT_EXPIRED'].includes(
            err.failureCode
          )
        ) {
          navigate(`/pay/${txId}/status`);
          return;
        }
        setError({ code: err.failureCode, message: err.message });
      } else if (!navigator.onLine || err instanceof TypeError) {
        // This screen was built for a live server: approving here needs
        // /payment/:id/challenge and /authorize, both network calls, and it
        // has no payeeAccountId to build an offline voucher from — only the
        // Offline page's own allow-list does. If the blackout hit mid-review,
        // that page is where to finish this payment, not here.
        setError({
          code: 'OFFLINE',
          message: 'No connection. Approve this from the Offline page instead — it works with none.',
        });
      } else {
        setError({ code: 'PASSKEY', message: describeWebAuthnError(err) });
      }
      setBusy(false);
    }
  }

  if (error && !tx) {
    const offlineError = error.code === 'OFFLINE';
    return (
      <Card>
        <CardContent className="grid gap-4 pt-6">
          <div>
            <h1 className="text-h3 font-semibold">
              {offlineError ? "You're offline" : 'Cannot open this payment'}
            </h1>
            <p className="mt-2 text-small text-secondary-foreground">
              {offlineError
                ? 'Nothing was lost — this reloads automatically the moment your connection returns.'
                : 'It may belong to another account, or it may never have existed.'}
            </p>
          </div>
          <Alert variant={offlineError ? 'warning' : 'destructive'}>
            <AlertDescription>
              {error.code}: {error.message}
            </AlertDescription>
          </Alert>
          <Button asChild variant="secondary" block>
            <Link to="/home">Back to your account</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!tx) {
    return (
      <Card aria-busy="true">
        <CardContent className="grid gap-3 pt-6">
          <p className="text-small text-secondary-foreground">
            Opening the locked transaction…
          </p>
          <Skeleton className="h-3.5 w-[50%]" />
          <Skeleton className="h-3.5 w-[30%]" />
        </CardContent>
      </Card>
    );
  }

  const expired = remaining <= 0;
  // Can this device finish the payment with no server? Only if it was armed
  // while online AND the grant's sealed envelope covers this exact payment.
  const canApproveOffline = grantCovers(armed, tx.payeeHandle, tx.amountMinor);
  // The 90-second intent window is not the bound that applies to an offline
  // approval — the grant window is — so a countdown that ran out while the
  // link was down must not hide the offline button. See policy.offline.
  const offlineMode = !online && canApproveOffline && !queuedOffline;
  // Before the passkey prompt the transaction is locked and waiting; during
  // it, the context checks are what happens next.
  const activeStep = busy ? 3 : 2;

  return (
    <div className="animate-enter-up">
      <ol className="mb-5 flex flex-wrap gap-1" aria-label="What PRISM checks">
        {STEPS.map((step, i) => (
          <li
            key={step}
            aria-current={i === activeStep ? 'step' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-caption font-medium transition-colors duration-state',
              i < activeStep
                ? 'bg-success-subtle text-success'
                : i === activeStep
                  ? 'bg-primary-subtle text-primary'
                  : 'bg-muted text-muted-foreground'
            )}
          >
            <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
            {step}
          </li>
        ))}
      </ol>

      <Card>
        <CardContent className="pt-6">
          <h1 className="text-h3 font-semibold">Review payment</h1>
          <p className="mt-2 text-small text-secondary-foreground">
            These details were read back from PRISM, not carried here by this page.
          </p>

          <div className="attested mt-6">
            <div className="text-[44px] font-semibold leading-[1.1] tracking-[-0.03em] tabular max-md:text-h3">
              {tx.amountFormatted}
            </div>
            <div className="mt-2">
              to <strong className="font-semibold">{tx.payeeName}</strong>{' '}
              <span className="text-secondary-foreground">({tx.payeeHandle})</span>
            </div>
            <span className="mt-2 block text-caption text-muted-foreground">
              Server record, not this page
            </span>
          </div>

          <dl className="mt-6 grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3">
            <dt className="text-small text-secondary-foreground">Approval window</dt>
            <dd className="m-0 min-w-0">
              {expired ? (
                <Badge variant="destructive">Closed</Badge>
              ) : (
                <Badge variant={remaining <= 20 ? 'warning' : 'success'} className="tabular">
                  {remaining}s remaining
                </Badge>
              )}
            </dd>
            <dt className="text-small text-secondary-foreground">Transaction fingerprint</dt>
            <dd className="m-0 min-w-0 break-all font-mono text-caption text-secondary-foreground">
              {tx.intentHash.slice(0, 32)}…
            </dd>
          </dl>

          <p className="mt-4 text-pretty text-small text-secondary-foreground">
            Your passkey signs that fingerprint, not a random number. Change one rupee or one
            recipient and the signature no longer verifies against it.
          </p>

          {queuedOffline ? (
            <>
              <Alert variant="success" className="mt-5">
                <AlertDescription>
                  <strong className="font-medium">Approved offline.</strong> Your passkey signed
                  this exact payment on this device, with nothing reachable. It settles by itself
                  the moment you reconnect — and it can only settle once.
                </AlertDescription>
              </Alert>
              <Button asChild variant="secondary" block className="mt-4">
                <Link to="/offline">See what is queued</Link>
              </Button>
            </>
          ) : offlineMode ? (
            <>
              <Alert variant="warning" className="mt-5">
                <AlertDescription>
                  No connection — but this device was armed while it had one, so it can still
                  approve this payment locally. Your passkey signs the same fingerprint shown
                  above; PRISM settles it when you reconnect.
                </AlertDescription>
              </Alert>
              <div className="mt-4 flex flex-wrap gap-2 max-md:flex-col">
                <Button
                  className="flex-1"
                  onClick={() => armed && approveOffline(armed, tx)}
                  disabled={busy}
                >
                  {busy ? 'Waiting for your passkey…' : `Approve ${tx.amountFormatted} offline`}
                </Button>
                <Button asChild variant="secondary" className="max-md:w-full">
                  <Link to="/home">Cancel</Link>
                </Button>
              </div>
            </>
          ) : expired ? (
            <>
              <Alert variant="warning" className="mt-5">
                <AlertDescription>
                  This approval window has closed. Nothing was charged, and this transaction
                  cannot be revived: start a new payment and a new fingerprint is generated.
                </AlertDescription>
              </Alert>
              <Button asChild variant="secondary" block className="mt-4">
                <Link to="/pay">Start a new payment</Link>
              </Button>
            </>
          ) : !online ? (
            <>
              <Alert variant="warning" className="mt-5">
                <AlertDescription>
                  No connection, and this device is not armed for offline approval of this
                  payment. Nothing was charged — reconnect and approve again.
                </AlertDescription>
              </Alert>
              <Button asChild variant="secondary" block className="mt-4">
                <Link to="/offline">Offline status</Link>
              </Button>
            </>
          ) : (
            <div className="mt-5 flex flex-wrap gap-2 max-md:flex-col">
              <Button className="flex-1" onClick={approve} disabled={busy}>
                {busy ? 'Waiting for your passkey…' : `Approve ${tx.amountFormatted}`}
              </Button>
              <Button asChild variant="secondary" className="max-md:w-full">
                <Link to="/home">Cancel</Link>
              </Button>
            </div>
          )}

          {error && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>
                <strong className="font-medium">{error.code}</strong> — {error.message}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <div className="mt-4">
        <LiveLog txId={txId} live={!isTerminal(tx.status) && !expired} />
      </div>
    </div>
  );
}
