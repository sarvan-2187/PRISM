/**
 * Pairing. Scan prism://pair?d=<deviceId>&s=<base64url secret> from the
 * portal's Settings screen.
 *
 * The secret arrives through the camera and is never sent back: it exists on
 * the server and on this phone, and nowhere in between. That matters because
 * the demo LAN may be plain HTTP, where a POSTed secret would be readable on
 * the wire. Same shape as an otpauth:// enrolment URI.
 */
import { useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import Scanner from './Scanner';
import { savePairing, setApiBase, setServerKey, getApiBase } from '../lib/store';
import { t, type as ty, font, attested } from '../lib/theme';

type Phase = 'api' | 'scan' | 'working' | 'error';

export default function Pair({ onPaired }: { onPaired: () => void }) {
  const [phase, setPhase] = useState<Phase>('api');
  const [api, setApi] = useState('');
  const [error, setError] = useState('');

  // Loaded once so a re-pair does not make the user retype the portal address.
  useState(() => {
    void getApiBase().then((v) => v && setApi(v));
  });

  async function handleScanned(raw: string) {
    setPhase('working');
    setError('');
    try {
      const m = raw.match(/[?&]d=([^&]+)/);
      const s = raw.match(/[?&]s=([^&]+)/);
      if (!raw.startsWith('prism://pair') || !m || !s) {
        throw new Error('That is not a PRISM pairing code. Open Settings in the portal.');
      }
      const deviceId = decodeURIComponent(m[1]);
      const secret = decodeURIComponent(s[1]);

      const base = api.trim().replace(/\/+$/, '');
      await setApiBase(base);

      // The public key that verifies every step-up token from here on. Fetched
      // once, now, while we are deliberately online: the payment leg must work
      // with the phone in airplane mode.
      const keyRes = await fetch(`${base}/.well-known/prism-keys`);
      if (!keyRes.ok) throw new Error(`The portal answered ${keyRes.status} for its signing key.`);
      // Shape: { keys: [ { kid, alg, jwk: { crv, x, kty } } ] }. The verifying
      // material is the inner jwk, not the wrapper that carries kid and alg.
      const keys = await keyRes.json();
      const jwk = keys?.keys?.[0]?.jwk;
      if (!jwk?.x) throw new Error('The portal did not return a usable signing key.');
      await setServerKey(JSON.stringify(jwk));

      await savePairing({ deviceId, secret });

      /*
       * Activation happens in the PORTAL, not here.
       *
       * /authenticator/pair/confirm requires a session cookie and this phone
       * has none — it never signed in. The portal, which does have one, has
       * an "I have scanned it" button. Attempting it anyway is harmless and
       * covers a future unauthenticated confirm, but a 401 is the expected
       * path and must not read as a failure to the user.
       */
      await fetch(`${base}/api/v1/authenticator/pair/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      }).catch(() => undefined);

      onPaired();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pairing failed.');
      setPhase('error');
    }
  }

  if (phase === 'scan') {
    return (
      <Scanner
        title="Scan the pairing code"
        hint="Portal → Settings → Pair a device. The code is valid for two minutes."
        placeholder="prism://pair?d=...&s=..."
        onScanned={handleScanned}
        onCancel={() => setPhase('api')}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Text style={s.title}>Pair this phone</Text>
      <Text style={s.hint}>
        This device becomes the second factor for one PRISM account. It approves payments the
        portal considers high risk, and it can refuse them.
      </Text>

      <Text style={s.label}>Portal address</Text>
      <TextInput
        style={s.input}
        value={api}
        onChangeText={setApi}
        placeholder="https://prism.local:5173"
        placeholderTextColor={t.faint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Text style={s.note}>
        The address you open PRISM at on your laptop, including https:// and the port. Needed only
        while pairing.
      </Text>

      {phase === 'error' && (
        <View style={s.err}>
          <Text style={s.errText}>{error}</Text>
        </View>
      )}

      <Pressable
        style={[s.btn, (!api.trim() || phase === 'working') && s.btnOff]}
        disabled={!api.trim() || phase === 'working'}
        onPress={() => setPhase('scan')}
      >
        <Text style={s.btnText}>{phase === 'working' ? 'Pairing…' : 'Scan pairing code'}</Text>
      </Pressable>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: 24, paddingTop: 32, paddingBottom: 56 },
  title: { ...ty.display, color: t.text },
  hint: { ...ty.body, color: t.dim, marginTop: 14 },
  label: { ...ty.label, color: t.faint, marginTop: 40, marginBottom: 10 },
  input: {
    ...ty.body,
    color: t.text,
    backgroundColor: t.card,
    borderWidth: 1,
    borderColor: t.borderStrong,
    borderRadius: t.control,
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  note: { ...ty.small, color: t.faint, marginTop: 10 },
  err: {
    marginTop: 22,
    padding: 16,
    borderRadius: t.control,
    borderLeftWidth: 2,
    borderLeftColor: t.danger,
    backgroundColor: t.dangerSubtle,
  },
  errText: { ...ty.small, color: t.dangerInk },
  btn: {
    marginTop: 28,
    backgroundColor: t.primary,
    borderRadius: t.control,
    paddingVertical: 17,
    alignItems: 'center',
  },
  btnOff: { opacity: 0.4 },
  btnText: { ...ty.heading, color: t.primaryInk },
});
