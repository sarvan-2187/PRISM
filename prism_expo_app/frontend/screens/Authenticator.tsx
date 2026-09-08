/**
 * This phone, standing in for a second device.
 *
 * A web-portal payment that needs a paired-device step-up shows a signed QR;
 * this screen scans it, verifies the signature, and derives the same six
 * digits PRISM Authenticator would. No separate app or second pairing: this
 * phone already holds the secret, because signing in here IS pairing.
 *
 * The scan is the ONLY way in. A notification can announce that a step-up is
 * waiting, but it never carries the challenge — see App.tsx. Deriving a code
 * from a token the phone was handed would prove possession of the pairing
 * secret and nothing more; scanning proves this phone read the payment off
 * the portal, signature-verified, which is the property the ₹50,000 rule is
 * actually buying.
 *
 * Everything below the verified token is computed locally. Approving or
 * denying never touches the network from this screen — the six digits are
 * typed into the laptop, which is what actually calls PRISM.
 */
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Scanner from '../components/Scanner';
import { Screen, Title, Card, Button, Notice, Small, Label, Pill } from '../components/ui';
import { verifyToken, formatMinor, fetchServerKey, type StepUpToken } from '../lib/verify';
import { approvalCode, denialCode, fromBase64Url } from '../lib/otp';
import { getApiBase, getPairing, getServerKey, setServerKey } from '../lib/store';
import { t, type as ty, mono, font } from '../lib/theme';
import type { Nav } from '../App';

export default function Authenticator({ nav }: { nav: Nav }) {
  const [serverKey, setKey] = useState<string | null>(null);
  const [secret, setSecret] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<StepUpToken | null>(null);
  const [denying, setDenying] = useState(false);
  const [left, setLeft] = useState<number | null>(null);

  // Load the pairing secret and the server's signing key once. The key is
  // fetched and cached at most once per install — after that this screen,
  // like PRISM Authenticator, verifies with no network at all.
  useEffect(() => {
    void (async () => {
      const pairing = await getPairing();
      if (!pairing) {
        setError('This phone is not paired. Pair it from the web portal first.');
        return;
      }
      setSecret(fromBase64Url(pairing.secret));

      let key = await getServerKey();
      if (!key) {
        const base = await getApiBase();
        key = await fetchServerKey(base);
        if (key) await setServerKey(key);
      }
      if (!key) {
        setError('Could not fetch the server key. Check your connection and try again.');
        return;
      }
      setKey(key);
    })();
  }, []);

  useEffect(() => {
    if (!verified?.exp) return;
    const tick = () => setLeft(Math.max(0, Math.floor(verified.exp! - Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [verified?.exp]);

  function handle(raw: string) {
    if (!serverKey) return;
    const compact = raw.includes('prism://') ? (raw.split(/[?&]t=/)[1] ?? raw) : raw.trim();
    const result = verifyToken(decodeURIComponent(compact), serverKey);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setError(null);
    setVerified(result.token);
  }

  if (error && !verified) {
    return (
      <Screen>
        <Title>Not verified</Title>
        <Notice tone="danger">{error}</Notice>
        <Small>
          PRISM checks every code against the portal's signing key before showing anything. A code
          that fails this check did not come from PRISM.
        </Small>
        <Button title="Back" variant="secondary" onPress={nav.back} />
      </Screen>
    );
  }

  if (!verified) {
    return (
      <Screen>
        <Title sub="Open this when the web portal asks for your second device. No network needed once the app is paired.">
          Scan the payment code
        </Title>
        <Scanner
          hint="Point the camera at the code on your laptop screen."
          placeholder="Paste the challenge token"
          onScanned={handle}
        />
      </Screen>
    );
  }

  if (!secret) return null;

  const code = denying
    ? denialCode(secret, verified.intentHash)
    : approvalCode(secret, verified.intentHash);
  const expired = left !== null && left <= 0;
  const grouped = `${code.slice(0, 3)} ${code.slice(3)}`;

  return (
    <Screen>
      <Pill tone={denying ? 'danger' : 'ok'}>
        {denying ? 'REPORT AS FRAUD' : 'APPROVE ON THIS DEVICE'}
      </Pill>

      <Card style={{ marginTop: 16 }}>
        <Text style={s.amount}>{formatMinor(verified.amountMinor, verified.currency)}</Text>
        <Text style={s.to}>
          to <Text style={s.payee}>{verified.payee}</Text>
        </Text>
        <Small>
          Read from PRISM&rsquo;s signature{verified.payeeIsNew ? ' · never paid before' : ''}
        </Small>
      </Card>

      {!!verified.reasons?.length && (
        <View style={{ marginTop: 14, gap: 4 }}>
          <Label>WHY PRISM STOPPED TO ASK</Label>
          {verified.reasons.map((r) => (
            <Text key={r} style={s.reason}>
              • {r}
            </Text>
          ))}
        </View>
      )}

      <View style={s.codeBlock}>
        <Text style={[s.code, expired && s.codeDead]}>{expired ? '— — —  — — —' : grouped}</Text>
        {left !== null && (
          <Text style={[s.timer, expired && { color: t.danger }]}>
            {expired ? 'Expired' : `${left}s`}
          </Text>
        )}
      </View>

      <Small>
        {denying
          ? 'Type this into the portal instead. It looks like an ordinary code and reads like one to anyone watching, but it stops the payment and flags it for review.'
          : 'Check the amount and the name above against the screen you are paying from. If they differ, do not type this in.'}
      </Small>

      <Button
        title={denying ? 'Back to the approval code' : "This isn't me"}
        variant="secondary"
        onPress={() => setDenying((d) => !d)}
      />
      <Button title="Done" variant="ghost" onPress={nav.home} />
    </Screen>
  );
}

const s = StyleSheet.create({
  amount: { ...mono, fontFamily: font.monoBold, color: t.text, fontSize: 34 },
  to: { ...ty.body, color: t.dim, marginTop: 6 },
  payee: { color: t.text, fontFamily: font.semibold },
  reason: { ...ty.small, color: t.dim },
  codeBlock: { alignItems: 'center', marginTop: 32, marginBottom: 10 },
  code: { ...mono, fontFamily: font.monoBold, fontSize: 42, color: t.text, letterSpacing: 2 },
  codeDead: { color: t.faint, letterSpacing: 0 },
  timer: { ...ty.small, ...mono, color: t.faint, marginTop: 10 },
});
