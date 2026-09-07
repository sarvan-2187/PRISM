# PRISM Design System

> A premium, security-first design system for PRISM, the Payment Risk & Intent Security Model.
> The interface should feel trustworthy, precise, and modern without looking like a generic banking dashboard.

**Status:** implemented in `frontend/`. Where this document and the code once disagreed, the code has been
corrected to match, except for five colour values that failed WCAG AA. Those are listed in section 3 with
their measured ratios, and the document has been corrected instead. Section 11 asks for AA, so the
measurement wins over the swatch.

---

## 1. Design Direction

### Visual Identity

- **Primary aesthetic:** Minimal, monochromatic, editorial
- **Accent:** Electric blue for trust, actions, and security states
- **Typography:** Geist for interface text + Instrument Serif for selected editorial emphasis
- **Modes:** Light and dark, with an explicit three-way toggle (Light / Dark / System)
- **Motion:** Subtle, purposeful, and one-shot only
- **Layout:** Generous whitespace, strong hierarchy, clean cards, restrained borders

### Design Principles

1. **Clarity over decoration.** Every element should communicate a purpose.
2. **Trust through precision.** Payment details must be easy to verify.
3. **Progressive disclosure.** Show important information first; reveal technical details when needed.
4. **Consistent feedback.** Every action should have a clear loading, success, or error state.
5. **Motion with meaning.** Animate state changes, not everything on the screen.

### The identity motif

One repeated gesture carries the product's core claim: **the attested-value rule.**

Anything the server asserted, an amount, a recipient, a balance, a resolved PRISM ID, carries a
2px left rule in the primary colour and a caption reading *"Server record, not this page"*. It appears on
Review, Status, Home and the PRISM ID resolver, and it means exactly one thing: this value came from
PRISM, not from the browser. Implemented as `.attested` in `src/styles.css`.

Do not use this rule decoratively. If a value was not read back from the server, it does not get the rule.

---

## 2. Typography

### Font Families

```css
font-family: 'Geist', sans-serif;
font-family: 'Instrument Serif', serif;
```

Loaded from Google Fonts in `index.html` with full system fallback stacks, so a dropped network
degrades to system fonts instead of a blank page.

### Usage

| Font | Use |
|---|---|
| Geist | Navigation, buttons, labels, body text, forms, dashboards |
| Instrument Serif | Hero headings, selected editorial emphasis, large statements |

### Type Scale

Exposed as Tailwind sizes so components never hardcode a pixel value.

| Token | Size | Weight |
|---|---|---|
| `text-display` | 64px | 600 |
| `text-h1` | 48px | 600 |
| `text-h2` | 36px | 600 |
| `text-h3` | 24px | 600 |
| `text-body-lg` | 18px | 400 |
| `text-body` | 15px | 400 |
| `text-small` | 13px | 400 |
| `text-caption` | 11px | 500 |

### Typography Rules

- Use Geist for all functional UI.
- Use Instrument Serif sparingly, for major headings or emphasis.
- Avoid excessive font weights.
- Use `letter-spacing: -0.03em` for large headings.
- Use `line-height: 1.5` for body text.
- **Never use Instrument Serif for transaction amounts, security states, or technical data.** The serif
  is opt-in by class and is never inherited, so this cannot happen by accident.
- **Money and counters use tabular numerals** (`.tabular`), so a ticking countdown or a changing balance
  does not reflow the layout around it.

---

## 3. Color System

Black-and-white foundation with blue as the single accent.

Colours are defined once, as HSL channel triplets, in `src/styles.css`, and consumed through the Tailwind
theme. **No component contains a hex value**, which is what makes a correction a one-line change.

### Naming

This document calls blue "the accent". shadcn/ui already uses `accent` for the subtle hover surface, so in
code blue is **`primary`** and `accent` keeps its shadcn meaning. Same colours, standard vocabulary.

Each status colour is a **pair**: the `DEFAULT` carries words and is WCAG-verified for text; the `-mark`
variant is the saturated dot, rule, or bar, which only has to clear 3:1 as a non-text indicator.

### Light Mode

```css
:root {
  --background: 0 0% 100%;          /* #FFFFFF */
  --foreground: 0 0% 3.9%;          /* #0A0A0A */

  --card: 0 0% 100%;
  --popover: 0 0% 100%;
  --secondary: 0 0% 96.9%;          /* #F7F7F7 */
  --muted: 0 0% 94.5%;              /* #F1F1F1 */
  --accent: 0 0% 94.5%;             /* hover surface */

  --border: 0 0% 89.8%;             /* #E5E5E5 */
  --border-strong: 0 0% 83.1%;      /* #D4D4D4 */
  --input: 0 0% 54.1%;              /* #8A8A8A — 3.45:1, WCAG 1.4.11 */
  --ring: 221.2 83.2% 53.3%;

  --secondary-foreground: 0 0% 40%; /* #666666 — 5.74:1 */
  --muted-foreground: 0 0% 43.1%;   /* #6E6E6E — 5.10:1  (corrected) */

  --primary: 221.2 83.2% 53.3%;     /* #2563EB — 5.17:1 */
  --primary-hover: 224.3 76.3% 48%; /* #1D4ED8 */
  --primary-subtle: 213.8 100% 96.9%;
  --primary-foreground: 0 0% 100%;

  --destructive: 0 73.7% 41.8%;     /* #B91C1C — 5.91:1 (corrected) */
  --destructive-mark: 0 72.2% 50.6%;/* #DC2626 */
  --destructive-subtle: 0 85.7% 97.3%;

  --success: 142.4 71.8% 29.2%;     /* #15803D — 5.02:1 (corrected) */
  --success-mark: 142.1 76.2% 36.3%;/* #16A34A */
  --success-subtle: 138.5 76.5% 96.7%;

  --warning: 26 90.5% 37.1%;        /* #B45309 — 5.02:1 (corrected) */
  --warning-mark: 32.1 94.6% 43.7%; /* #D97706 */
  --warning-subtle: 48 100% 96.1%;
}
```

### Dark Mode

```css
.dark {
  --background: 0 0% 2%;            /* #050505 */
  --foreground: 0 0% 96.1%;         /* #F5F5F5 */

  --card: 0 0% 5.1%;                /* #0D0D0D */
  --popover: 0 0% 7.8%;             /* #141414 */
  --secondary: 0 0% 7.8%;
  --muted: 0 0% 10.2%;              /* #1A1A1A */
  --accent: 0 0% 10.2%;

  --border: 0 0% 14.1%;             /* #242424 */
  --border-strong: 0 0% 20%;        /* #333333 */
  --input: 0 0% 37.6%;              /* #606060 — 3.24:1 */
  --ring: 217.2 91.2% 59.8%;

  --secondary-foreground: 0 0% 63.9%; /* #A3A3A3 — 8.08:1 */
  --muted-foreground: 0 0% 54.1%;     /* #8A8A8A — 5.90:1 (corrected) */

  --primary: 217.2 91.2% 59.8%;     /* #3B82F6 — 5.54:1 */
  --primary-hover: 213.1 93.9% 67.8%;
  --primary-subtle: 226.2 57% 21%;
  --primary-foreground: 0 0% 100%;

  /* Dark measures clean at every size, so word and mark share a value. */
  --destructive: 0 84.2% 60.2%;     /* #EF4444 — 5.42:1 */
  --success: 142.1 70.6% 45.3%;     /* #22C55E — 8.94:1 */
  --warning: 37.7 92.1% 50.2%;      /* #F59E0B — 9.49:1 */
}
```

### The five corrections, and why

Measured with the WCAG 2.x relative-luminance formula against the surfaces each value is actually used on.

| Token | Originally specified | Measured | Now | Now measures |
|---|---|---|---|---|
| `--muted-foreground` light | `#999999` | **2.85:1**, fails both sizes | `#6E6E6E` | 5.10:1 |
| `--muted-foreground` dark | `#666666` | **3.55:1**, fails normal text | `#8A8A8A` | 5.90:1 |
| `--success` as text, light | `#16A34A` | **3.30:1**, fails normal text | `#15803D` | 5.02:1 |
| `--warning` as text, light | `#D97706` | **3.19:1**, fails normal text | `#B45309` | 5.02:1 |
| `--destructive` as text, light | `#DC2626` | **4.41:1** on its own subtle background | `#B91C1C` | 5.91:1 |

The original saturated values are all retained as the `-mark` variants, so nothing about the visual
identity was lost. Only the values that carry *words* changed.

### Color Usage

| Color | Purpose |
|---|---|
| Black / White | Backgrounds, text, primary surfaces |
| Blue | Primary actions, links, active states, security indicators, the attested rule |
| Green | Verified, authorized, successful |
| Amber | Medium risk, attention required |
| Red | Blocked, failed, dangerous |
| Gray | Secondary information, borders, disabled states |

**Blue is the only action accent. Do not introduce a second one.**

The one deliberate exception is the **identity strip**, where each demo account gets its own colour on a
dot and a 3px left rule so two laptops are distinguishable across a table. That colour never appears on a
button, a link, or any other control. It is a name tag, not an accent.

---

## 4. Spacing

4px base system, via Tailwind's default scale (`p-1` = 4px … `p-24` = 96px).

### Layout

- Page padding: 24px mobile, 48px desktop
- Maximum content width: **1280px for dashboard views** (Home, Passkeys, Policy), **640px for the payment
  flow**. The flow is a single decision and gets a narrow column so nothing competes with it.
- Card padding: 24px
- Section spacing: 64px–96px
- Grid gap: 16px–24px

---

## 5. Border Radius

| Element | Radius | Token |
|---|---|---|
| Buttons, inputs | 10px | `rounded-md` |
| Cards | 16px | `rounded-lg` |
| Large panels | 24px | `rounded-xl` |
| Badges | 999px | `rounded-full` |

Pills are reserved for badges, statuses, and compact controls.

---

## 6. Shadows & Borders

```css
/* Light */
--shadow-sm: 0 1px 2px rgb(0 0 0 / 0.04);
--shadow-md: 0 4px 12px rgb(0 0 0 / 0.06);
--shadow-lg: 0 12px 32px rgb(0 0 0 / 0.08);

/* Dark: prefer borders over heavy shadows */
--shadow-sm: 0 1px 2px rgb(0 0 0 / 0.2);
--shadow-md: 0 8px 24px rgb(0 0 0 / 0.25);
```

Use subtle borders to separate surfaces. No glowing blue shadows.

---

## 7. Core Components

Built on **shadcn/ui**, which is copy-in source rather than a dependency: the files in
`src/components/ui/` are ours to edit.

| Component | File | Variants |
|---|---|---|
| Button | `ui/button.tsx` | `default`, `secondary`, `ghost`, `destructive`, `link` · sizes `sm`/`default`/`lg`/`icon` · `block` |
| Card | `ui/card.tsx` | + Header, Title, Description, Content, Footer |
| Badge | `ui/badge.tsx` | `default`, `success`, `warning`, `destructive`, `info`, `outline` |
| Input / Textarea | `ui/input.tsx` | |
| Label | `ui/label.tsx` | Radix |
| Select | `ui/select.tsx` | Radix |
| Tabs | `ui/tabs.tsx` | Radix |
| Dropdown Menu | `ui/dropdown-menu.tsx` | Radix, incl. radio items |
| Alert | `ui/alert.tsx` | `default`, `info`, `success`, `warning`, `destructive` |
| Table | `ui/table.tsx` | scrolls inside its own wrapper |
| Skeleton | `ui/skeleton.tsx` | |
| Separator | `ui/separator.tsx` | Radix |

`destructive` is **outlined, not filled**. It is used only for revoking, blocking, and cancelling
dangerous actions; a wall of red buttons trains people to ignore red.

Every button supports default, hover, active, focus, disabled, and loading (via its label).

**Badges always draw a dot** as a second channel alongside their colour, so status survives colour
blindness and forced-colors mode. Pass `dot={false}` only when the text is already the whole message.

Avoid excessive nested cards.

---

## 8. PRISM-Specific Components

| Component | Where | Status |
|---|---|---|
| Transaction table | `pages/Home.tsx` | Recipient and amount are visually dominant |
| Intent Lock / review | `pages/Review.tsx` | Attested rule, live countdown, fingerprint |
| Authentication stepper | `pages/Review.tsx` | Person → Device → Transaction → Context → Authorization |
| Security event timeline | `pages/Timeline.tsx` | Full, chronological |
| Live security log | `components/LiveLog.tsx` | Same vocabulary, polled while in flight |
| Dynamic QR | `pages/Receive.tsx` | Fixed dark-on-white plate, expiry countdown |
| QR scanner | `pages/Scan.tsx` | Native `BarcodeDetector`, paste fallback |
| Device trust / revoke | `pages/Profile.tsx` | Inline two-step confirm, never `window.confirm` |
| Risk indicator | Badge, everywhere | Compact badge, never a decorative gauge |

### Security Status

Labels: Awaiting approval · Requires review · Authorized · Settled · Blocked · Expired.
Never colour alone; always the word, and a dot beside it.

### Addressing a payment: ID, card, QR

PRISM accepts three ways to address a payment, and **all three are pointers, never sources of truth.**
Whichever is used, the server resolves it and the review screen reads the recipient back from PRISM's own
records before anything is approved.

- **PRISM ID** (`name@prism`) resolves against the account list and shows the matched name under the
  attested rule *before* the user can continue. An unknown ID blocks the button.
- **QR** carries a reference and a signature. Never an amount, never an account number.
- **Card** carries a number that the server resolves to an account. **Pending backend**: the UI is
  complete and feature-detected, showing an honest "not enabled on this build" panel until
  `GET /cards` and the `payeeCardNumber` branch of `/payment/initiate` exist. It switches on by itself
  when they land, with no frontend change.

Never show a QR or a card field alone without the authoritative payment details beside it.

---

## 9. Dashboard Layout

```
┌──────────────────────────────────────────────┐
│ Navbar                                       │
├──────────────────────────────────────────────┤
│ Identity strip (who is signed in, balance)   │
├──────────────────────────────────────────────┤
│ Page Header: Title + Description + Action    │
├──────────────────────────────────────────────┤
│ ┌────────────────────┐ ┌──────────────────┐  │
│ │ Transaction table  │ │ Balance +        │  │
│ │ (main content)     │ │ summary cards    │  │
│ └────────────────────┘ └──────────────────┘  │
└──────────────────────────────────────────────┘
```

- Prioritise active payment information.
- **No charts.** Nothing on this product has a question a chart answers better than a sentence.
- Tables for transaction history, cards for summaries.
- Keep security decisions understandable.

---

## 10. Motion & Animation

**Implemented with CSS keyframes through `tailwindcss-animate`, not Framer Motion.** At this product's
motion level the entire specification below is two keyframes and a set of transition durations; a
JavaScript animation runtime would add ~50KB to a payments app to do what `animation:` already does. If
choreographed multi-element sequences are ever needed, revisit.

### Principles

- Fast and subtle
- No excessive bouncing
- **No continuous animation.** Every animation in the app is one-shot. The only exception is the skeleton
  pulse, which stops as soon as data arrives.
- Respect `prefers-reduced-motion` (enforced globally in `styles.css`)

### Durations

| Animation | Duration | Token |
|---|---|---|
| Hover | 150ms | `duration-hover` |
| Button state | 200ms | `duration-state` |
| Modal | 250ms | `duration-modal` |
| Card / page entrance | 400ms | `duration-enter` |

### Animations in use

| Name | Where |
|---|---|
| `animate-enter-up` | Page entrance, opacity + 12px rise |
| `animate-log-in` | A new security-log line, opacity + 6px rise |
| `animate-pulse` | Skeletons only, while loading |
| `animate-spin` | The refresh icon, only while a refresh is in flight |

Avoid constant pulsing, large bouncing, parallax, and decorative animation that distracts from payment
actions.

---

## 11. Accessibility

Non-negotiable, and verified rather than asserted:

- **WCAG AA contrast**, measured. See section 3.
- **Never colour alone.** Every status badge carries a word and a dot.
- **Visible keyboard focus** on every interactive element, in both themes: a 2px ring in `--ring` with a
  2px background-coloured offset so it reads on any surface.
- Semantic HTML, keyboard navigation, accessible labels on every control.
- `prefers-reduced-motion` respected globally.
- Text resizes to 200% without clipping or horizontal scroll.
- Transaction amounts and recipient details readable at all screen sizes.

---

## 12. Responsive Design

Tailwind breakpoints: `sm` 640 · `md` 768 · `lg` 1024 · `xl` 1280.

Mobile rules:

- Single-column layouts
- Full-width primary actions
- Transaction details stay prominent
- QR and authentication steps stack vertically
- No horizontal scrolling at any breakpoint
- 44px minimum tap targets, applied under `@media (pointer: coarse)` so the desktop UI is not inflated

---

## 13. Implementation

### Stack, as built

| Layer | Choice |
|---|---|
| Framework | React 18 + Vite 5 + TypeScript |
| Routing | react-router-dom 6 |
| Styling | Tailwind CSS 3 |
| Components | shadcn/ui (copy-in) on Radix primitives |
| Icons | lucide-react |
| Motion | tailwindcss-animate (see section 10) |
| QR | qrcode.react, and the native `BarcodeDetector` for scanning |
| Passkeys | @simplewebauthn/browser |

Not used: Next.js (this is a Vite SPA against an Express backend), and Framer Motion.

### Component Rules

- Reusable components in `components/ui/`; screens in `pages/`.
- **No hardcoded colours in components.** Tokens only.
- Semantic names for security states.
- Consistent animations.
- Do not introduce a new colour without updating this document.

### File layout, as built

```
src/
  components/
    ui/            button, card, badge, input, label, select, tabs,
                   dropdown-menu, alert, table, skeleton, separator
    LiveLog.tsx    the per-transaction security log
    mode-toggle.tsx  Light / Dark / System
  lib/
    api-client.ts  every endpoint, typed
    session.tsx    who is signed in, shared
    theme.tsx      theme state and persistence
    usePoll.ts     the only interval in the app
    events.ts      audit-event vocabulary, shared by log and timeline
    format.ts      money and time formatting
    utils.ts       cn()
  pages/           Landing Home Pay Review Verify Status Timeline
                   Receive Scan Profile Policy
```

### Theme

Three states: Light, Dark, System. The choice persists in `localStorage` under `prism-theme`; choosing
System removes the key. The initial class is applied by an inline script in `index.html` **before first
paint**, so the theme never flashes on load.

### One rule that outranks the rest

Never poll without a stop condition. `usePoll` is the only place in the app that creates an interval; it
pauses on a hidden tab, stops at a terminal transaction state, and shuts down permanently on a
`RATE_LIMITED` response. The backend allows 300 requests per 15 minutes per IP, shared by every tab.

---

## 14. Final Design Rule

PRISM should feel like a premium financial security product: monochromatic, precise, calm, and
trustworthy, with blue used strategically to guide the user toward safe actions.

And one rule specific to this product: **if a value did not come from the server, it does not get the
attested rule, and the interface should not imply it is trustworthy.** The whole design exists to make
that distinction visible.
