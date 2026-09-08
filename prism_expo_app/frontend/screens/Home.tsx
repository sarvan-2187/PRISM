/**
 * Balance and statement.
 *
 * Money out appears at every status because it is yours; money in appears
 * only once settled, because a stranger's pending attempt is their business.
 * Direction is carried by four channels, not just colour: the arrow glyph,
 * the +/- sign, the Cr/Dr label and the hue.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Screen, Title, Money, Card, Pill, Loading, Empty, Notice, Small } from '../components/ui';
import { api, ApiError, type Me, type StatementEntry } from '../lib/api';
import { statusTone, STATUS_LABEL } from '../lib/events';
import { t, type as ty, mono, font, attested } from '../lib/theme';
import type { Nav } from '../App';

export default function Home({
  me,
  nav,
  onRefresh,
}: {
  me: Me | null;
  nav: Nav;
  onRefresh: () => void;
}) {
  const [rows, setRows] = useState<StatementEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setRows(await api.history());
      onRefresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach PRISM.');
    } finally {
      setBusy(false);
    }
  }, [onRefresh]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen onRefresh={load} refreshing={busy}>
      <View style={s.balanceBlock}>
        <Text style={s.balanceLabel}>AVAILABLE BALANCE</Text>
        <Money value={me?.balanceFormatted ?? '—'} size={40} />
        <Small>Read from the ledger, not from this page</Small>
      </View>

      <View style={s.actions}>
        <Pressable style={s.action} onPress={() => nav.push({ name: 'send' })}>
          <Text style={s.actionText}>Send</Text>
        </Pressable>
        <Pressable style={s.actionQuiet} onPress={() => nav.push({ name: 'receive' })}>
          <Text style={s.actionQuietText}>Request</Text>
        </Pressable>
      </View>

      <Text style={s.section}>Transaction history</Text>

      {error && <Notice tone="danger">{error}</Notice>}
      {!rows && !error && <Loading what="Loading your payments…" />}

      {rows && rows.length === 0 && (
        <Empty
          title="Nothing on this account yet"
          body="Payments you send appear here as debits, and money that reaches you appears as credits once it settles."
        />
      )}

      {rows?.map((tx) => {
        const credit = tx.direction === 'RECEIVED';
        return (
          <Pressable
            key={tx.txId}
            style={s.row}
            onPress={() => nav.push({ name: 'timeline', txId: tx.txId })}
          >
            {/* Direction has four channels, not just colour: the arrow's
                direction, the +/- sign, the Cr/Dr label and the hue. Colour
                alone disappears for a colour-blind reader. */}
            <Feather
              name={credit ? 'arrow-down-left' : 'arrow-up-right'}
              size={19}
              color={credit ? t.success : t.danger}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.party} numberOfLines={1}>
                {tx.counterpartyName}
              </Text>
              <Text style={s.sub} numberOfLines={1}>
                {credit ? 'from ' : 'to '}
                {tx.counterpartyHandle}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 5 }}>
              <Text style={[s.amount, { color: credit ? t.success : t.danger }]}>
                {credit ? '+' : '−'}
                {tx.amountFormatted} <Text style={s.crdr}>{credit ? 'Cr' : 'Dr'}</Text>
              </Text>
              <Pill tone={statusTone(tx.status)}>{STATUS_LABEL[tx.status] ?? tx.status}</Pill>
            </View>
          </Pressable>
        );
      })}
    </Screen>
  );
}

const s = StyleSheet.create({
  balanceBlock: { ...attested, marginBottom: 24 },
  balanceLabel: { ...ty.label, color: t.faint, marginBottom: 8 },
  actions: { flexDirection: 'row', gap: 10, marginBottom: 30 },
  action: {
    flex: 1,
    backgroundColor: t.primary,
    borderRadius: t.control,
    paddingVertical: 15,
    alignItems: 'center',
  },
  actionText: { ...ty.heading, color: t.primaryInk },
  actionQuiet: {
    flex: 1,
    backgroundColor: t.raised,
    borderWidth: 1,
    borderColor: t.border,
    borderRadius: t.control,
    paddingVertical: 15,
    alignItems: 'center',
  },
  actionQuietText: { ...ty.heading, color: t.dim },
  section: { ...ty.heading, color: t.text, marginBottom: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: t.border,
  },
  party: { ...ty.body, color: t.text, fontFamily: font.medium },
  sub: { ...ty.small, color: t.faint, marginTop: 2 },
  amount: { ...ty.body, ...mono, fontFamily: font.monoBold, fontSize: 14 },
  crdr: { ...ty.small, color: t.faint, fontSize: 11 },
});
