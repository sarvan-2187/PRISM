/**
 * What PRISM is enforcing right now, read live from the server.
 *
 * This screen exists for one moment: when a control is switched off to
 * demonstrate the before-and-after of an attack, or when the rules change
 * mid-event, the running system says so itself instead of someone claiming it
 * from a slide. Everything here comes from GET /policy. Nothing is hardcoded.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';

interface PolicyView {
  intentTtlSeconds: number;
  qrTtlSeconds: number;
  stepUpMaxAttempts: number;
  riskThresholds: { stepUpThreshold: number; blockThreshold: number };
  disabledControls: string[];
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3 text-small">
      <span className="text-secondary-foreground">{label}</span>
      <span className="text-right font-medium tabular">{value}</span>
    </div>
  );
}

export default function Policy() {
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPolicy(await api.policy());
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not reach PRISM. Check that the backend is running on port 4000.'
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const disabled = policy?.disabledControls ?? [];

  return (
    <div className="animate-enter-up">
      <div className="mb-8 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 basis-80">
          <h1 className="text-h2 font-semibold max-md:text-h3">Active policy</h1>
          <p className="mt-2 max-w-[60ch] text-pretty text-small text-secondary-foreground">
            The rules PRISM is applying to every payment at this moment, reported by the server
            itself rather than described from memory.
          </p>
        </div>
        <Button variant="secondary" className="max-md:w-full" onClick={load}>
          Re-read from server
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={load}>
                Try again
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {!policy && !error && (
        <Card aria-busy="true">
          <CardContent className="grid gap-3 pt-6">
            <p className="text-small text-secondary-foreground">Reading the current policy…</p>
            <Skeleton className="h-3.5 w-[60%]" />
            <Skeleton className="h-3.5 w-[40%]" />
          </CardContent>
        </Card>
      )}

      {policy && (
        <>
          {disabled.length > 0 ? (
            <Alert variant="warning">
              <AlertDescription>
                <strong className="font-medium">
                  Operating with {disabled.length} control{disabled.length === 1 ? '' : 's'}{' '}
                  switched off.
                </strong>{' '}
                The remaining controls are carrying the risk on their own: {disabled.join(', ')}.
                This is a deliberate demonstration build.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="success">
              <AlertDescription>
                <strong className="font-medium">All controls active.</strong> No part of the
                pipeline has been switched off.
              </AlertDescription>
            </Alert>
          )}

          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-body-lg">Timing</CardTitle>
              </CardHeader>
              <CardContent>
                <Row label="Approval window for a payment" value={`${policy.intentTtlSeconds}s`} />
                <Separator />
                <Row label="Life of a QR request" value={`${policy.qrTtlSeconds}s`} />
                <Separator />
                <Row
                  label="Tries at the comprehension check"
                  value={String(policy.stepUpMaxAttempts)}
                />
                <p className="mt-4 text-pretty text-small text-secondary-foreground">
                  Once the approval window closes the transaction is dead. A new payment means a
                  new id, a new nonce and a new hash, so a captured approval has nothing left to
                  apply to.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-body-lg">Risk thresholds</CardTitle>
              </CardHeader>
              <CardContent>
                <Row label="Approve" value={`below ${policy.riskThresholds.stepUpThreshold}`} />
                <Separator />
                <Row
                  label="Ask a comprehension check"
                  value={`${policy.riskThresholds.stepUpThreshold} to ${
                    policy.riskThresholds.blockThreshold - 1
                  }`}
                />
                <Separator />
                <Row
                  label="Refuse outright"
                  value={`${policy.riskThresholds.blockThreshold} and above`}
                />
                <p className="mt-4 text-pretty text-small text-secondary-foreground">
                  Scores come from named rules: an unrecognised device, a recipient never paid
                  before, an amount far outside the account&rsquo;s pattern. Every decision lists
                  the rules that produced it, on the payment&rsquo;s own timeline.
                </p>
              </CardContent>
            </Card>
          </div>

          <Card className="mt-5">
            <CardHeader>
              <CardTitle className="text-body-lg">What is not negotiable</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-pretty text-small text-secondary-foreground">
                These are structural rather than tunable, so they have no setting to display. The
                challenge a device signs is the transaction&rsquo;s own hash; a settled payment
                cannot settle twice, enforced by a uniqueness constraint in the ledger rather than
                by application code; and a QR code or a card number carries a reference, never an
                amount or an account.
              </p>
              <Button asChild variant="secondary" className="mt-5 max-md:w-full">
                <Link to="/home">Back to your account</Link>
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
