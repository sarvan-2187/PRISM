/**
 * What this phone is paired to, and how to stop being paired.
 *
 * Unpairing is the lost-phone story from this side: it wipes the secret from
 * the keychain. Revoking the server row is the portal's half, and the copy
 * says so rather than implying one action does both.
 */
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { t, mono, type as ty, font } from '../lib/theme';

interface Props {
  deviceId: string;
  apiBase: string;
  hasServerKey: boolean;
  onUnpair: () => void;
  onBack: () => void;
}

export default function Settings({ deviceId, apiBase, hasServerKey, onUnpair, onBack }: Props) {
  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Text style={s.title}>This device</Text>

      <View style={s.card}>
        <Text style={s.label}>Paired device</Text>
        <Text style={s.value} numberOfLines={1}>
          {deviceId}
        </Text>

        <Text style={s.label}>Portal</Text>
        <Text style={s.value}>{apiBase || 'not set'}</Text>

        <Text style={s.label}>Signing key</Text>
        <Text style={[s.value, { color: hasServerKey ? t.success : t.warning }]}>
          {hasServerKey ? 'stored — codes are verified before display' : 'missing — pair again'}
        </Text>
      </View>

      <Text style={s.note}>
        The secret that generates your codes is held in this phone's secure storage and never
        leaves it. PRISM cannot read it, and neither can anything else on this device.
      </Text>

      <Pressable style={s.danger} onPress={onUnpair}>
        <Text style={s.dangerText}>Unpair this phone</Text>
      </Pressable>
      <Text style={s.note}>
        Removes the secret from this phone. To stop the account accepting codes from it entirely,
        also revoke the device in the portal.
      </Text>

      <Pressable style={s.link} onPress={onBack}>
        <Text style={s.linkText}>Back</Text>
      </Pressable>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: 24, paddingTop: 32, paddingBottom: 56 },
  title: { ...ty.display, color: t.text },
  card: {
    marginTop: 26,
    padding: 20,
    borderRadius: t.radius,
    backgroundColor: t.card,
    borderWidth: 1,
    borderColor: t.border,
  },
  label: { ...ty.label, color: t.faint, marginTop: 18 },
  value: { ...ty.small, ...mono, color: t.text, marginTop: 6 },
  note: { ...ty.small, color: t.faint, marginTop: 18 },
  danger: {
    marginTop: 32,
    borderRadius: t.control,
    borderWidth: 1,
    borderColor: t.border,
    paddingVertical: 15,
    alignItems: 'center',
  },
  dangerText: { ...ty.body, color: t.danger, fontFamily: font.medium },
  link: { paddingVertical: 20, alignItems: 'center' },
  linkText: { ...ty.small, color: t.dim },
});
