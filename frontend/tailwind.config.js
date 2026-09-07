/**
 * Tailwind + shadcn/ui theme, driven entirely by the CSS variables in
 * src/styles.css. Colours are never written as hex in a component: a value
 * that only exists in one place can be corrected in one place, which is how
 * the WCAG fixes in the token layer stay fixed.
 *
 * Naming note: DESIGN_SYSTEM.md calls blue "the accent". shadcn already uses
 * `accent` for the subtle hover surface, so blue is mapped to `primary` here
 * and `accent` keeps its shadcn meaning. Same colours, standard vocabulary.
 */
import tailwindcssAnimate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        border: 'hsl(var(--border))',
        'border-strong': 'hsl(var(--border-strong))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          hover: 'hsl(var(--primary-hover))',
          subtle: 'hsl(var(--primary-subtle))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--foreground))',
        },
        // Status colours come in pairs. The DEFAULT carries words and is the
        // WCAG-verified one; `mark` is the saturated dot, rule or bar, which
        // only has to clear 3:1 as a non-text indicator.
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          mark: 'hsl(var(--destructive-mark))',
          subtle: 'hsl(var(--destructive-subtle))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          mark: 'hsl(var(--success-mark))',
          subtle: 'hsl(var(--success-subtle))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          mark: 'hsl(var(--warning-mark))',
          subtle: 'hsl(var(--warning-subtle))',
        },
      },
      borderRadius: {
        // DESIGN_SYSTEM section 5. Pills are for badges only.
        lg: 'var(--radius-card)',
        xl: 'var(--radius-panel)',
        md: 'var(--radius-control)',
        sm: 'calc(var(--radius-control) - 4px)',
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        serif: ['Instrument Serif', 'ui-serif', 'Georgia', 'Times New Roman', 'serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        // DESIGN_SYSTEM section 2 type scale.
        caption: ['11px', { lineHeight: '1.4', fontWeight: '500' }],
        small: ['13px', { lineHeight: '1.5' }],
        body: ['15px', { lineHeight: '1.5' }],
        'body-lg': ['18px', { lineHeight: '1.55' }],
        h3: ['24px', { lineHeight: '1.3', letterSpacing: '-0.02em' }],
        h2: ['36px', { lineHeight: '1.2', letterSpacing: '-0.03em' }],
        h1: ['48px', { lineHeight: '1.1', letterSpacing: '-0.03em' }],
        display: ['64px', { lineHeight: '1.05', letterSpacing: '-0.03em' }],
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
      transitionDuration: {
        hover: '150ms',
        state: '200ms',
        modal: '250ms',
        enter: '400ms',
      },
      keyframes: {
        'enter-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'log-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        // One-shot only. DESIGN_SYSTEM section 10 forbids continuous motion,
        // and the MOTION dial for this product is 1.
        'enter-up': 'enter-up 400ms cubic-bezier(0.22,0.61,0.36,1) both',
        'log-in': 'log-in 400ms cubic-bezier(0.22,0.61,0.36,1) both',
        'accordion-down': 'accordion-down 200ms ease-out',
        'accordion-up': 'accordion-up 200ms ease-out',
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
