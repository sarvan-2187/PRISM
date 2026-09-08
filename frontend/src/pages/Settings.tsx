/**
 * Settings — Passkey & Device Management.   OWNER: S4
 *
 * Two tabs, one data source:
 *   Passkeys  — every authenticator on this account, with revoke + add-new.
 *   Devices   — same credentials as a device table with a "This device" badge.
 *
 * "This device" is identified by comparing the credential ID stored in
 * sessionStorage during login (see Landing.tsx) with each credential row.
 * No backend change needed: the browser knows which credential it used.
 *
 * Revoking is immediate and one-way. The key stays on the lost device;
 * PRISM simply stops accepting anything it signs.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  KeyRound,
  Fingerprint,
  RefreshCw,
  ShieldCheck,
  MonitorSmartphone,
  Plus,
  Laptop,
  Smartphone,
  ShieldAlert,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { api, ApiError, type AuthenticatorDevice } from '@/lib/api-client';
import { webauthn, describeWebAuthnError } from '@/lib/webauthn-client';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Credential {
  id: string;
  deviceType: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// ── Shared hook ───────────────────────────────────────────────────────────────

function useCreds() {
  const [creds, setCreds] = useState<Credential[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setCreds(await api.credentials());
    } catch (err) {
      setLoadError(
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
    setActionError(null);
    try {
      await api.revoke(id);
      setConfirming(null);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? `${err.failureCode}: ${err.message}` : String(err));
    } finally {
      setRevoking(null);
    }
  }

  return { creds, loadError, confirming, setConfirming, revoking, revoke, actionError, load };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACTIVE_CRED_KEY = 'prism.activeCredential';

function isSynced(deviceType: string) {
  return deviceType !== 'singleDevice';
}

function CredIcon({ deviceType, className }: { deviceType: string; className?: string }) {
  return isSynced(deviceType) ? (
    <KeyRound className={className} aria-hidden="true" />
  ) : (
    <Fingerprint className={className} aria-hidden="true" />
  );
}

function deviceLabel(deviceType: string) {
  return deviceType === 'singleDevice' ? 'This device only' : 'Synced passkey';
}

function ThisDeviceBadge() {
  return (
    <Badge
      variant="outline"
      className="border-primary/40 bg-primary/10 text-primary text-caption"
    >
      This device
    </Badge>
  );
}

// ── Inline revoke confirm — two clicks, no modal ──────────────────────────────

function RevokeControls({
  id,
  confirming,
  revoking,
  onConfirm,
  onRevoke,
  onCancel,
}: {
  id: string;
  confirming: string | null;
  revoking: string | null;
  onConfirm: (id: string) => void;
  onRevoke: (id: string) => void;
  onCancel: () => void;
}) {
  const isConfirming = confirming === id;
  const isRevoking = revoking === id;

  if (isConfirming) {
    return (
      <div className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => onRevoke(id)}
          disabled={isRevoking}
        >
          {isRevoking ? 'Revoking…' : 'Confirm revoke'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isRevoking}>
          Keep it
        </Button>
      </div>
    );
  }

  return (
    <Button variant="secondary" size="sm" onClick={() => onConfirm(id)}>
      Revoke
    </Button>
  );
}

// ── Add Passkey Button ────────────────────────────────────────────────────────

function AddPasskeyButton({ email, onSuccess }: { email: string; onSuccess: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    setBusy(true);
    setError(null);
    try {
      const options = await api.registerOptions(email);
      const response = await webauthn.register(options);
      await api.registerVerify(email, response);
      onSuccess();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.failureCode}: ${err.message}`
          : describeWebAuthnError(err)
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant="secondary" size="sm" onClick={handleAdd} disabled={busy}>
        <Plus />
        {busy ? 'Adding…' : 'Add a passkey on this device'}
      </Button>

      {error && (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function NoPasskeys({ signOut }: { signOut: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong px-6 py-10 text-center">
      <h3 className="font-semibold">No active passkeys</h3>
      <p className="mx-auto mt-2 max-w-[44ch] text-pretty text-small text-secondary-foreground">
        Every passkey on this account has been revoked. Register a new one from the sign-in screen
        to use this account again.
      </p>
      <Button variant="secondary" className="mt-5" onClick={signOut}>
        Sign out and register again
      </Button>
    </div>
  );
}

// ── Tab: Passkeys ─────────────────────────────────────────────────────────────

function PasskeysTab({
  creds,
  loadError,
  confirming,
  setConfirming,
  revoking,
  revoke,
  actionError,
  load,
  email,
  signOut,
}: ReturnType<typeof useCreds> & { email: string; signOut: () => void }) {
  const activeId = sessionStorage.getItem(ACTIVE_CRED_KEY);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)] lg:items-start">
      {/* Main list */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-body-lg font-semibold">Registered authenticators</h2>
            <Button variant="ghost" size="sm" onClick={load}>
              <RefreshCw />
              Refresh
            </Button>
          </div>

          {(loadError || actionError) && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{loadError ?? actionError}</AlertDescription>
            </Alert>
          )}

          {!creds && !loadError && (
            <div className="mt-5 grid gap-3" aria-busy="true">
              <Skeleton className="h-3.5 w-[55%]" />
              <Skeleton className="h-3.5 w-[35%]" />
              <Skeleton className="mt-2 h-3.5 w-[45%]" />
              <Skeleton className="h-3.5 w-[30%]" />
            </div>
          )}

          {creds?.length === 0 && <NoPasskeys signOut={signOut} />}

          {creds && creds.length > 0 && (
            <>
              {creds.map((c, i) => (
                <div key={c.id}>
                  {i > 0 && <Separator />}
                  <div className="flex flex-wrap items-start justify-between gap-4 py-4">
                    <div className="flex min-w-0 flex-1 basis-60 gap-3">
                      <CredIcon
                        deviceType={c.deviceType}
                        className="mt-0.5 size-4 shrink-0 text-secondary-foreground"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="font-medium">{deviceLabel(c.deviceType)}</strong>
                          {c.id === activeId && <ThisDeviceBadge />}
                        </div>
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
                    </div>
                    <div className="shrink-0">
                      <RevokeControls
                        id={c.id}
                        confirming={confirming}
                        revoking={revoking}
                        onConfirm={setConfirming}
                        onRevoke={revoke}
                        onCancel={() => setConfirming(null)}
                      />
                    </div>
                  </div>
                </div>
              ))}
              <p className="mt-2 text-pretty text-small text-secondary-foreground">
                Revoking is immediate and cannot be undone. The key stays on the lost device; PRISM
                simply stops accepting anything it signs.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Sidebar */}
      <aside className="grid gap-5">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-body-lg">
              <Plus className="size-4 text-primary" aria-hidden="true" />
              Add this device
            </CardTitle>
            <CardDescription>
              Register a passkey for the device you are on right now. It will appear in this list
              and can be revoked independently.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AddPasskeyButton email={email} onSuccess={load} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-body-lg">
              <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
              How passkeys protect you
            </CardTitle>
            <CardDescription>
              The private key never leaves the device it was created on. Revoking a passkey is the
              right response to a lost or stolen device — not a password reset.
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
  );
}

// ── Tab: Devices ──────────────────────────────────────────────────────────────

function DevicesTab({
  creds,
  loadError,
  confirming,
  setConfirming,
  revoking,
  revoke,
  actionError,
  load,
  signOut,
}: ReturnType<typeof useCreds> & { signOut: () => void }) {
  const activeId = sessionStorage.getItem(ACTIVE_CRED_KEY);

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-body-lg font-semibold">Registered devices</h2>
          <Button variant="ghost" size="sm" onClick={load}>
            <RefreshCw />
            Refresh
          </Button>
        </div>

        <p className="mt-1 text-small text-secondary-foreground">
          Each entry is a device that holds a passkey for this account.
        </p>

        {(loadError || actionError) && (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{loadError ?? actionError}</AlertDescription>
          </Alert>
        )}

        {!creds && !loadError && (
          <div className="mt-5 grid gap-4" aria-busy="true">
            {[1, 2].map((n) => (
              <div key={n} className="flex items-center gap-4">
                <Skeleton className="size-8 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-[40%]" />
                  <Skeleton className="h-3 w-[60%]" />
                </div>
              </div>
            ))}
          </div>
        )}

        {creds?.length === 0 && <NoPasskeys signOut={signOut} />}

        {creds && creds.length > 0 && (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-small">
              <thead>
                <tr className="border-b text-left text-secondary-foreground">
                  <th className="pb-2 pr-4 font-medium">Device</th>
                  <th className="pb-2 pr-4 font-medium">Added</th>
                  <th className="pb-2 pr-4 font-medium">Last used</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {creds.map((c) => {
                  const isThis = c.id === activeId;
                  return (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          {isSynced(c.deviceType) ? (
                            <MonitorSmartphone
                              className="size-4 shrink-0 text-secondary-foreground"
                              aria-hidden="true"
                            />
                          ) : (
                            <Laptop
                              className="size-4 shrink-0 text-secondary-foreground"
                              aria-hidden="true"
                            />
                          )}
                          <div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium">{deviceLabel(c.deviceType)}</span>
                              {isThis && <ThisDeviceBadge />}
                            </div>
                            <p className="mt-0.5 break-all font-mono text-caption text-muted-foreground">
                              {c.id.slice(0, 20)}…
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-secondary-foreground">
                        {relativeTime(c.createdAt)}
                      </td>
                      <td className="py-3 pr-4 text-secondary-foreground">
                        {c.lastUsedAt ? relativeTime(c.lastUsedAt) : '—'}
                      </td>
                      <td className="py-3 pr-4">
                        <Badge
                          variant="outline"
                          className="border-success-mark/30 bg-success-mark/10 text-success-mark"
                        >
                          Active
                        </Badge>
                      </td>
                      <td className="py-3">
                        <RevokeControls
                          id={c.id}
                          confirming={confirming}
                          revoking={revoking}
                          onConfirm={setConfirming}
                          onRevoke={revoke}
                          onCancel={() => setConfirming(null)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-4 text-pretty text-small text-secondary-foreground">
              Revoking a device is immediate and permanent. The passkey stays on the hardware but
              PRISM will refuse any signature it produces.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────


/* -- Authenticator: the paired second device ---------------------------- */

/**
 * Pairing shows the device secret on screen as a QR and never receives it
 * back. The phone photographs it; nothing carrying the secret is ever sent
 * from the phone to the server, which matters because the demo LAN may be
 * plain HTTP. Same shape as an otpauth:// enrolment URI.
 *
 * Confirmation happens HERE rather than on the phone: the route requires a
 * session and the phone has no cookie.
 */
function AuthenticatorTab() {
  const [state, setState] = useState<{ paired: boolean; device: AuthenticatorDevice | null } | null>(
    null
  );
  const [offer, setOffer] = useState<{ deviceId: string; secret: string } | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.authenticator());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach PRISM.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Local countdown on the pairing window. The server enforces expiry; this
  // only stops someone photographing a code that is already dead.
  useEffect(() => {
    if (left <= 0) return;
    const id = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [left]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const o = await api.pairStart();
      setOffer({ deviceId: o.deviceId, secret: o.secret });
      setLeft(o.expiresInSeconds);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start pairing.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!offer) return;
    setConfirming(true);
    setError(null);
    try {
      await api.pairConfirm(offer.deviceId);
      setOffer(null);
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.failureCode === 'AUTH_FAILED'
            ? 'That pairing expired. Generate a new code.'
            : err.message
          : 'Could not confirm pairing.'
      );
    } finally {
      setConfirming(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      await api.authenticatorRevoke();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke.');
    } finally {
      setBusy(false);
    }
  }

  const uri = offer
    ? 'prism://pair?d=' + encodeURIComponent(offer.deviceId) + '&s=' + encodeURIComponent(offer.secret)
    : '';
  const expired = Boolean(offer) && left <= 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-body-lg">
          <Smartphone className="size-4" />
          PRISM Authenticator
        </CardTitle>
        <CardDescription>
          A paired phone turns a refused high-risk payment into one you can still approve, on a
          device an attacker does not hold. It also lets you report a payment as fraud with a code
          that looks exactly like an approval.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-5">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!state && <Skeleton className="h-14 w-full" />}

        {state?.paired && state.device && !offer && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4">
              <div className="flex items-center gap-3">
                <ShieldCheck className="size-5 shrink-0 text-success" />
                <div>
                  <p className="font-medium">Phone paired</p>
                  <p className="text-caption text-secondary-foreground">
                    since {relativeTime(state.device.confirmedAt ?? state.device.createdAt)}
                  </p>
                </div>
              </div>
              <Button variant="destructive" size="sm" onClick={revoke} disabled={busy}>
                Revoke
              </Button>
            </div>
            <p className="mt-3 text-small text-secondary-foreground">
              Lost the phone? Revoking is immediate and one-way. High-risk payments go back to being
              refused outright.
            </p>
            <Button variant="secondary" className="mt-4" onClick={start} disabled={busy}>
              Pair a different phone
            </Button>
          </>
        )}

        {state && !state.paired && !offer && (
          <div className="rounded-lg border border-dashed border-border-strong px-6 py-8 text-center">
            <ShieldAlert className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 font-medium">No phone paired</p>
            <p className="mx-auto mt-1 max-w-[46ch] text-pretty text-small text-secondary-foreground">
              Without one, a payment PRISM scores as high risk is refused with no way through.
            </p>
            <Button className="mt-5" onClick={start} disabled={busy}>
              {busy ? 'Preparing...' : 'Pair a phone'}
            </Button>
          </div>
        )}

        {offer && (
          <div className="grid gap-6 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
            {/* Light plate in both themes: a phone camera reads this across a
                table, and contrast is what the camera needs. */}
            <div className="qr-plate mx-auto" aria-label="Pairing QR code">
              <QRCodeSVG value={uri} size={196} level="M" includeMargin />
            </div>

            <div>
              <p className="font-medium">Scan this with PRISM Authenticator</p>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-small text-secondary-foreground">
                <li>Open the app on your phone and enter this portal&rsquo;s address.</li>
                <li>
                  Tap <strong className="font-medium text-foreground">Scan pairing code</strong>.
                </li>
                <li>Come back here and confirm.</li>
              </ol>

              <p
                className={
                  expired
                    ? 'mt-4 text-small text-destructive'
                    : 'mt-4 text-small text-secondary-foreground'
                }
              >
                {expired ? 'This code has expired.' : 'Valid for ' + left + 's'}
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={confirm} disabled={confirming || expired}>
                  {confirming ? 'Confirming...' : 'I have scanned it'}
                </Button>
                <Button variant="secondary" onClick={start} disabled={busy}>
                  New code
                </Button>
                <Button variant="ghost" onClick={() => setOffer(null)}>
                  Cancel
                </Button>
              </div>

              <p className="mt-4 text-pretty text-caption text-muted-foreground">
                The secret in this code is shown to your screen only. The phone never sends it back,
                so it is never on the network.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { me, signOut } = useSession();
  const creds = useCreds();

  return (
    <div className="animate-enter-up">
      <div className="mb-8">
        <h1 className="text-h2 font-semibold max-md:text-h3">Settings</h1>
        <p className="mt-2 max-w-[60ch] text-pretty text-small text-secondary-foreground">
          Manage the passkeys and devices that can approve payments on this account.
        </p>
      </div>

      {/* Account strip */}
      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-small">
            <div>
              <dt className="text-secondary-foreground">Name</dt>
              <dd className="mt-0.5 font-medium">{me?.displayName ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-secondary-foreground">PRISM ID</dt>
              <dd className="mt-0.5 font-medium">{me?.email ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-secondary-foreground">Balance</dt>
              <dd className="mt-0.5 font-medium tabular">{me?.balanceFormatted ?? '—'}</dd>
            </div>
          </dl>
          <Button variant="secondary" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </CardContent>
      </Card>

      <Tabs defaultValue="passkeys">
        <TabsList className="mb-6">
          <TabsTrigger value="passkeys">
            <KeyRound className="size-3.5" />
            Passkeys
          </TabsTrigger>
          <TabsTrigger value="devices">
            <MonitorSmartphone className="size-3.5" />
            Devices
          </TabsTrigger>
          <TabsTrigger value="authenticator">
            <Smartphone className="size-3.5" />
            Authenticator
          </TabsTrigger>
        </TabsList>

        <TabsContent value="passkeys">
          <PasskeysTab {...creds} email={me?.email ?? ''} signOut={signOut} />
        </TabsContent>

        <TabsContent value="devices">
          <DevicesTab {...creds} signOut={signOut} />
        </TabsContent>

        <TabsContent value="authenticator">
          <AuthenticatorTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
