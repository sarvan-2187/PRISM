/**
 * Semantic step-up. "Enter the last two digits of the amount."
 *
 * This is the only screen in PRISM that tests comprehension rather than
 * identity, so the wording is the defence. It deliberately does not say
 * "confirm payment": a person being talked through a transfer by a scammer
 * will confirm anything. Reading the recipient's real name and typing the
 * real number is a conscious act, not a reflex.
 *
 * Passing does not authorize. It returns to the challenge and approve pair
 * for a fresh, transaction-bound assertion.
 */
import { useCallback, useEffect, useState } from 'react';
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api.payment(txId).then(setTx, () =>
      setLoadError('Could not open this payment. It may belong to another account.')
    );
  }, [txId]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.stepUp(txId, answer);
      // Understanding verified, not identity. Now prove identity again, bound
      // to this exact transaction.
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
        setError('That is not the right number.');
        setAnswer('');
      } else {
        setError(describeWebAuthnError(err));
      }
      setBusy(false);
    }
  }, [answer, navigate, refresh, txId]);

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

          {tx.riskReasons.length > 0 && (
            <>
              <h2 className="font-semibold">Why PRISM stopped to ask</h2>
              <ul className="my-3 list-disc pl-5 text-small">
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
              Enter the last two digits of the amount you intend to send
            </Label>
            <Input
              id="answer"
              inputMode="numeric"
              autoComplete="off"
              maxLength={2}
              value={answer}
              aria-describedby={error ? 'stepup-error' : undefined}
              onChange={(e) => setAnswer(e.target.value.replace(/\D/g, '').slice(0, 2))}
              onKeyDown={(e) => e.key === 'Enter' && answer.length === 2 && !busy && submit()}
              className="h-14 text-center text-[28px] tracking-[0.4em] tabular"
            />
          </div>

          <Button block className="mt-3" onClick={submit} disabled={answer.length !== 2 || busy}>
            {busy ? 'Checking…' : 'Confirm and approve'}
          </Button>

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
