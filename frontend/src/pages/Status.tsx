/**
 * Outcome. A receipt, or the reason it stopped.
 *
 * Unknown failure codes fall back to a generic blocked state rather than
 * crashing. That matters beyond tidiness: the rules can change mid-event, and
 * a code this build has never seen has to degrade into a sentence rather than
 * a blank screen.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, TransactionView } from '@/lib/api-client';
import { LiveLog } from '@/components/LiveLog';
import { isTerminal } from '@/lib/events';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

/** Plain English for each documented refusal, and what it stopped. */
const FAILURES: Record<string, { title: string; blurb: string }> = {
  TAMPER_BLOCKED: {
    title: 'The details were altered after approval',
    blurb:
      'The signed approval no longer matches the locked transaction. Someone changed the amount or the recipient between approval and settlement, and the signature stopped matching the moment they did.',
  },
  REPLAY_BLOCKED: {
    title: 'Already processed',
    blurb:
      'This payment settled once. A captured request cannot be sent a second time: the ledger refuses a duplicate entry at the database level, not in application code.',
  },
  INTENT_EXPIRED: {
    title: 'The approval window closed',
    blurb: 'This transaction was not approved in time. Nothing was charged.',
  },
  RISK_BLOCKED: {
    title: 'Refused as high risk',
    blurb:
      'The circumstances around this payment scored past the refusal threshold. The rules that fired are listed below.',
  },
  STEP_UP_FAILED: {
    title: 'The amount could not be confirmed',
    blurb:
      'The comprehension check was not passed. This payment is closed. If it was genuine, start a new one.',
  },
  INSUFFICIENT_FUNDS: {
    title: 'Not enough balance',
    blurb: 'An ordinary business rule rather than a security decision.',
  },
  SIG_INVALID: {
    title: 'The signature did not verify',
    blurb: 'The approval was not produced by a passkey registered to this account.',
  },
  ORIGIN_MISMATCH: {
    title: 'Wrong origin',
    blurb: 'The request came from a domain this credential was not registered for.',
  },
};

export default function Status() {
  const { txId = '' } = useParams();
  const [tx, setTx] = useState<TransactionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.payment(txId).then(setTx, (err) =>
      setError(err instanceof ApiError ? err.message : 'Could not reach PRISM.')
    );
  }, [txId]);

  if (error) {
    return (
      <Card>
        <CardContent className="grid gap-4 pt-6">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
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
          <p className="text-small text-secondary-foreground">Loading the result…</p>
          <Skeleton className="h-3.5 w-[45%]" />
        </CardContent>
      </Card>
    );
  }

  const settled = tx.status === 'SETTLED';
  const failure = tx.failureCode
    ? (FAILURES[tx.failureCode] ?? {
        title: 'This payment stopped',
        blurb: 'It did not complete, and no money moved.',
      })
    : null;

  return (
    <div className="animate-enter-up">
      <Card>
        <CardContent className="pt-6">
          {settled ? (
            <>
              <Badge variant="success">Settled</Badge>
              <h1 className="mt-4 text-h3 font-semibold">Payment sent</h1>
              <div className="attested mt-5">
                <div className="text-[44px] font-semibold leading-[1.1] tracking-[-0.03em] tabular max-md:text-h3">
                  {tx.amountFormatted}
                </div>
                <div className="mt-2">
                  to <strong className="font-semibold">{tx.payeeName}</strong>{' '}
                  <span className="text-secondary-foreground">({tx.payeeHandle})</span>
                </div>
                <span className="mt-2 block text-caption text-muted-foreground">
                  Confirmed by the ledger
                </span>
              </div>
            </>
          ) : (
            <>
              <Badge variant="destructive">{tx.failureCode ?? tx.status}</Badge>
              <h1 className="mt-4 text-h3 font-semibold">
                {failure?.title ?? 'This payment stopped'}
              </h1>
              <p className="mt-3 text-pretty text-body-lg text-secondary-foreground">
                {failure?.blurb}
              </p>
              <Alert variant="success" className="mt-5">
                <AlertDescription>
                  <strong className="font-medium">No money moved.</strong> {tx.amountFormatted} to{' '}
                  {tx.payeeName} was not sent, and the balance is unchanged.
                </AlertDescription>
              </Alert>
            </>
          )}

          {tx.riskReasons.length > 0 && (
            <div className="mt-6">
              <h2 className="font-semibold">
                What PRISM saw
                {tx.riskScore !== null ? ` (risk score ${tx.riskScore})` : ''}
              </h2>
              <ul className="my-3 list-disc pl-5 text-small">
                {tx.riskReasons.map((r) => (
                  <li key={r} className="mb-1 text-pretty">
                    {r}
                  </li>
                ))}
              </ul>
              <p className="text-pretty text-small text-secondary-foreground">
                Every decision states the conditions that produced it. There is no opaque score
                here that cannot be explained.
              </p>
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-2 max-md:flex-col">
            <Button asChild variant="secondary" className="flex-1">
              <Link to={`/pay/${txId}/timeline`}>Full security timeline</Link>
            </Button>
            <Button asChild variant="secondary" className="flex-1">
              <Link to="/pay">Send another payment</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="mt-4">
        <LiveLog txId={txId} live={!isTerminal(tx.status)} />
      </div>
    </div>
  );
}
