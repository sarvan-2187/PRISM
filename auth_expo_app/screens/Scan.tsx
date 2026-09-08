/**
 * Scan a step-up challenge from the portal and verify its signature before
 * anything is shown.
 *
 * A token that fails verification is not rendered at all — no payee, no
 * amount. Showing unverified details would hand an attacker the exact screen
 * the second device exists to protect.
 */
import { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Scanner from './Scanner';
import { verifyToken, type StepUpToken } from '../lib/verify';
import { t, type as ty, font } from '../lib/theme';

interface Props {
  serverKey: string | null;
  onVerified: (token: StepUpToken) => void;
  onCancel: () => void;
}

export default function Scan({ serverKey, onVerified, onCancel }: Props) {
  const [error, setError] = useState<string | null>(null);

  function handle(raw: string) {
    if (!serverKey) {
      setError('This phone has no server key stored. Pair again to fetch it.');
      return;
    }
    // A token may arrive bare or inside a prism:// URL, depending on how the
    // portal renders it.
    const compact = raw.includes('prism://') ? (raw.split(/[?&]t=/)[1] ?? raw) : raw.trim();
    const result = verifyToken(decodeURIComponent(compact), serverKey);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    onVerified(result.token);
  }

  if (error) {
    return (
      <View style={s.wrap}>
        <Text style={s.title}>Not verified</Text>
        <View style={s.err}>
          <Text style={s.errText}>{error}</Text>
        </View>
        <Text style={s.hint}>
          PRISM checks every code against the portal's signing key before showing you anything. A
          code that fails this check did not come from PRISM.
        </Text>
        <Pressable style={s.btn} onPress={() => setError(null)}>
          <Text style={s.btnText}>Try another code</Text>
        </Pressable>
        <Pressable style={s.link} onPress={onCancel}>
          <Text style={s.linkText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Scanner
      title="Scan the payment code"
      hint="The portal shows this when a payment needs your second device. No network needed — this works in airplane mode."
      placeholder="Paste the challenge token"
      onScanned={handle}
      onCancel={onCancel}
    />
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: 24, paddingTop: 28 },
  title: { ...ty.title, color: t.danger },
  hint: { ...ty.small, color: t.dim, marginTop: 20 },
  err: {
    marginTop: 18,
    padding: 18,
    borderRadius: t.radius,
    borderLeftWidth: 2,
    borderLeftColor: t.danger,
    backgroundColor: t.dangerSubtle,
  },
  errText: { ...ty.body, color: t.dangerInk, fontFamily: font.medium },
  btn: {
    marginTop: 28,
    backgroundColor: t.primary,
    borderRadius: t.control,
    paddingVertical: 15,
    alignItems: 'center',
  },
  btnText: { ...ty.body, color: t.primaryInk, fontFamily: font.semibold },
  link: { paddingVertical: 16, alignItems: 'center' },
  linkText: { ...ty.small, color: t.dim },
});
