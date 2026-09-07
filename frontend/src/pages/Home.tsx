/**
 * Home. Balance, what this account has sent, and where to go next.
 *
 * The history endpoint returns payments where you are the PAYER, so a
 * receiving account sees an empty table here no matter how much money has
 * arrived. The empty state says that in words rather than implying the
 * account has no activity: money received shows in the balance, and the
 * Receive screen reports it as it lands.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, QrCode, RefreshCw, Radiation } from 'lucide-react';
import { api, ApiError, TransactionView } from '@/lib/api-client';
import { demoSessionRevealEnabled, revealMySession } from '@/lib/demoSessionApi';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/format';
import { statusBadge, STATUS_LABEL } from '@/lib/events';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default function Home() {
  const { me, refresh } = useSession();
  const [history, setHistory] = useState<TransactionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [labEnabled, setLabEnabled] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    void demoSessionRevealEnabled().then(setLabEnabled);
  }, []);

  const copySessionForLab = useCallback(async () => {
    setCopyStatus('idle');
    const cookie = await revealMySession();
    if (!cookie) {
      setCopyStatus('error');
      return;
    }
    try {
      await navigator.clipboard.writeText(cookie);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  }, []);

  const load = useCallback(async () => {
    setReloading(true);
    setError(null);
    try {
      setHistory(await api.history());
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.failureCode === 'RATE_LIMITED'
            ? 'Too many requests in the last few minutes. Wait a moment, then refresh.'
            : err.message
          : 'Could not reach PRISM. Check that the backend is running on port 4000.'
      );
    } finally {
      setReloading(false);
    }
  }, [refresh]);

  useEffect(() => {
    void load();
    // Deliberately not polled. History changes only when this account pays
    // someone, and that path already returns here with fresh data.
  }, [load]);

  return (
    <div className="animate-enter-up">
      <div className="mb-8 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 basis-80">
          <h1 className="text-balance text-h2 font-semibold max-md:text-h3">
            {me ? `${me.displayName.split(' ')[0]}’s account` : 'Account'}
          </h1>
          <p className="mt-2 max-w-[60ch] text-pretty text-small text-secondary-foreground">
            Every payment below was approved with a passkey signature over that transaction’s own
            hash. Open one to see what PRISM checked before the money moved.
          </p>
        </div>
        <Button asChild className="max-md:w-full">
          <Link to="/pay">Send a payment</Link>
        </Button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-start">
        <section>
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="text-body-lg font-semibold">Payments sent</h2>
            <Button variant="ghost" size="sm" onClick={load} disabled={reloading}>
              <RefreshCw className={reloading ? 'animate-spin' : undefined} />
              {reloading ? 'Refreshing' : 'Refresh'}
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

          {!history && !error && (
            <Card aria-busy="true">
              <CardContent className="grid gap-3 pt-6">
                <p className="text-small text-secondary-foreground">Loading your payments…</p>
                <Skeleton className="h-3.5 w-[70%]" />
                <Skeleton className="h-3.5 w-[45%]" />
                <Skeleton className="h-3.5 w-[60%]" />
              </CardContent>
            </Card>
          )}

          {history && history.length === 0 && (
            <div className="rounded-lg border border-dashed border-border-strong px-6 py-10 text-center">
              <h3 className="font-semibold">No payments sent from this account</h3>
              <p className="mx-auto mt-2 max-w-[44ch] text-pretty text-small text-secondary-foreground">
                This table lists payments you sent. Money you receive is not listed here, but it
                does move your balance, and the Receive screen reports each payment as it lands.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <Button asChild variant="secondary">
                  <Link to="/receive">Request a payment</Link>
                </Button>
                <Button asChild>
                  <Link to="/pay">Send a payment</Link>
                </Button>
              </div>
            </div>
          )}

          {history && history.length > 0 && (
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Recipient</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right max-sm:hidden">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((tx) => (
                    <TableRow key={tx.txId}>
                      <TableCell className="max-w-0">
                        <Link
                          to={`/pay/${tx.txId}/timeline`}
                          className="block rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {tx.payeeName}
                        </Link>
                        <span className="block truncate text-caption text-secondary-foreground">
                          {tx.payeeHandle}
                          {tx.failureCode ? ` · ${tx.failureCode}` : ''}
                          {tx.riskReasons.length > 0 ? ` · ${tx.riskReasons[0]}` : ''}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-semibold tabular">
                        {tx.amountFormatted}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusBadge(tx.status)}>
                          {STATUS_LABEL[tx.status] ?? tx.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-secondary-foreground max-sm:hidden">
                        {relativeTime(tx.expiresAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </section>

        <aside className="grid gap-5">
          <Card>
            <CardContent className="pt-6">
              <p className="text-small text-secondary-foreground">Available balance</p>
              <div className="attested mt-2 text-[40px] font-semibold leading-none tracking-[-0.03em] tabular max-md:text-h3">
                {me?.balanceFormatted ?? '—'}
              </div>
              <span className="mt-2 block text-caption text-muted-foreground">
                Read from the ledger, not from this page
              </span>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-body-lg">
                <QrCode className="size-4 text-primary" aria-hidden="true" />
                Receive money
              </CardTitle>
              <CardDescription>
                Show a signed request as a QR code. It carries a reference, never an amount, so a
                swapped sticker cannot change who gets paid.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="secondary" block>
                <Link to="/receive">Show a QR request</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-body-lg">
                <KeyRound className="size-4 text-primary" aria-hidden="true" />
                This device
              </CardTitle>
              <CardDescription>
                Payments from this account can only be approved by a passkey registered to it. Lost
                the device? Revoke its passkey and it stops being able to approve anything.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="secondary" block>
                <Link to="/profile">Manage passkeys</Link>
              </Button>
            </CardContent>
          </Card>

          {labEnabled && (
            <Card className="border-warning-mark">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-body-lg">
                  <Radiation className="size-4 text-destructive" aria-hidden="true" />
                  Attack Lab demo
                </CardTitle>
                <CardDescription>
                  Copies THIS device's real session cookie to the clipboard so an operator can paste it
                  into the Live Attack Lab on another device — a real stolen-cookie demonstration against
                  this real session. Demo-only; disabled in production.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                <Button variant="secondary" block onClick={copySessionForLab}>
                  Copy session for Attack Lab
                </Button>
                {copyStatus === 'copied' && (
                  <span className="text-caption text-success">Copied. Paste it into the Attack Lab's victim-session field.</span>
                )}
                {copyStatus === 'error' && (
                  <span className="text-caption text-destructive">Could not copy — make sure you're signed in.</span>
                )}
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
