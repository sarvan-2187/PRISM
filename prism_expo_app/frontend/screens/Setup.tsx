/**
 * First run: where the server is, and which account this phone belongs to.
 *
 * Pairing happens in the WEB portal (Settings → Authenticator), which mints
 * the secret and draws it as a QR. The phone photographs it and never sends
 * it back — on a plain-HTTP LAN a secret POSTed from the phone would be
 * readable on the wire. Same shape as an otpauth:// enrolment URI.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Scanner from '../components/Scanner';
import { Screen, Title, Field, Button, Notice, Small } from '../components/ui';
import { getApiBase, setApiBase, setPairing } from '../lib/store';

export default function Setup({ onDone }: { onDone: () => void }) {
  const [base, setBase] = useState('');
  const [step, setStep] = useState<'server' | 'pair'>('server');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getApiBase().then((v) => v && setBase(v));
  }, []);

  async function checkServer() {
    setError(null);
    const url = base.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) {
      setError('Start the address with http:// or https://');
      return;
    }
    try {
      const res = await fetch(`${url}/health`);
      const body = await res.json();
      if (!body?.ok) throw new Error();
      await setApiBase(url);
      setStep('pair');
    } catch {
      setError(`Nothing answered at ${url}. Check the address and that you are on the same Wi-Fi.`);
    }
  }

  async function handleScan(raw: string) {
    setError(null);
    const d = raw.match(/[?&]d=([^&]+)/);
    const s = raw.match(/[?&]s=([^&]+)/);
    if (!raw.startsWith('prism://pair') || !d || !s) {
      setError('That is not a PRISM pairing code. Open Settings → Authenticator in the portal.');
      return;
    }
    await setPairing({
      deviceId: decodeURIComponent(d[1]),
      secret: decodeURIComponent(s[1]),
    });
    onDone();
  }

  if (step === 'pair') {
    return (
      <Screen>
        <Title sub="Open PRISM on your laptop, go to Settings → Authenticator, and tap Pair a phone.">
          Pair this phone
        </Title>
        <Scanner
          hint="Point the camera at the pairing code. It is valid for two minutes."
          placeholder="prism://pair?d=...&s=..."
          onScanned={handleScan}
        />
        {error && <Notice tone="danger">{error}</Notice>}
        <Button title="Back" variant="ghost" onPress={() => setStep('server')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title sub="Your money, on your phone. Approved with this device instead of a passkey, because a phone cannot hold one.">
        PRISM
      </Title>

      <Field
        label="PRISM SERVER"
        value={base}
        onChangeText={setBase}
        placeholder="http://10.131.241.194:4100"
        keyboardType="url"
      />
      <View style={{ marginTop: -8, marginBottom: 8 }}>
        <Small>
          The PRISM App API, not the website. Your laptop shows it when the app server starts.
        </Small>
      </View>

      {error && <Notice tone="danger">{error}</Notice>}
      <Button title="Continue" onPress={checkServer} disabled={!base.trim()} />
    </Screen>
  );
}
