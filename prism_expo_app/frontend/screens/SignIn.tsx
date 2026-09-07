/**
 * Sign in with the paired device.
 *
 * The server picks a random challenge; this phone answers with
 * HMAC(device_secret, challenge). No password crosses the network, and the
 * answer is worthless for anything else: a payment code is derived from an
 * intent hash instead, so neither can be replayed as the other.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Screen, Title, Field, Button, Notice, Small, Label } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { loginCode, fromBase64Url } from '../lib/otp';
import { getEmail, setEmail as saveEmail, getPairing, setToken } from '../lib/store';

export default function SignIn({
  onSignedIn,
  onReset,
}: {
  onSignedIn: () => void;
  onReset: () => void;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getEmail().then((v) => v && setEmail(v));
  }, []);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const pairing = await getPairing();
      if (!pairing) throw new ApiError(0, 'NO_PAIRING', 'This phone is not paired.');

      // Two round trips on purpose: a code bound to nothing the server chose
      // would be a password that never changes.
      const { challenge } = await api.challenge(email.trim());
      const code = loginCode(fromBase64Url(pairing.secret), challenge);
      const res = await api.login(email.trim(), code);

      await setToken(res.token);
      await saveEmail(email.trim());
      onSignedIn();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.failureCode === 'AUTH_FAILED'
            ? ((err.details as { reason?: string })?.reason ??
              'This phone is not paired to that account.')
            : err.message
          : 'Sign-in failed.'
      );
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title sub="This phone holds a secret paired to one PRISM account. Signing in proves it still has it.">
        Sign in
      </Title>

      <Field
        label="PRISM ID"
        value={email}
        onChangeText={setEmail}
        placeholder="asha@prism.demo"
        keyboardType="email-address"
      />

      {error && <Notice tone="danger">{error}</Notice>}

      <Button title="Sign in with this device" onPress={signIn} disabled={!email.trim()} busy={busy} />

      <View style={{ marginTop: 28 }}>
        <Label>Not your phone?</Label>
        <Small>
          Unpairing wipes the secret from this device. You will need to pair again from the web
          portal before you can sign in.
        </Small>
        <Button title="Unpair this phone" variant="ghost" onPress={onReset} />
      </View>
    </Screen>
  );
}
