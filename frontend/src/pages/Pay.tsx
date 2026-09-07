/**
 * Payment composer. Choose who to pay, enter an amount, lock the intent.
 *
 * Three ways to address a payment, one settlement path. Whichever tab is
 * used, the server returns a transaction and the review screen reads the
 * recipient back from PRISM's own records, so an ID or a card is a POINTER
 * and never a source of truth. That is the same rule the QR flow follows.
 *
 * Amounts are entered in rupees and sent in paise. The conversion happens
 * once, in rupeesToPaise, and rounds rather than truncates. Nothing
 * downstream ever sees a decimal: the amount is hashed into the intent, and a
 * value that can be formatted two ways can be hashed two ways.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AtSign, CreditCard, Users } from 'lucide-react';
import { api, ApiError, Payee, cardsEnabled } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { rupeesToPaise } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/**
 * Demo presets.
 *
 * The risk engine grades an amount against the payer's LARGEST settled
 * payment (seeded at Rs 1,981), and a never-paid recipient is its strongest
 * single signal. These three combinations therefore reach three different
 * decisions from the same browser, with no profile switching:
 *
 *   known payee, ordinary        ->  score 0    APPROVE
 *   stranger, 3x-50x usual       ->  score 60   STEP_UP
 *   stranger, over 50x usual     ->  score 85   BLOCK
 *
 * Nothing here is faked: the engine is the real one and these merely fill the
 * form. Run `npm run db:reset && npm run db:seed` between full rehearsals.
 * Once a large payment settles it becomes the new normal and the bands move.
 */
const PRESETS = [
  {
    label: 'Everyday payment',
    match: 'Priya',
    rupees: 2000,
    expect: 'approve',
    variant: 'success',
    hint: 'known recipient, ordinary amount',
  },
  {
    label: 'Large, to a stranger',
    match: 'RAJESH',
    rupees: 25000,
    expect: 'step up',
    variant: 'warning',
    hint: 'never paid before, well above your usual',
  },
  {
    label: 'Huge, to a stranger',
    match: 'SafeAccount',
    rupees: 115000,
    expect: 'block',
    variant: 'destructive',
    hint: 'never paid before, far beyond anything you have sent',
  },
] as const;

/** Groups of 4, the way a card is printed, so it can be read back aloud. */
function formatCardNumber(raw: string): string {
  return (raw.match(/.{1,4}/g) ?? []).join(' ');
}

export default function Pay() {
  const navigate = useNavigate();
  const { me } = useSession();

  const [payees, setPayees] = useState<Payee[] | null>(null);
  const [mode, setMode] = useState('id');
  const [handle, setHandle] = useState('');
  const [cardDigits, setCardDigits] = useState('');
  const [payeeId, setPayeeId] = useState('');
  const [rupees, setRupees] = useState('2000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardsOn, setCardsOn] = useState<boolean | null>(null);

  useEffect(() => {
    api.payees().then(
      (list) => {
        setPayees(list);
        if (list.length) setPayeeId(list[0].accountId);
      },
      () => setError('Could not load recipients. Check that the backend is running.')
    );
    // Probed, not assumed. The card tab is honest before the endpoint exists
    // and lights up on its own the moment it does.
    void cardsEnabled().then(setCardsOn);
  }, []);

  const amountMinor = rupeesToPaise(rupees);
  const amountOk = Number.isInteger(amountMinor) && amountMinor > 0;
  const affordable = me ? amountMinor <= me.balanceMinor : true;

  // A PRISM ID is resolved against the account list the server already gave
  // us, so this is a real lookup and not a guess.
  const typed = handle.trim().toLowerCase();
  const matched = payees?.find((p) => p.handle.toLowerCase() === typed) ?? null;
  const idReady = typed.length > 0 && matched !== null;

  const cardReady = cardsOn === true && cardDigits.length >= 12;
  const savedReady = payeeId !== '';

  const recipientReady =
    mode === 'id' ? idReady : mode === 'card' ? cardReady : savedReady;
  const canSubmit = amountOk && recipientReady && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // Nothing is carried across. The review screen re-fetches from the
      // server, which is what makes tampering pointless.
      const tx =
        mode === 'card'
          ? await api.initiateByCard(cardDigits, amountMinor)
          : await api.initiate(mode === 'id' ? matched!.accountId : payeeId, amountMinor);
      navigate(`/pay/${tx.txId}`);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.failureCode}: ${err.message}` : String(err));
      setBusy(false);
    }
  }

  function applyPreset(match: string, amount: number) {
    const target = payees?.find((p) => p.displayName.includes(match));
    if (target) setPayeeId(target.accountId);
    setRupees(String(amount));
    setMode('saved');
    setError(null);
  }

  return (
    <div className="animate-enter-up">
      <h1 className="text-h3 font-semibold">Send a payment</h1>
      <p className="mt-2 text-small text-secondary-foreground">
        {me ? `${me.balanceFormatted} available` : 'Loading your balance…'}
      </p>

      <Card className="mt-5">
        <CardContent className="pt-6">
          {!payees && !error && (
            <div className="grid gap-3" aria-busy="true">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-3.5 w-[40%]" />
            </div>
          )}

          {payees && (
            <>
              <Label className="mb-2">Who are you paying?</Label>
              <Tabs value={mode} onValueChange={setMode}>
                <TabsList>
                  <TabsTrigger value="id">
                    <AtSign aria-hidden="true" />
                    PRISM ID
                  </TabsTrigger>
                  <TabsTrigger value="card">
                    <CreditCard aria-hidden="true" />
                    Card
                  </TabsTrigger>
                  <TabsTrigger value="saved">
                    <Users aria-hidden="true" />
                    Saved
                  </TabsTrigger>
                </TabsList>

                {/* ── PRISM ID ─────────────────────────────────────── */}
                <TabsContent value="id" className="grid gap-2">
                  <Label htmlFor="handle">Recipient&rsquo;s PRISM ID</Label>
                  <Input
                    id="handle"
                    value={handle}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="name@prism"
                    aria-describedby="handle-help"
                    onChange={(e) => setHandle(e.target.value)}
                  />
                  {typed.length === 0 ? (
                    <p id="handle-help" className="text-small text-secondary-foreground">
                      Every PRISM account has an ID that looks like an email but is not one.
                      Yours is on the Receive screen.
                    </p>
                  ) : matched ? (
                    <div
                      id="handle-help"
                      className="attested rounded-md bg-secondary py-3 pr-3 text-small"
                    >
                      Resolves to <strong className="font-semibold">{matched.displayName}</strong>
                      {!matched.knownPayee && (
                        <Badge variant="warning" className="ml-2">
                          never paid before
                        </Badge>
                      )}
                      <span className="mt-1 block text-caption text-muted-foreground">
                        Confirmed against PRISM&rsquo;s records, not typed by you
                      </span>
                    </div>
                  ) : (
                    <p id="handle-help" className="text-small text-destructive">
                      No PRISM account has that ID. Check the spelling with the person you are
                      paying.
                    </p>
                  )}
                </TabsContent>

                {/* ── Card ─────────────────────────────────────────── */}
                <TabsContent value="card" className="grid gap-2">
                  {cardsOn === null && (
                    <div className="grid gap-2" aria-busy="true">
                      <Skeleton className="h-9 w-full" />
                      <Skeleton className="h-3.5 w-[55%]" />
                    </div>
                  )}

                  {cardsOn === false && (
                    // TODO(S4): remove this branch once S1 ships the cards
                    // table and the payeeCardNumber branch of /payment/initiate.
                    // The form below is written and switches on automatically.
                    <Alert variant="warning">
                      <AlertDescription>
                        <strong className="font-medium">
                          Card transfers are not enabled on this build.
                        </strong>{' '}
                        The screen is finished and waiting on the backend: a card lookup, and a{' '}
                        <code className="font-mono">payeeCardNumber</code> branch on{' '}
                        <code className="font-mono">/payment/initiate</code>. It turns on by
                        itself when those land. Use PRISM ID or Saved in the meantime.
                      </AlertDescription>
                    </Alert>
                  )}

                  {cardsOn === true && (
                    <>
                      <Label htmlFor="card">Recipient&rsquo;s card number</Label>
                      <Input
                        id="card"
                        inputMode="numeric"
                        autoComplete="off"
                        value={formatCardNumber(cardDigits)}
                        placeholder="0000 0000 0000 0000"
                        aria-describedby="card-help"
                        className="font-mono tabular tracking-[0.08em]"
                        onChange={(e) =>
                          setCardDigits(e.target.value.replace(/\D/g, '').slice(0, 19))
                        }
                      />
                      <p id="card-help" className="text-pretty text-small text-secondary-foreground">
                        The card only points at an account. PRISM resolves it and the next screen
                        shows the real recipient&rsquo;s name before you approve anything, so a
                        card that resolves somewhere unexpected is visible in time.
                      </p>
                    </>
                  )}
                </TabsContent>

                {/* ── Saved recipients ─────────────────────────────── */}
                <TabsContent value="saved" className="grid gap-2">
                  <fieldset className="grid gap-2">
                    <legend className="sr-only">Saved recipients</legend>
                    {payees.map((p) => {
                      const active = p.accountId === payeeId;
                      return (
                        <label
                          key={p.accountId}
                          className={cn(
                            'flex cursor-pointer items-center gap-3 rounded-md border p-3 text-small transition-colors duration-hover',
                            'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
                            active
                              ? 'border-primary bg-primary-subtle'
                              : 'border-border hover:bg-accent'
                          )}
                        >
                          <input
                            type="radio"
                            name="payee"
                            value={p.accountId}
                            checked={active}
                            onChange={() => setPayeeId(p.accountId)}
                            className="sr-only"
                          />
                          <span
                            aria-hidden="true"
                            className={cn(
                              'size-4 shrink-0 rounded-full border-2',
                              active ? 'border-primary bg-primary' : 'border-input'
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{p.displayName}</span>
                            <span className="block truncate text-caption text-secondary-foreground">
                              {p.handle}
                            </span>
                          </span>
                          {!p.knownPayee && <Badge variant="warning">new</Badge>}
                        </label>
                      );
                    })}
                  </fieldset>
                </TabsContent>
              </Tabs>

              <div className="mt-6 grid gap-2">
                <Label htmlFor="amount">Amount (₹)</Label>
                <Input
                  id="amount"
                  type="number"
                  min="1"
                  step="1"
                  value={rupees}
                  aria-describedby="amount-help"
                  onChange={(e) => setRupees(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && canSubmit && submit()}
                />
                <p id="amount-help" className="text-small text-secondary-foreground">
                  Sent as {amountMinor.toLocaleString('en-IN')} paise, with no decimal anywhere in
                  the request.
                </p>
              </div>

              {!affordable && amountOk && (
                <Alert variant="warning" className="mt-4">
                  <AlertDescription>
                    That is more than the {me?.balanceFormatted} in this account. PRISM will refuse
                    it at settlement with INSUFFICIENT_FUNDS, which is an ordinary business rule
                    and not a security decision.
                  </AlertDescription>
                </Alert>
              )}

              <Button block className="mt-4" onClick={submit} disabled={!canSubmit}>
                {busy ? 'Locking this transaction…' : 'Review this payment'}
              </Button>
            </>
          )}

          {error && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {payees && (
        <section className="mt-8 border-t pt-5">
          <h2 className="text-body-lg font-semibold">Demo scenarios</h2>
          <p className="mb-4 mt-1 text-small text-secondary-foreground">
            Each one fills the form so the real risk engine reaches a different decision. The
            engine is not stubbed; only the form is.
          </p>
          <div className="grid gap-2">
            {PRESETS.map((p) => (
              <Button
                key={p.label}
                variant="secondary"
                block
                className="h-auto justify-between gap-3 py-3 text-left font-normal"
                onClick={() => applyPreset(p.match, p.rupees)}
              >
                <span className="min-w-0">
                  <strong className="font-medium">{p.label}</strong>
                  <span className="block truncate text-caption text-secondary-foreground">
                    {p.hint}
                  </span>
                </span>
                <Badge variant={p.variant}>{p.expect}</Badge>
              </Button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
