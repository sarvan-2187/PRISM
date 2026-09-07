/**
 * Landing and passkey sign-in.   OWNER: S4
 *
 * This screen is the reference for how every other page talks to the backend:
 * call `api.*`, catch `ApiError`, switch on `failureCode`. Copy this shape
 * rather than inventing a new one.
 *
 * The account list is fixed because there is no signup endpoint: users come
 * from `npm run db:seed`, and /auth/register/options returns NOT_FOUND for an
 * email that is not already in the database. Saying so on screen is cheaper
 * than a signup form that cannot work.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '@/lib/api-client';
import { webauthn, describeWebAuthnError } from '@/lib/webauthn-client';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const DEMO_USERS = [
  { email: 'asha@prism.demo', name: 'Asha Menon' },
  { email: 'priya@prism.demo', name: 'Priya Sharma' },
];

/** The four things PRISM checks together. Each maps to real backend code. */
const LAYERS = [
  {
    name: 'Person',
    what: 'A passkey signature, not a PIN or an OTP that can be read out over a phone call.',
  },
  {
    name: 'Device',
    what: 'The private key stays in this device’s secure hardware and never reaches us.',
  },
  {
    name: 'Transaction',
    what: 'The challenge your device signs is the transaction’s own hash. Change one rupee and the signature stops verifying.',
  },
  {
    name: 'Context',
    what: 'Device, network and payment history are scored before the money moves, and every decision names the rules that fired.',
  },
];

/**
 * The hero backdrop: a beam entering a prism and refracting into bands.
 *
 * Drawn rather than photographed, for three reasons. It is the product's own
 * mark at full scale, so it means something instead of decorating; it is built
 * from the one accent already in the palette, so it adds no colour; and it
 * costs about two kilobytes instead of a megabyte of stock imagery on a demo
 * that has to survive venue wifi.
 *
 * The centre is deliberately kept clear. The headline sits there, and text
 * over artwork is where contrast normally fails.
 */
function PrismBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <svg
        className="absolute inset-0 size-full"
        viewBox="0 0 1200 800"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          {/* Each band fades in from the prism and dissolves along its
              length, so the fan never ends on a hard edge. */}
          <linearGradient id="band" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0" />
            <stop offset="14%" stopColor="hsl(var(--primary))" stopOpacity="0.95" />
            <stop offset="55%" stopColor="hsl(var(--primary-hover))" stopOpacity="0.7" />
            <stop offset="100%" stopColor="hsl(var(--primary-hover))" stopOpacity="0" />
          </linearGradient>

          <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="hsl(var(--foreground))" stopOpacity="0" />
            <stop offset="70%" stopColor="hsl(var(--foreground))" stopOpacity="0.5" />
            <stop offset="100%" stopColor="hsl(var(--foreground))" stopOpacity="0.75" />
          </linearGradient>

          {/* Atmospheric depth: broad, very soft washes that keep the field
              from reading as flat black or flat white. */}
          <radialGradient id="bloom" cx="43%" cy="46%" r="42%">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.5" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
          </radialGradient>

          <radialGradient id="haze" cx="78%" cy="70%" r="55%">
            <stop offset="0%" stopColor="hsl(var(--primary-hover))" stopOpacity="0.22" />
            <stop offset="100%" stopColor="hsl(var(--primary-hover))" stopOpacity="0" />
          </radialGradient>

          {/*
            A light overall knock-back only. The real protection is a scrim
            on the text block itself (see the div below), because a scrim
            wide enough to guard the paragraph also erases the artwork it is
            drawn over. Measured: without the block scrim the 18px lede fell
            to 3.92:1 in light mode against a 4.5 bar.
          */}
          <radialGradient id="scrim" cx="50%" cy="44%" r="55%">
            <stop offset="0%" stopColor="hsl(var(--background))" stopOpacity="0.55" />
            <stop offset="55%" stopColor="hsl(var(--background))" stopOpacity="0.3" />
            <stop offset="100%" stopColor="hsl(var(--background))" stopOpacity="0" />
          </radialGradient>

          <filter id="soften" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="22" />
          </filter>
          <filter id="soften-lg" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="60" />
          </filter>
        </defs>

        <rect x="0" y="0" width="1200" height="800" fill="url(#bloom)" />
        <rect x="0" y="0" width="1200" height="800" fill="url(#haze)" />

        {/* The incoming beam, before the prism. */}
        <rect x="0" y="356" width="470" height="15" fill="url(#beam)" filter="url(#soften)" />

        {/*
          The refracted fan. One hue, separated by angle and luminance rather
          than by rotating through the spectrum: a rainbow here would put six
          more colours on a page whose design system allows one accent.
        */}
        <g filter="url(#soften)" transform="translate(470 364)">
          {[-26, -18, -11, -5, 1, 7, 14, 22, 31].map((angle, i) => (
            <rect
              key={angle}
              x="0"
              y={-10 - i * 0.5}
              width={980 - i * 30}
              height={20 + i * 2.4}
              rx="10"
              fill="url(#band)"
              opacity={0.92 - i * 0.055}
              transform={`rotate(${angle})`}
            />
          ))}
        </g>

        {/* A wider, far softer echo of the same fan, for depth. */}
        <g filter="url(#soften-lg)" transform="translate(470 364)" opacity="0.55">
          {[-20, -4, 12, 26].map((angle) => (
            <rect
              key={angle}
              x="0"
              y="-26"
              width="1000"
              height="52"
              rx="26"
              fill="url(#band)"
              transform={`rotate(${angle})`}
            />
          ))}
        </g>

        {/* The prism itself: the one crisp edge in the whole composition. */}
        <path
          d="M432 286 L494 286 L470 452 L408 452 Z"
          fill="hsl(var(--primary))"
          opacity="0.5"
        />
        <path
          d="M432 286 L494 286 L470 452 L408 452 Z"
          fill="none"
          stroke="hsl(var(--primary-hover))"
          strokeWidth="1.5"
          opacity="0.8"
        />

        <rect x="0" y="0" width="1200" height="800" fill="url(#scrim)" />
      </svg>

      {/* Fades the artwork into the page rather than stopping at a seam. */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-background" />
    </div>
  );
}

export default function Landing() {
  const navigate = useNavigate();
  const { me, loading, refresh } = useSession();
  const signInRef = useRef<HTMLDivElement | null>(null);
  const [email, setEmail] = useState(DEMO_USERS[0].email);
  const [busy, setBusy] = useState<'login' | 'register' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setSupported(webauthn.supported());
  }, []);

  // Already signed in: this screen has nothing to offer.
  useEffect(() => {
    if (!loading && me) navigate('/home', { replace: true });
  }, [loading, me, navigate]);

  async function run(mode: 'register' | 'login') {
    setBusy(mode);
    setError(null);
    try {
      if (mode === 'register') {
        const options = await api.registerOptions(email);
        const response = await webauthn.register(options);
        await api.registerVerify(email, response);
      } else {
        const options = await api.loginOptions(email);
        const response = await webauthn.approve(options);
        await api.loginVerify(email, response);
      }
      await refresh();
      navigate('/home');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.failureCode}: ${err.message}`
          : describeWebAuthnError(err)
      );
      setBusy(null);
    }
  }

  return (
    <div className="animate-enter-up">
      {/* ── Hero ────────────────────────────────────────────────────── */}
      <section className="relative flex min-h-[86vh] items-center justify-center overflow-hidden px-6 pb-20 pt-32 max-md:min-h-[76vh] max-md:pt-28">
        <PrismBackdrop />

        <div className="relative mx-auto max-w-[54rem] text-center">
          {/*
            The scrim that actually does the work: an ellipse sized to the
            text, not to the canvas. It keeps every line above its contrast
            bar while the artwork stays at full strength everywhere else.
          */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -inset-x-16 -inset-y-12 bg-[radial-gradient(farthest-side,hsl(var(--background))_0%,hsl(var(--background)/0.94)_62%,hsl(var(--background)/0)_100%)] max-md:-inset-x-6"
          />

          {/* `relative` so this paints above the scrim: both are positioned,
              and this one comes later in the DOM. */}
          <div className="relative">
          <h1 className="text-balance font-serif text-[clamp(42px,7.5vw,76px)] leading-[1.03] tracking-[-0.03em]">
            Approval that belongs
            <br className="max-sm:hidden" /> to <em>one</em> payment.
          </h1>

          {/*
            Full-strength foreground, not the usual secondary grey. Over the
            artwork a lighter grey measured 3.81:1 against a 4.5 bar, so the
            hierarchy here is carried by size and typeface instead: 18px sans
            under a 76px serif is already a wide gap.
          */}
          <p className="mx-auto mt-7 max-w-[46ch] text-pretty text-body-lg text-foreground max-md:mt-5 max-md:text-body">
            Your passkey signs the transaction&rsquo;s own fingerprint, not a random number. Capture
            it, replay it, or edit it by one rupee, and it stops being a valid signature for
            anything.
          </p>

          {/*
            One generous radius, used once, on the single most important
            control on the page. Everywhere else the system's 10px applies:
            a pill that appears on every button is a default, a pill that
            appears once is a decision.
          */}
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3 max-md:mt-8">
            <Button
              size="lg"
              className="rounded-full px-8"
              onClick={() =>
                signInRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }
            >
              Sign in with a passkey
            </Button>
            <Button
              asChild
              size="lg"
              variant="ghost"
              className="rounded-full px-6"
            >
              <a href="#how">See what gets checked</a>
            </Button>
          </div>

          </div>
        </div>
      </section>

      {/* ── Sign in ─────────────────────────────────────────────────── */}
      <div className="mx-auto w-full max-w-[640px] px-6 pb-16 max-md:px-4">
        <div ref={signInRef}>
          <Card>
            <CardHeader>
              <CardTitle>Sign in with a passkey</CardTitle>
              <CardDescription>
                A private key stays in this device&rsquo;s secure hardware and never reaches PRISM,
                which only ever sees a signature.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {!supported && (
                <Alert variant="destructive">
                  <AlertDescription>
                    This browser cannot use passkeys. Open PRISM in Chrome, Edge, or Safari over{' '}
                    <code className="font-mono">http://localhost</code> or HTTPS.
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-2">
                <Label htmlFor="account">Demo account</Label>
                <Select value={email} onValueChange={setEmail} disabled={busy !== null}>
                  <SelectTrigger id="account">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEMO_USERS.map((u) => (
                      <SelectItem key={u.email} value={u.email}>
                        {u.name} ({u.email})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button block onClick={() => run('login')} disabled={busy !== null || !supported}>
                {busy === 'login' ? 'Waiting for your passkey…' : 'Sign in with passkey'}
              </Button>
              <Button
                block
                variant="secondary"
                onClick={() => run('register')}
                disabled={busy !== null || !supported}
              >
                {busy === 'register'
                  ? 'Waiting for your passkey…'
                  : 'Register a passkey on this device'}
              </Button>

              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <p className="mt-2 text-pretty text-small text-secondary-foreground">
                First run on this browser or laptop? Register first. A passkey is bound to one
                device, which is the point. These two accounts are loaded by the database seed;
                PRISM has no public signup.
              </p>
            </CardContent>
          </Card>

          {/* ── What gets checked ─────────────────────────────────── */}
          <section id="how" className="scroll-mt-24 pt-16">
            <h2 className="text-center font-serif text-h2 max-md:text-h3">
              Four things, checked together
            </h2>
            <p className="mx-auto mt-3 max-w-[48ch] text-pretty text-center text-small text-secondary-foreground">
              Any one of them alone can be stolen, copied, or talked around. The point is that they
              have to agree.
            </p>

            <dl className="mt-8 grid gap-px overflow-hidden rounded-lg border bg-border">
              {LAYERS.map((l) => (
                <Fragment key={l.name}>
                  <div className="grid grid-cols-[8rem_1fr] gap-5 bg-card p-5 max-sm:grid-cols-1 max-sm:gap-1">
                    <dt className="font-serif text-h3 leading-none">{l.name}</dt>
                    <dd className="m-0 text-pretty text-small text-secondary-foreground">
                      {l.what}
                    </dd>
                  </div>
                </Fragment>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
