/**
 * Receive. Mint a signed payment request and show it as a QR code.
 *
 * The code carries a reference and a signature, never an amount or an account
 * number. The payer's device sends that reference back and PRISM looks up who
 * and how much from its own records, which is why swapping a printed sticker
 * cannot redirect a payment: an attacker's code points at the attacker, and
 * the payer's review screen says so in plain words before they approve.
 *
 * The balance is polled here and only here. This is the one screen where the
 * user is waiting for something to arrive from outside.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { usePoll } from '@/lib/usePoll';
import { rupeesToPaise } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export default function Receive() {
  const { me, refresh } = useSession();
  const [rupees, setRupees] = useState('250');
  const [token, setToken] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [received, setReceived] = useState<string | null>(null);

  // Last balance seen, so an increase can be reported the moment it lands.
  const lastBalance = useRef<number | null>(me?.balanceMinor ?? null);

  const amountMinor = rupeesToPaise(rupees);
  const valid = Number.isInteger(amountMinor) && amountMinor > 0;

  const { rateLimited } = usePoll(api.me, 4000, {
    onData: (fresh) => {
      const previous = lastBalance.current;
      lastBalance.current = fresh.balanceMinor;
      if (previous !== null && fresh.balanceMinor > previous) {
        const delta = (fresh.balanceMinor - previous) / 100;
        setReceived(delta.toLocaleString('en-IN', { style: 'currency', currency: 'INR' }));
        setToken(null);
        void refresh();
      }
    },
  });

  // Local countdown. The expiry is the server's; this only shows it.
  useEffect(() => {
    if (remaining <= 0) return;
    const t = setInterval(() => setRemaining((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [remaining]);

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    setReceived(null);
    try {
      const req = await api.requestQr(amountMinor);
      setToken(req.token);
      setRemaining(req.expiresInSeconds);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.failureCode}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }, [amountMinor]);

  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('This browser blocked clipboard access. Select the code below and copy it.');
    }
  }

  const expired = token !== null && remaining <= 0;

  return (
    <div className="animate-enter-up">
      <h1 className="text-h3 font-semibold">Request a payment</h1>
      <p className="mt-2 text-small text-secondary-foreground">
        Signed in as {me?.displayName}. Anyone who scans this pays you, and only you.
      </p>

      {received && (
        <Alert variant="success" className="mt-4">
          <AlertDescription>
            <strong className="font-medium">{received} received.</strong> Your balance is now{' '}
            {me?.balanceFormatted}.
          </AlertDescription>
        </Alert>
      )}

      {rateLimited && (
        <Alert variant="warning" className="mt-4">
          <AlertDescription>
            PRISM is rate limiting this browser, so the balance stopped updating on its own.
            Reload the page to see the current figure.
          </AlertDescription>
        </Alert>
      )}

      <Card className="mt-5">
        <CardContent className="grid gap-3 pt-6">
          <div className="grid gap-2">
            <Label htmlFor="amount">Amount to request (₹)</Label>
            <Input
              id="amount"
              type="number"
              min="1"
              step="1"
              value={rupees}
              onChange={(e) => setRupees(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && valid && !busy && generate()}
            />
          </div>
          <Button block onClick={generate} disabled={!valid || busy}>
            {busy ? 'Signing the request…' : token ? 'Generate a new code' : 'Generate code'}
          </Button>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {token ? (
        <Card className="mt-4">
          <CardContent className="pt-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-body-lg font-semibold">Ready to scan</h2>
              {expired ? (
                <Badge variant="destructive">Expired</Badge>
              ) : (
                <Badge variant="info" className="tabular">
                  {remaining}s left
                </Badge>
              )}
            </div>

            <div className={cn('qr-plate', expired && 'opacity-25')}>
              {/* Fixed dark-on-white regardless of theme: this is read by
                  another machine's camera, and scanning beats consistency. */}
              <QRCodeSVG value={token} size={248} level="M" bgColor="#ffffff" fgColor="#0a0a0a" />
            </div>

            {expired ? (
              <p className="mt-4 text-pretty text-small text-secondary-foreground">
                This code has expired and can no longer be used. Generate a new one. Codes are
                short-lived and single-use so that a photographed or reprinted code is worthless.
              </p>
            ) : (
              <dl className="mt-5 grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3">
                <dt className="text-small text-secondary-foreground">You are requesting</dt>
                <dd className="m-0 font-semibold tabular">
                  {(amountMinor / 100).toLocaleString('en-IN', {
                    style: 'currency',
                    currency: 'INR',
                  })}
                </dd>
                <dt className="text-small text-secondary-foreground">Paid to</dt>
                <dd className="m-0">{me?.displayName}</dd>
              </dl>
            )}

            <div className="mt-4 flex items-start gap-3 rounded-md bg-muted p-3">
              <code className="max-h-[4.5em] min-w-0 flex-1 overflow-hidden break-all font-mono text-caption text-secondary-foreground">
                {token}
              </code>
              <Button variant="secondary" size="sm" onClick={copyToken}>
                {copied ? <Check /> : <Copy />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="mt-2 text-pretty text-small text-secondary-foreground">
              The payer can scan the code, or paste this text into their Scan screen. It contains a
              reference and a signature. It does not contain the amount or your account number.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center">
          <h3 className="font-semibold">No active request</h3>
          <p className="mx-auto mt-2 max-w-[44ch] text-pretty text-small text-secondary-foreground">
            Enter an amount and generate a code. It stays valid for 60 seconds and can be paid
            once.
          </p>
        </div>
      )}
    </div>
  );
}
