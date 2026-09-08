/**
 * This device: what it is paired to, and how to stop.
 *
 * Both destructive actions sit behind a biometric. Signing out is cheap to
 * undo; unpairing wipes the secret that authorizes payments, and someone
 * holding an unlocked phone should not be able to do either.
 */
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Screen, Title, Card, Button, Notice, Label, Small } from '../components/ui';
import { api, type Me } from '../lib/api';
import { requireBiometric } from '../lib/biometric';
import { getApiBase, getPairing } from '../lib/store';
import { t, type as ty, mono } from '../lib/theme';
import type { Nav } from '../App';

export default function Settings({
  me,
  nav,
  onSignOut,
  onUnpair,
}: {
  me: Me | null;
  nav: Nav;
  onSignOut: () => void;
  onUnpair: () => void;
}) {
  const [base, setBase] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [policy, setPolicy] = useState<{ highValueMinor: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void getApiBase().then(setBase);
    void getPairing().then((p) => p && setDeviceId(p.deviceId));
    api.policy().then(setPolicy, () => undefined);
  }, []);

  async function guarded(action: () => void, prompt: string) {
    const r = await requireBiometric(prompt);
    if (!r.ok) {
      setError(r.reason);
      return;
    }
    action();
  }

  return (
    <Screen>
      <Title>This device</Title>

      <Card>
        <Label>SIGNED IN AS</Label>
        <Text style={s.value}>{me ? `${me.displayName} · ${me.email}` : '—'}</Text>

        <View style={{ height: 16 }} />
        <Label>PAIRED DEVICE</Label>
        <Text style={s.value} numberOfLines={1}>
          {deviceId || '—'}
        </Text>

        <View style={{ height: 16 }} />
        <Label>SERVER</Label>
        <Text style={s.value}>{base || '—'}</Text>
      </Card>

      <View style={{ marginTop: 18 }}>
        <Small>
          Payments from this phone are approved with a code derived from a secret held in this
          device's secure storage, not with a passkey. PRISM records that difference on every
          payment, and the timeline says which one authorized it.
        </Small>
      </View>

      {policy && (
        <View style={{ marginTop: 18 }}>
          <Label>WHAT PRISM IS ENFORCING</Label>
          <Small>
            Payments of ₹{(policy.highValueMinor / 100).toLocaleString('en-IN')} or more need a
            paired device. Below that, ordinary approval is enough.
          </Small>
        </View>
      )}

      <View style={{ marginTop: 18 }}>
        <Label>SECOND-DEVICE APPROVAL</Label>
        <Small>
          This phone can also approve step-ups for payments made on the web portal — it already
          holds the pairing secret. PRISM notifies this phone when one is waiting; you can also
          open it directly and scan the code from your laptop screen.
        </Small>
        <Button
          title="Approve a web payment"
          variant="secondary"
          onPress={() => nav.push({ name: 'authenticator' })}
        />
      </View>

      {error && <Notice tone="danger">{error}</Notice>}

      <Button
        title="Sign out"
        variant="secondary"
        onPress={() => guarded(onSignOut, 'Sign out of PRISM')}
      />

      <View style={{ marginTop: 26 }}>
        <Label>DANGER</Label>
        <Small>
          Unpairing wipes the secret from this phone. You will need to pair again from the web
          portal, and until you do, this device cannot approve anything.
        </Small>
        {confirming ? (
          <>
            <Button
              title="Yes, unpair this phone"
              variant="danger"
              onPress={() => guarded(onUnpair, 'Unpair this phone from PRISM')}
            />
            <Button title="Keep it paired" variant="ghost" onPress={() => setConfirming(false)} />
          </>
        ) : (
          <Button title="Unpair this phone" variant="danger" onPress={() => setConfirming(true)} />
        )}
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  value: { ...ty.small, ...mono, color: t.text, marginTop: 4 },
});
