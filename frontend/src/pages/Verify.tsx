/**
 * Additional verification. A paired phone scans a signed QR challenge;
 * accounts without one use the last-two-digits fallback.
 *
 * This is the only screen in PRISM that tests comprehension rather than
 * identity, so the wording is the defence. It deliberately does not say
 * "confirm payment": a person being talked through a transfer by a scammer
 * will confirm anything. Reading the recipient's real name and typing the
 * real number is a conscious act, not a reflex.
 *
 * The phone code is a transaction-bound second factor. Only the no-phone
 * fallback returns to a fresh passkey assertion.
 */
import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, TransactionView } from '@/lib/api-client';
import { webauthn, describeWebAuthnError } from '@/lib/webauthn-client';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

export default function Verify() {
  const { txId = '' } = useParams();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [tx, setTx] = useState<TransactionView | null>(null);
  const [answer, setAnswer] = useState('');
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  // The semantic fallback needs a fresh passkey after its comprehension check.
  // A paired authenticator supplies the second factor itself, so it must not
  // provoke a redundant second WebAuthn ceremony.
  const [phase, setPhase] = useState<null | 'checking' | 'signing'>(null);
  const busy = phase !== null;
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The signed challenge the paired phone scans. Only minted when this
  // transaction is waiting on a device rather than on the digits quiz.
  const [token, setToken] = useState<string | null>(null);
  const [codeLeft, setCodeLeft] = useState(0);

  useEffect(() => {
    api.payment(txId).then(setTx, () =>
      setLoadError('Could not open this payment. It may belong to another account.')
    );
  }, [txId]);

  /** Mint a fresh challenge and restart its window. */
  const issueCode = useCallback(async () => {
    try {
      const r = await api.stepUpToken(txId);
      setToken(r.token);
      setCodeLeft(r.expiresInSeconds);
      setError(null);
    } catch {
      setToken(null);
      setCodeLeft(0);
    }
  }, [txId]);

  // Fetch the QR payload only in AUTHENTICATOR mode. A failure here is not
  // fatal: the code can still be typed from the phone if it was already
  // scanned, so the screen degrades instead of dead-ending.
  useEffect(() => {
    if (tx?.stepUpMode !== 'AUTHENTICATOR') return;
    void issueCode();
  }, [tx?.stepUpMode, issueCode]);

  // The 60-second window, counted down locally purely so the user can see it.
  // The server holds the authoritative record and refuses a stale code
  // regardless of what this clock says.
  useEffect(() => {
    if (codeLeft <= 0) return;
    const id = setInterval(() => setCodeLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [codeLeft]);

  const submit = useCallback(async () => {
    setPhase('checking');
    setError(null);
    try {
      await api.stepUp(txId, answer);
      if (tx?.stepUpMode === 'AUTHENTICATOR') {
        await refresh();
        navigate(`/pay/${txId}/status`);
        return;
      }
      // The no-phone fallback remains a comprehension check, not a second
      // device, so it still requires a fresh transaction-bound passkey.
      setPhase('signing');
      const options = await api.challenge(txId);
      const assertion = await webauthn.approve(options);
      await api.authorize(txId, assertion);
      await refresh();
      navigate(`/pay/${txId}/status`);
    } catch (err) {
      if (err instanceof ApiError) {
        const left = (err.details as { attemptsRemaining?: number })?.attemptsRemaining;
        setAttemptsLeft(left ?? null);
        if (left === 0 || err.failureCode !== 'STEP_UP_FAILED') {
          navigate(`/pay/${txId}/status`);
          return;
        }
        const expiredCode = (err.details as { expired?: boolean })?.expired === true;
        if (expiredCode) setCodeLeft(0);
        setError(
          tx?.stepUpMode !== 'AUTHENTICATOR'
            ? 'That is not the right number.'
            : expiredCode
              ? 'That code has expired. Generate a new one and scan it again.'
              : 'That code does not match this payment.'
        );
        setAnswer('');
      } else {
        setError(describeWebAuthnError(err));
      }
      setPhase(null);
    }
  }, [answer, navigate, refresh, tx?.stepUpMode, txId]);

  if (loadError) {
    return (
      <Card>
        <CardContent className="pt-6">
          <Alert variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (!tx) {
    return (
      <Card aria-busy="true">
        <CardContent className="grid gap-3 pt-6">
          <p className="text-small text-secondary-foreground">Loading this payment…</p>
          <Skeleton className="h-3.5 w-[55%]" />
        </CardContent>
      </Card>
    );
  }

  // A paired phone replaces the comprehension quiz. Everyone without one
  // keeps the quiz, so nobody is dead-ended by not owning a second device.
  const byPhone = tx.stepUpMode === 'AUTHENTICATOR';
  const codeLength = byPhone ? 6 : 2;

  return (
    <div className="animate-enter-up">
      <Card>
        <CardContent className="pt-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <Badge variant="warning">Additional verification</Badge>
            {attemptsLeft !== null && (
              <Badge variant="destructive">
                {attemptsLeft} attempt{attemptsLeft === 1 ? '' : 's'} left
              </Badge>
            )}
          </div>

          <h1 className="text-h3 font-semibold">Check this payment</h1>

          {/*
            The one line a manipulated user has to actually read. The emphasis
            comes from type size and breathing room rather than a coloured
            stripe: a bigger sentence is harder to skim past than a decorated
            one.
          */}
          <p className="my-5 text-pretty rounded-lg border bg-secondary p-6 text-[20px] leading-[1.45] max-md:p-5 max-md:text-body-lg">
            You are sending <strong className="font-semibold">{tx.amountFormatted}</strong> to{' '}
            <strong className="font-semibold">{tx.payeeName}</strong>.
          </p>

          {byPhone && (
            <div className="my-5 grid gap-5 rounded-lg border bg-secondary p-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
              {/* Light plate in both themes: a phone camera reads this across
                  a table, and contrast is what the camera needs. */}
              <div className="mx-auto grid gap-2">
                <div className="qr-plate" aria-label="Payment challenge QR code">
                  {token && codeLeft > 0 ? (
                    <QRCodeSVG value={token} size={176} level="M" includeMargin />
                  ) : (
                    <div className="grid size-[176px] place-items-center px-4 text-center text-caption text-muted-foreground">
                      {token ? 'This code has expired.' : 'Preparing…'}
                    </div>
                  )}
                </div>
                {codeLeft > 0 ? (
                  <p
                    className="text-center text-caption tabular text-secondary-foreground"
                    aria-live="polite"
                  >
                    Expires in {codeLeft}s
                  </p>
                ) : (
                  <Button variant="secondary" size="sm" onClick={issueCode}>
                    Generate a new code
                  </Button>
                )}
              </div>
              <div>
                <p className="font-semibold">Approve this on your phone</p>
                <p className="mt-2 text-pretty text-small text-secondary-foreground">
                  Open PRISM Authenticator and scan this code. Your phone will show the same
                  amount and recipient read from PRISM&rsquo;s signature, not from this page. If
                  they do not match what you see here, stop.
                </p>
                <p className="mt-3 text-pretty text-caption text-muted-foreground">
                  The six digits are derived from this transaction alone, so they authorize
                  nothing else and your phone needs no signal to produce them. PRISM accepts them
                  for 60 seconds.
                </p>
              </div>
            </div>
          )}

          {(tx.origin === 'QR' || tx.riskReasons.length > 0) && (
            <>
              <h2 className="font-semibold">Why PRISM stopped to ask</h2>
              <ul className="my-3 list-disc pl-5 text-small">
                {tx.origin === 'QR' && (
                  <li className="mb-1 text-pretty">
                    You started this payment with a QR code. Because QR codes can be swapped,
                    PRISM verified this one&rsquo;s signature, then read the recipient and amount
                    from its own records&mdash;not from the code.
                  </li>
                )}
                {tx.riskReasons.map((r) => (
                  <li key={r} className="mb-1 text-pretty">
                    {r}
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="text-pretty text-small text-secondary-foreground">
            PRISM will never call you and ask you to move money. Neither will your bank, and no
            genuine bank has a &ldquo;safe account&rdquo; to transfer funds into.
          </p>

          <div className="mt-6 grid gap-2">
            <Label htmlFor="answer">
              {byPhone
                ? 'Enter the six digits from your phone'
                : 'Enter the last two digits of the amount you intend to send'}
            </Label>
            <Input
              id="answer"
              inputMode="numeric"
              autoComplete="off"
              maxLength={codeLength}
              value={answer}
              aria-describedby={error ? 'stepup-error' : undefined}
              onChange={(e) => setAnswer(e.target.value.replace(/\D/g, '').slice(0, codeLength))}
              onKeyDown={(e) =>
                e.key === 'Enter' && answer.length === codeLength && !busy && submit()
              }
              className="h-14 text-center text-[28px] tracking-[0.4em] tabular"
            />
          </div>

          <Button
            block
            className="mt-3"
            onClick={submit}
            disabled={answer.length !== codeLength || busy || (byPhone && codeLeft <= 0)}
          >
            {phase === 'checking'
              ? 'Checking the number…'
              : phase === 'signing'
                ? 'Waiting for your passkey…'
                : byPhone
                  ? 'Confirm phone code'
                  : 'Confirm and sign again'}
          </Button>

          <p className="mt-3 text-pretty text-small text-secondary-foreground">
            {byPhone
              ? 'This code is the second approval. It comes from the paired phone and is bound to this exact payment, so no second passkey prompt is needed.'
              : 'Answering correctly does not send the payment. Your passkey has to sign this transaction\u2019s fingerprint a second time, so a scammer who talks you through the number still cannot move the money without your device.'}
          </p>

          {error && (
            <Alert variant="destructive" className="mt-4" id="stepup-error">
              <AlertDescription>
                {error}
                {attemptsLeft === 1 && (
                  <>
                    {' '}
                    <strong className="font-medium">This is the last attempt.</strong> After it the
                    payment is closed for good and you will need to start a new one.
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
