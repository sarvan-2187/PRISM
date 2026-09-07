/**
 * Route map and app shell.   OWNER: S4
 *
 *   /                  sign in with a passkey
 *   /home              balance, history, quick actions
 *   /pay               send by PRISM ID, card, or saved recipient
 *   /pay/:id           server-authoritative review + approve
 *   /pay/:id/verify    semantic step-up, when risk demands it
 *   /pay/:id/status    outcome
 *   /pay/:id/timeline  full security timeline
 *   /receive           show a signed payment request as a QR
 *   /scan              read one and lock a payment from it
 *   /profile           passkeys registered to this account
 *   /policy            what PRISM is enforcing right now
 *
 * Two content widths, on purpose. The payment flow is a single decision and
 * runs in a narrow column so nothing competes with it. The dashboard views
 * need breadth for history and side-by-side panels.
 */
import { Routes, Route, Navigate, Link, NavLink, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { SessionProvider, useSession } from '@/lib/session';
import { ThemeProvider } from '@/lib/theme';
import { ModeToggle } from '@/components/mode-toggle';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import Landing from '@/pages/Landing';
import Home from '@/pages/Home';
import Pay from '@/pages/Pay';
import Review from '@/pages/Review';
import Verify from '@/pages/Verify';
import Status from '@/pages/Status';
import Timeline from '@/pages/Timeline';
import Receive from '@/pages/Receive';
import Scan from '@/pages/Scan';
import Profile from '@/pages/Profile';
import Policy from '@/pages/Policy';
import AttackDashboard from '@/pages/attacks/Dashboard';
import AttackDetail from '@/pages/attacks/AttackDetail';

/** Views that get the wide column. Everything else is the focused flow. */
const WIDE = ['/home', '/profile', '/policy', '/attacks'];

const NAV = [
  { to: '/home', label: 'Home' },
  { to: '/pay', label: 'Send' },
  { to: '/receive', label: 'Receive' },
  { to: '/scan', label: 'Scan' },
  { to: '/profile', label: 'Passkeys' },
  { to: '/policy', label: 'Policy' },
  { to: '/attacks', label: 'Attack Sim' },
];

/** Inner routes need a session. While it is being fetched, render nothing. */
function RequireSession({ children }: { children: ReactNode }) {
  const { me, loading } = useSession();
  if (loading) return null;
  if (!me) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function guard(element: ReactNode) {
  return <RequireSession>{element}</RequireSession>;
}

function Shell() {
  const { pathname } = useLocation();
  const { me, signOut } = useSession();

  const wide = WIDE.includes(pathname) || pathname.startsWith('/attacks');
  // The landing hero runs edge to edge and under the header, so on that one
  // route the shell stops constraining and the header stops painting.
  const bleed = pathname === '/';
  // First name only: this label is read across a table, not up close.
  const shortName = me?.displayName.split(' ')[0] ?? '';
  const account = me?.email.split('@')[0] ?? '';

  /*
   * Each demo account gets its own identity colour, used ONLY on the dot and
   * the strip's left rule. Buttons and links stay blue for both users,
   * because the design system allows exactly one action accent. This is a
   * name tag, not a second accent.
   */
  const identity =
    account === 'asha'
      ? { rule: 'border-l-primary', dot: 'bg-primary' }
      : account === 'priya'
        ? { rule: 'border-l-success-mark', dot: 'bg-success-mark' }
        : { rule: 'border-l-border-strong', dot: 'bg-muted-foreground' };

  return (
    <div className="flex min-h-screen flex-col">
      <header
        className={cn(
          'z-30 flex flex-wrap items-center gap-4 px-6 py-3 max-md:px-4',
          bleed
            ? 'absolute inset-x-0 top-0 border-b-0 bg-transparent'
            : 'sticky top-0 border-b bg-background'
        )}
      >
        <Link
          to={me ? '/home' : '/'}
          className="flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {/* The mark is a prism: one edge in, refracted bands out. Drawn
              inline so it inherits the theme rather than shipping two files. */}
          <svg viewBox="0 0 32 32" className="size-[18px] shrink-0" aria-hidden="true">
            <rect width="32" height="32" rx="8" className="fill-primary" />
            <path d="M15 4 L21 4 L11 28 L5 28 Z" fill="#fff" opacity="0.92" />
            <path d="M26 4 L30 4 L22 28 L18 28 Z" fill="#fff" opacity="0.5" />
          </svg>
          <span className="leading-tight">
            PRISM
            <span className="block text-caption font-normal text-secondary-foreground">
              Payment Risk &amp; Intent Security Model
            </span>
          </span>
        </Link>

        {me && (
          <nav
            aria-label="Main"
            className="order-3 -mx-1 flex w-full items-center gap-1 overflow-x-auto px-1 pb-0.5 md:order-none md:ml-4 md:w-auto md:overflow-visible md:pb-0 [&::-webkit-scrollbar]:hidden"
          >
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'whitespace-nowrap rounded-md px-2.5 py-1.5 text-small font-medium transition-colors duration-hover',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                    isActive
                      ? 'bg-muted text-foreground'
                      : 'text-secondary-foreground hover:bg-accent hover:text-foreground'
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}

        <div className="ml-auto flex items-center gap-2">
          <ModeToggle />
          {me && (
            <Button variant="ghost" size="sm" onClick={signOut}>
              Sign out
            </Button>
          )}
        </div>
      </header>

      {me && (
        <div
          className={cn(
            'flex items-center gap-3 border-b border-l-[3px] bg-secondary px-6 py-2 text-small max-md:px-4',
            identity.rule
          )}
        >
          <span className={cn('size-2.5 shrink-0 rounded-full', identity.dot)} aria-hidden="true" />
          <span className="font-semibold">{shortName}</span>
          <span className="truncate text-secondary-foreground max-sm:hidden">{me.email}</span>
          <span className="ml-auto font-semibold tabular">{me.balanceFormatted}</span>
        </div>
      )}

      <main
        className={cn(
          'w-full flex-1',
          bleed
            ? ''
            : cn(
                'mx-auto px-6 pb-16 pt-8 max-md:px-4 max-md:pb-12 max-md:pt-6',
                wide ? 'max-w-[1280px]' : 'max-w-[640px]'
              )
        )}
      >
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/policy" element={<Policy />} />
          <Route path="/home" element={guard(<Home />)} />
          <Route path="/pay" element={guard(<Pay />)} />
          <Route path="/pay/:txId" element={guard(<Review />)} />
          <Route path="/pay/:txId/verify" element={guard(<Verify />)} />
          <Route path="/pay/:txId/status" element={guard(<Status />)} />
          <Route path="/pay/:txId/timeline" element={guard(<Timeline />)} />
          <Route path="/receive" element={guard(<Receive />)} />
          <Route path="/scan" element={guard(<Scan />)} />
          {/* Not behind guard(): the Attack Simulation Dashboard is gated by its own
              operator token (ATTACK_ADMIN_TOKEN), independent of a PRISM user session —
              the "attacker" and the operator running the demo need not be signed in as
              any PRISM user at all. */}
          <Route path="/attacks" element={<AttackDashboard />} />
          <Route path="/attacks/:scenarioId" element={<AttackDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer className="border-t px-6 py-4 text-center text-caption text-muted-foreground">
        Demo system. Money is internal to PRISM and no real payment rail is involved.
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <SessionProvider>
        <Shell />
      </SessionProvider>
    </ThemeProvider>
  );
}
