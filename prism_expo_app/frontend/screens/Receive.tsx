/**
 * Ask to be paid: a signed, single-use, short-lived request drawn as a QR.
 *
 * The code carries a reference, never an amount or an account. The payer's
 * server resolves it from PRISM's own records, so a swapped sticker can point
 * at an attacker but cannot make the attacker look like the shop.
 */
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Screen, Title, Field, Button, Notice, Small, Label } from '../components/ui';
import { api, ApiError, type Me } from '../lib/api';
import { t, type as ty, mono } from '../lib/theme';
import type { Nav } from '../App';

export default function Receive({ nav, onRefresh }: { nav: Nav; onRefresh: () => void }) {
  const [rupees, setRupees] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [arrived, setArrived] = useState<string | null>(null);

  useEffect(() => {
    if (left <= 0) return;
    const id = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [left]);

  /*
   * Watch the balance while a request is on screen.
   *
   * A credit only reaches the statement once it settles, so a receiver would
   * otherwise see nothing while the payer is mid-flow. Polling /me is the
   * honest, cheap way to notice money arriving, and it stops as soon as the
   * request expires.
   */
  useEffect(() => {
    if (!token || left <= 0) return;
    let last: number | null = null;
    const id = setInterval(async () => {
      try {
        const me: Me = await api.me();
        if (last !== null && me.balanceMinor > last) {
          setArrived(me.balanceFormatted);
          onRefresh();
        }
        last = me.balanceMinor;
      } catch {
        /* a dropped poll is not worth surfacing */
      }
    }, 4000);
    return () => clearInterval(id);
  }, [token, left, onRefresh]);

  async function mint() {
    setBusy(true);
    setError(null);
    setArrived(null);
    try {
      const r = await api.requestQr(Math.round(Number(rupees) * 100));
      setToken(r.token);
      setLeft(r.expiresInSeconds);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create a request.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title sub="Show this to whoever is paying you. It is valid once, and only for a minute.">
        Request a payment
      </Title>

      {arrived && <Notice tone="ok">Money arrived. Your balance is now {arrived}.</Notice>}

      <Field
        label="AMOUNT (₹)"
        value={rupees}
        onChangeText={(v) => setRupees(v.replace(/[^0-9.]/g, ''))}
        placeholder="0"
        keyboardType="numeric"
      />

      {error && <Notice tone="danger">{error}</Notice>}

      <Button
        title={token ? 'New request' : 'Show a QR code'}
        onPress={mint}
        disabled={!(Number(rupees) > 0)}
        busy={busy}
      />

      {token && (
        <View style={{ alignItems: 'center', marginTop: 26 }}>
          {/* White plate in both themes: another camera reads this, and
              contrast is what a camera needs. */}
          <View style={s.plate}>
            {left > 0 ? (
              <QRCode value={token} size={210} backgroundColor="#fff" color="#000" />
            ) : (
              <Text style={s.dead}>This request has expired.</Text>
            )}
          </View>
          <Text style={s.timer}>{left > 0 ? `Expires in ${left}s` : 'Expired'}</Text>
          <View style={{ marginTop: 14 }}>
            <Label>WHY THIS IS SAFE TO SHOW</Label>
            <Small>
              The code is a reference, not an amount and not an account number. PRISM resolves who
              gets paid from its own records, so a copied or swapped code cannot redirect your money.
            </Small>
          </View>
        </View>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  plate: {
    backgroundColor: '#fff',
    padding: 18,
    borderRadius: t.radius,
    minWidth: 246,
    minHeight: 246,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dead: { ...ty.small, color: '#555' },
  timer: { ...ty.small, ...mono, color: t.faint, marginTop: 12 },
});
