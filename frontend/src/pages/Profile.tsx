/**
 * Passkeys registered to this account, and how to revoke one.
 *
 * This is the stolen-device response. The key itself never leaves the device
 * it was created on and cannot be extracted or deleted remotely, so the
 * defence is not "wipe the phone", it is "stop accepting anything that key
 * signs". Revocation is immediate and one-way: there is no un-revoke.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';

interface Credential {
  id: string;
  deviceType: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export default function Profile() {
  const { me, signOut } = useSession();
  const [creds, setCreds] = useState<Credential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The id awaiting a second click. An inline confirm rather than
  // window.confirm, which blocks the page and looks wrong on a projector.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCreds(await api.credentials());
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not reach PRISM. Check that the backend is running.'
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string) {
    setRevoking(id);
    setError(null);
    try {
      await api.revoke(id);
      setConfirming(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.failureCode}: ${err.message}` : String(err));
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="animate-enter-up">
      <div className="mb-8">
        <h1 className="text-h2 font-semibold max-md:text-h3">Passkeys</h1>
        <p className="mt-2 max-w-[60ch] text-pretty text-small text-secondary-foreground">
          A payment from this account can only be approved by one of the passkeys below. Revoking
          one is how you respond to a lost or stolen device.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-start">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-body-lg font-semibold">Registered authenticators</h2>
              <Button variant="ghost" size="sm" onClick={load}>
                <RefreshCw />
                Refresh
              </Button>
            </div>

            {error && (
              <Alert variant="destructive" className="mt-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {!creds && !error && (
              <div className="mt-5 grid gap-3" aria-busy="true">
                <Skeleton className="h-3.5 w-[55%]" />
                <Skeleton className="h-3.5 w-[35%]" />
              </div>
            )}

            {creds && creds.length === 0 && (
              <div className="mt-5 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center">
                <h3 className="font-semibold">No active passkeys</h3>
                <p className="mx-auto mt-2 max-w-[44ch] text-pretty text-small text-secondary-foreground">
                  Every passkey on this account has been revoked, so nothing can approve a payment
                  from it. Register a new one from the sign-in screen to use this account again.
                </p>
                <Button variant="secondary" className="mt-5" onClick={signOut}>
                  Sign out and register again
                </Button>
              </div>
            )}

            {creds?.map((c, i) => {
              const isConfirming = confirming === c.id;
              return (
                <div key={c.id}>
                  {i > 0 && <Separator />}
                  <div className="flex flex-wrap items-start justify-between gap-4 py-4">
                    <div className="min-w-0 flex-1 basis-60">
                      <strong className="font-medium">
                        {c.deviceType === 'singleDevice' ? 'This device only' : 'Synced passkey'}
                      </strong>
                      <p className="mt-1 text-small text-secondary-foreground">
                        Registered {relativeTime(c.createdAt)} ·{' '}
                        {c.lastUsedAt
                          ? `last used ${relativeTime(c.lastUsedAt)}`
                          : 'never used to approve a payment'}
                      </p>
                      <p className="mt-1.5 break-all font-mono text-caption text-muted-foreground">
                        {c.id.slice(0, 28)}…
                      </p>
                    </div>
                    <div className="shrink-0">
                      {isConfirming ? (
                        <div className="flex gap-2">
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => revoke(c.id)}
                            disabled={revoking === c.id}
                          >
                            {revoking === c.id ? 'Revoking…' : 'Confirm revoke'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirming(null)}
                            disabled={revoking === c.id}
                          >
                            Keep it
                          </Button>
                        </div>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => setConfirming(c.id)}>
                          Revoke
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {creds && creds.length > 0 && (
              <p className="mt-4 text-pretty text-small text-secondary-foreground">
                Revoking is immediate and cannot be undone. The key stays on the lost device;
                PRISM simply stops accepting anything it signs.
              </p>
            )}
          </CardContent>
        </Card>

        <aside className="grid gap-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-body-lg">Account</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="text-small">
                <div className="flex items-baseline justify-between gap-4 py-3">
                  <dt className="text-secondary-foreground">Name</dt>
                  <dd className="m-0 text-right font-medium">{me?.displayName ?? '—'}</dd>
                </div>
                <Separator />
                <div className="flex items-baseline justify-between gap-4 py-3">
                  <dt className="text-secondary-foreground">PRISM ID</dt>
                  <dd className="m-0 break-all text-right font-medium">{me?.email ?? '—'}</dd>
                </div>
                <Separator />
                <div className="flex items-baseline justify-between gap-4 py-3">
                  <dt className="text-secondary-foreground">Balance</dt>
                  <dd className="m-0 text-right font-medium tabular">
                    {me?.balanceFormatted ?? '—'}
                  </dd>
                </div>
              </dl>
              <Button variant="secondary" block className="mt-4" onClick={signOut}>
                Sign out
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-body-lg">
                <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
                Adding another device
              </CardTitle>
              <CardDescription>
                A passkey belongs to one device. To use this account on a second laptop, open PRISM
                there and register a passkey for the same email. Both then appear in this list, and
                either can be revoked on its own.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="ghost" block>
                <Link to="/policy">See what PRISM enforces</Link>
              </Button>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
