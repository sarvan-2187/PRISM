/**
 * The outcome, in the words the server used.
 *
 * An unknown failure code must never crash this screen: a Future Card may
 * introduce one at midnight, and "refused (SOME_NEW_CODE)" is a far better
 * answer than a blank page.
 */
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Screen, Money, Button, Loading, Small, Label, Pill, Attested } from '../components/ui';
import { api, type TransactionView } from '../lib/api';
import { describeFailure, statusTone, STATUS_LABEL } from '../lib/events';
import { t, type as ty, font } from '../lib/theme';
import type { Nav } from '../App';

export default function Status({ txId, nav }: { txId: string; nav: Nav }) {
  const [tx, setTx] = useState<TransactionView | null>(null);

  useEffect(() => {
    api.payment(txId).then(setTx, () => undefined);
  }, [txId]);

  if (!tx) return <Loading what="Checking the outcome…" />;

  const settled = tx.status === 'SETTLED';

  return (
    <Screen>
      <Pill tone={statusTone(tx.status)}>{STATUS_LABEL[tx.status] ?? tx.status}</Pill>

      <View style={{ marginTop: 20 }}>
        <Attested>
          <Money value={tx.amountFormatted} size={36} />
          <Text style={s.to}>
            {settled ? 'sent to ' : 'to '}
            <Text style={s.payee}>{tx.payeeName}</Text>
          </Text>
        </Attested>
      </View>

      {settled ? (
        <View style={{ marginTop: 22 }}>
          <Text style={s.headline}>Payment sent</Text>
          <Small>
            Approved on this device and settled exactly once. The ledger entry and the audit trail
            are the same ones the website reads.
          </Small>
        </View>
      ) : (
        <View style={{ marginTop: 22 }}>
          <Text style={[s.headline, { color: t.danger }]}>PRISM stopped this payment</Text>
          <Text style={s.reason}>{describeFailure(tx.failureCode)}</Text>
          {tx.riskReasons.length > 0 && (
            <View style={{ marginTop: 16 }}>
              <Label>WHAT IT NOTICED</Label>
              {tx.riskReasons.map((r) => (
                <Text key={r} style={s.bullet}>
                  • {r}
                </Text>
              ))}
            </View>
          )}
          <View style={{ marginTop: 14 }}>
            <Small>No money moved. Your balance is unchanged.</Small>
          </View>
        </View>
      )}

      <Button
        title="See what PRISM checked"
        variant="secondary"
        onPress={() => nav.push({ name: 'timeline', txId })}
      />
      <Button title="Done" variant="ghost" onPress={nav.home} />
    </Screen>
  );
}

const s = StyleSheet.create({
  to: { ...ty.body, color: t.dim, marginTop: 8 },
  payee: { color: t.text, fontFamily: font.semibold },
  headline: { ...ty.title, color: t.text, marginBottom: 8 },
  reason: { ...ty.body, color: t.dim },
  bullet: { ...ty.small, color: t.dim, marginBottom: 4 },
});
