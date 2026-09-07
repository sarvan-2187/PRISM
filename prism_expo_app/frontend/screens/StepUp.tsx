/**
 * The comprehension check.
 *
 * Deliberately NOT another code from this phone: the device that just
 * approved cannot prove anything new with a second HMAC from the same secret.
 * Typing the real amount is a different property — it tests whether the
 * person understands what they are sending, which is the only thing that
 * catches a payer who is genuine but being talked through a scam.
 */
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Screen, Field, Button, Notice, Loading, Small, Label, Pill } from '../components/ui';
import { api, ApiError, type TransactionView } from '../lib/api';
import { approvalCode, fromBase64Url } from '../lib/otp';
import { requireBiometric } from '../lib/biometric';
import { getPairing } from '../lib/store';
import { t, type as ty, font } from '../lib/theme';
import type { Nav } from '../App';

export default function StepUp({ txId, nav }: { txId: string; nav: Nav }) {
  const [tx, setTx] = useState<TransactionView | null>(null);
  const [answer, setAnswer] = useState('');
  const [left, setLeft] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.payment(txId).then(setTx, () => setError('Could not open this payment.'));
  }, [txId]);

  async function submit() {
    if (!tx) return;
    setBusy(true);
    setError(null);
    try {
      await api.stepUp(txId, answer);

      // Passing the quiz does not send the payment: it returns the
      // transaction to PENDING and re-authorization has to happen again.
      const bio = await requireBiometric(`Approve ${tx.amountFormatted} to ${tx.payeeName}`);
      if (!bio.ok) {
        setError(bio.reason);
        setBusy(false);
        return;
      }
      const pairing = await getPairing();
      if (!pairing) throw new ApiError(0, 'NO_PAIRING', 'This phone is no longer paired.');
      const code = approvalCode(fromBase64Url(pairing.secret), tx.intentHash);
      await api.authorize(txId, code, bio.verified);
      nav.replace({ name: 'status', txId });
    } catch (err) {
      if (err instanceof ApiError) {
        const remaining = (err.details as { attemptsRemaining?: number })?.attemptsRemaining;
        if (typeof remaining === 'number') setLeft(remaining);
        if (remaining === 0 || err.failureCode !== 'STEP_UP_FAILED') {
          nav.replace({ name: 'status', txId });
          return;
        }
        setError('That is not the right number.');
        setAnswer('');
      } else {
        setError('That could not be checked.');
      }
      setBusy(false);
    }
  }

  if (!tx) return <Loading what="Loading this payment…" />;

  return (
    <Screen>
      <View style={s.head}>
        <Pill tone="warn">Additional verification</Pill>
        {left !== null && <Pill tone="danger">{left} left</Pill>}
      </View>

      <Text style={s.big}>
        You are sending <Text style={s.strong}>{tx.amountFormatted}</Text> to{' '}
        <Text style={s.strong}>{tx.payeeName}</Text>.
      </Text>

      {tx.riskReasons.length > 0 && (
        <View style={{ marginBottom: 18 }}>
          <Label>WHY PRISM STOPPED TO ASK</Label>
          {tx.riskReasons.map((r) => (
            <Text key={r} style={s.reason}>
              • {r}
            </Text>
          ))}
        </View>
      )}

      <Small>
        PRISM will never call you and ask you to move money. Neither will your bank, and no genuine
        bank has a “safe account” to transfer funds into.
      </Small>

      <View style={{ marginTop: 22 }}>
        <Field
          label="LAST TWO DIGITS OF THE AMOUNT YOU INTEND TO SEND"
          value={answer}
          onChangeText={(v) => setAnswer(v.replace(/\D/g, '').slice(0, 2))}
          keyboardType="numeric"
          maxLength={2}
          big
          autoFocus
        />
      </View>

      {error && <Notice tone="danger">{error}</Notice>}

      <Button title="Confirm and approve" onPress={submit} disabled={answer.length !== 2} busy={busy} />
      <View style={{ marginTop: 10 }}>
        <Small>
          Answering correctly does not send the payment on its own. This device still has to
          approve it afterwards.
        </Small>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  big: {
    ...ty.title,
    color: t.text,
    backgroundColor: t.card,
    borderRadius: t.radius,
    padding: 18,
    lineHeight: 30,
    marginBottom: 20,
  },
  strong: { fontFamily: font.semibold },
  reason: { ...ty.small, color: t.dim, marginBottom: 4 },
});
