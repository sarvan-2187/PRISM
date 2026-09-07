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
import { api, ApiError, TransactionView } from '@/lib/api-client';
import { webauthn, describeWebAuthnError } from '@/lib/webauthn-client';
import { LiveLog } from '@/components/LiveLog';
import { usePoll } from '@/lib/usePoll';
import { useSession } from '@/lib/session';
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
  const { refresh } = useSession();
  const [tx, setTx] = useState<TransactionView | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const fresh = await api.payment(txId);
      setTx(fresh);
      setRemaining(fresh.secondsRemaining);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? { code: err.failureCode, message: err.message }
          : { code: 'UNREACHABLE', message: 'Could not reach PRISM.' }
      );
    }
  }, [txId]);

  useEffect(() => {
    void load();
  }, [load]);

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
      if (err instanceof ApiError) {
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
      } else {
        setError({ code: 'PASSKEY', message: describeWebAuthnError(err) });
      }
      setBusy(false);
    }
  }

  if (error && !tx) {
    return (
      <Card>
        <CardContent className="grid gap-4 pt-6">
          <div>
            <h1 className="text-h3 font-semibold">Cannot open this payment</h1>
            <p className="mt-2 text-small text-secondary-foreground">
              It may belong to another account, or it may never have existed.
            </p>
          </div>
          <Alert variant="destructive">
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

          {expired ? (
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
