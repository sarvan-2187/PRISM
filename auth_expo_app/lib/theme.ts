import type { TextStyle } from 'react-native';

/**
 * Transcribed from the portal's tokens (frontend/src/styles.css). The two
 * surfaces are one product and a judge sees them side by side, so the phone
 * must not look like a different company's app.
 *
 * Typeface: Geist, matching the portal. It is a common choice, and picked here
 * for one reason only — the laptop screen the user is comparing against is
 * already set in it. A second typeface on the second device would undercut
 * the whole point of the comparison.
 */
export const t = {
  bg: '#050505',
  card: '#0D0D0D',
  raised: '#141414',
  border: '#242424',
  borderStrong: '#333333',
  text: '#F5F5F5',
  dim: '#A3A3A3',
  faint: '#8A8A8A',
  primary: '#3B82F6',
  primaryInk: '#FFFFFF',
  success: '#22C55E',
  warning: '#F59E0B',
  danger: '#EF4444',
  dangerSubtle: '#450A0A',
  dangerInk: '#FCA5A5',
  radius: 16,
  control: 12,
} as const;

export const font = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  bold: 'Geist_700Bold',
  mono: 'GeistMono_400Regular',
  monoBold: 'GeistMono_700Bold',
} as const;

/**
 * One scale, used everywhere, so hierarchy comes from deliberate steps rather
 * than from whatever number looked right in the moment. The jumps are large:
 * this screen is read at arm's length, in a hurry, under pressure.
 */
export const type = {
  display: { fontFamily: font.bold, fontSize: 34, lineHeight: 38, letterSpacing: -0.8 },
  title: { fontFamily: font.semibold, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
  heading: { fontFamily: font.semibold, fontSize: 16, lineHeight: 22 },
  body: { fontFamily: font.regular, fontSize: 15, lineHeight: 23 },
  small: { fontFamily: font.regular, fontSize: 13, lineHeight: 20 },
  label: { fontFamily: font.medium, fontSize: 11, lineHeight: 14, letterSpacing: 1.1 },
} satisfies Record<string, TextStyle>;

/** Money, codes and hashes. Tabular so digits never reflow as they change. */
export const mono: TextStyle = {
  fontFamily: font.mono,
  fontVariant: ['tabular-nums'],
};

/**
 * The attested-value motif, carried over from the portal.
 *
 * A hairline rule down the left of anything PRISM asserted. It is the one
 * repeated gesture across both surfaces and it means exactly one thing: this
 * value came from the server's signature, not from the screen you are
 * standing in front of.
 */
export const attested = {
  borderLeftWidth: 2,
  borderLeftColor: t.primary,
  paddingLeft: 16,
} as const;
