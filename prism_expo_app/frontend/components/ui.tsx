/**
 * The handful of primitives every screen is built from.
 *
 * Deliberately small: five components and the type scale do the whole app.
 * A UI kit would have been a dependency to debug at 4 AM in exchange for
 * components this app does not use.
 */
import type { ReactNode } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { t, type as ty, mono, font, attested } from '../lib/theme';
import type { Tone } from '../lib/events';

/* ── Layout ─────────────────────────────────────────────────────────── */

export function Screen({
  children,
  scroll = true,
  onRefresh,
  refreshing,
}: {
  children: ReactNode;
  scroll?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  if (!scroll) return <View style={s.screenPad}>{children}</View>;
  return (
    <ScrollView
      contentContainerStyle={s.screenPad}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={Boolean(refreshing)}
            onRefresh={onRefresh}
            tintColor={t.faint}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

export function Title({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <View style={{ marginBottom: 24 }}>
      <Text style={s.title}>{children}</Text>
      {sub ? <Text style={s.sub}>{sub}</Text> : null}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[s.card, style]}>{children}</View>;
}

/**
 * Anything the SERVER asserted, marked with the hairline rule the web portal
 * uses. The same gesture on both surfaces, meaning the same thing: this value
 * came from PRISM, not from the screen you are looking at.
 */
export function Attested({ children }: { children: ReactNode }) {
  return <View style={s.attested}>{children}</View>;
}

/* ── Type ───────────────────────────────────────────────────────────── */

export const Body = ({ children }: { children: ReactNode }) => (
  <Text style={s.body}>{children}</Text>
);
export const Small = ({ children }: { children: ReactNode }) => (
  <Text style={s.small}>{children}</Text>
);
export const Label = ({ children }: { children: ReactNode }) => (
  <Text style={s.label}>{children}</Text>
);

/** Money. Always tabular, so digits never reflow as a balance updates. */
export function Money({ value, size = 34 }: { value: string; size?: number }) {
  return <Text style={[s.money, { fontSize: size }]}>{value}</Text>;
}

/* ── Controls ───────────────────────────────────────────────────────── */

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  busy,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  busy?: boolean;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={[s.btn, s[variant], off && { opacity: 0.4 }]}
      accessibilityRole="button"
    >
      {busy ? (
        <ActivityIndicator color={variant === 'primary' ? t.primaryInk : t.dim} />
      ) : (
        <Text
          style={[
            s.btnText,
            variant === 'primary' && { color: t.primaryInk },
            variant === 'danger' && { color: t.danger },
            variant === 'ghost' && { color: t.dim },
          ]}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  maxLength,
  big,
  autoFocus,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'email-address' | 'url';
  maxLength?: number;
  big?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <View style={{ marginBottom: 18 }}>
      <Label>{label}</Label>
      <TextInput
        style={[s.input, big && s.inputBig]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.faint}
        keyboardType={keyboardType ?? 'default'}
        maxLength={maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
      />
    </View>
  );
}

/* ── Status ─────────────────────────────────────────────────────────── */

const TONE_COLOR: Record<Tone, string> = {
  ok: t.success,
  warn: t.warning,
  danger: t.danger,
  plain: t.dim,
};

/** Colour is never the only channel: the word is always present too. */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <View style={[s.pill, { borderColor: TONE_COLOR[tone] }]}>
      <View style={[s.pillDot, { backgroundColor: TONE_COLOR[tone] }]} />
      <Text style={[s.pillText, { color: TONE_COLOR[tone] }]}>{children}</Text>
    </View>
  );
}

export function Notice({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <View style={[s.notice, { borderLeftColor: TONE_COLOR[tone] }]}>
      <Text style={[s.noticeText, tone === 'danger' && { color: t.dangerInk }]}>{children}</Text>
    </View>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <View style={{ paddingVertical: 48, alignItems: 'center', gap: 14 }}>
      <ActivityIndicator color={t.primary} />
      <Small>{what}</Small>
    </View>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={s.emptyBody}>{body}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  screenPad: { paddingHorizontal: 22, paddingTop: 24, paddingBottom: 56 },
  title: { ...ty.display, color: t.text },
  sub: { ...ty.body, color: t.dim, marginTop: 10 },
  card: {
    padding: 18,
    borderRadius: t.radius,
    backgroundColor: t.card,
    borderWidth: 1,
    borderColor: t.border,
  },
  attested: { ...attested },
  body: { ...ty.body, color: t.dim },
  small: { ...ty.small, color: t.faint },
  label: { ...ty.label, color: t.faint, marginBottom: 8 },
  money: { ...mono, fontFamily: font.monoBold, color: t.text },

  btn: { borderRadius: t.control, paddingVertical: 16, alignItems: 'center', marginTop: 12 },
  primary: { backgroundColor: t.primary },
  secondary: { backgroundColor: t.raised, borderWidth: 1, borderColor: t.border },
  ghost: {},
  danger: { borderWidth: 1, borderColor: t.danger },
  btnText: { ...ty.heading, color: t.text },

  input: {
    ...ty.body,
    color: t.text,
    backgroundColor: t.card,
    borderWidth: 1,
    borderColor: t.borderStrong,
    borderRadius: t.control,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  inputBig: {
    ...mono,
    fontFamily: font.monoBold,
    fontSize: 28,
    textAlign: 'center',
    letterSpacing: 6,
    paddingVertical: 16,
  },

  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { ...ty.small, fontFamily: font.medium, fontSize: 12 },

  notice: {
    borderLeftWidth: 2,
    paddingLeft: 14,
    paddingVertical: 10,
    marginVertical: 14,
    backgroundColor: t.card,
    borderTopRightRadius: t.control,
    borderBottomRightRadius: t.control,
  },
  noticeText: { ...ty.small, color: t.dim },

  empty: {
    paddingVertical: 40,
    paddingHorizontal: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: t.borderStrong,
    borderRadius: t.radius,
  },
  emptyTitle: { ...ty.heading, color: t.text },
  emptyBody: { ...ty.small, color: t.faint, marginTop: 8, textAlign: 'center' },
});
