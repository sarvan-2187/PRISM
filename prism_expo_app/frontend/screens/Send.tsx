/**
 * Choose a recipient and an amount, then lock the intent.
 *
 * Nothing is authorized here. Locking freezes the amount and the payee into a
 * hash; the next screen reads that back from the server and is the only place
 * approval happens.
 */
import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Screen, Title, Field, Button, Notice, Loading, Small } from '../components/ui';
import { api, ApiError, type Payee } from '../lib/api';
import { t, type as ty, font } from '../lib/theme';
import type { Nav } from '../App';

export default function Send({ nav }: { nav: Nav }) {
  const [payees, setPayees] = useState<Payee[] | null>(null);
  const [chosen, setChosen] = useState<Payee | null>(null);
  const [rupees, setRupees] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.payees().then(setPayees, () => setError('Could not load your recipients.'));
  }, []);

  async function initiate() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      // Rupees in, paise on the wire. The server stores integer minor units,
      // so a float never touches an amount.
      const minor = Math.round(Number(rupees) * 100);
      const tx = await api.initiate(chosen.accountId, minor);
      nav.push({ name: 'review', txId: tx.txId });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start this payment.');
      setBusy(false);
    }
  }

  const amountOk = Number(rupees) > 0;

  return (
    <Screen>
      <Title>Send</Title>

      {!payees && !error && <Loading what="Loading recipients…" />}
      {error && <Notice tone="danger">{error}</Notice>}

      {payees && (
        <>
          <Text style={s.label}>TO</Text>
          <View style={{ marginBottom: 22 }}>
            {payees.map((p) => {
              const on = chosen?.accountId === p.accountId;
              return (
                <Pressable
                  key={p.accountId}
                  style={[s.payee, on && s.payeeOn]}
                  onPress={() => setChosen(p)}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.name}>{p.displayName}</Text>
                    <Text style={s.handle}>{p.handle}</Text>
                  </View>
                  {!p.knownPayee && <Text style={s.new}>never paid</Text>}
                </Pressable>
              );
            })}
          </View>

          <Field
            label="AMOUNT (₹)"
            value={rupees}
            onChangeText={(v) => setRupees(v.replace(/[^0-9.]/g, ''))}
            placeholder="0"
            keyboardType="numeric"
          />

          {chosen && !chosen.knownPayee && (
            <Notice tone="warn">
              You have never paid {chosen.displayName}. PRISM weighs a first payment to a new
              recipient more heavily, and may ask for more before it settles.
            </Notice>
          )}

          <Button
            title="Review payment"
            onPress={initiate}
            disabled={!chosen || !amountOk}
            busy={busy}
          />
          <View style={{ marginTop: 10 }}>
            <Small>
              Nothing moves yet. The next screen shows what PRISM recorded, read back from the
              server.
            </Small>
          </View>
        </>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  label: { ...ty.label, color: t.faint, marginBottom: 10 },
  payee: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: t.control,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.card,
    marginBottom: 8,
  },
  payeeOn: { borderColor: t.primary, backgroundColor: t.raised },
  name: { ...ty.body, color: t.text, fontFamily: font.medium },
  handle: { ...ty.small, color: t.faint, marginTop: 2 },
  new: { ...ty.small, color: t.warning, fontSize: 12 },
});
