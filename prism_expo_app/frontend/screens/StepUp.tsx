/**
 * Additional verification, on the phone that is making the payment.
 *
 * Two shapes, decided by the server, never by this screen:
 *
 *   AUTHENTICATOR — every paired account. The same six digits the portal's QR
 *   flow produces: HMAC(device secret, this transaction's intent hash),
 *   derived here with no network. On this surface they are DERIVED rather
 *   than scanned, because a phone cannot photograph a QR it is itself
 *   displaying — so what they prove is possession of the pairing secret plus
 *   a fresh biometric, not a second device. The digits sit next to the real
 *   payee and amount, so the person still has to read what they are sending
 *   before their thumb goes down.
 *
 *   SEMANTIC — the last-two-digits quiz, now reached only by an account with
 *   no paired phone. Kept so nobody is dead-ended by not owning one.
 *
 * Either way, passing does NOT send the payment: it returns the transaction
 * to PENDING and this device still has to authorize it.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Screen, Field, Button, Notice, Loading, Small, Label, Pill, Card } from '../components/ui';
import { api, ApiError, type TransactionView } from '../lib/api';
import { approvalCode, fromBase64Url } from '../lib/otp';
import { requireBiometric } from '../lib/biometric';
import { getPairing } from '../lib/store';
import { t, type as ty, mono, font } from '../lib/theme';
import type { Nav } from '../App';

export default function StepUp({ txId, nav }: { txId: string; nav: Nav }) {
  const [tx, setTx] = useState<TransactionView | null>(null);
  const [answer, setAnswer] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byCode = tx?.stepUpMode === 'AUTHENTICATOR';

  useEffect(() => {
    api.payment(txId).then(setTx, () => setError('Could not open this payment.'));
  }, [txId]);

  // Derive the six digits locally. The pairing secret never leaves the phone,
  // so this works with no signal — the same property the QR flow relies on.
  useEffect(() => {
    if (!tx || !byCode) return;
    void (async () => {
      const pairing = await getPairing();
      if (!pairing) {
        setError('This phone is no longer paired.');
        return;
      }
      setCode(approvalCode(fromBase64Url(pairing.secret), tx.intentHash));
    })();
  }, [tx, byCode]);

  /*
   * The window opened when /authorize asked for the step-up, so the countdown
   * starts as soon as this screen does. It is the SERVER's acceptance window
   * that expires, never the code: the code is a pure function of the intent
   * hash and is identical every time it is derived.
   */
  useEffect(() => {
    if (!byCode || expiresAt !== null) return;
    setExpiresAt(Date.now() + 60_000);
  }, [byCode, expiresAt]);

  useEffect(() => {
    if (expiresAt === null) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const reopen = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { expiresInSeconds } = await api.stepUpWindow(txId);
      setExpiresAt(Date.now() + expiresInSeconds * 1000);
    } catch {
      setError('Could not get a new window. Check your connection.');
    }
    setBusy(false);
  }, [txId]);

  async function reauthorize(current: TransactionView, verified: boolean) {
    const pairing = await getPairing();
    if (!pairing) throw new ApiError(0, 'NO_PAIRING', 'This phone is no longer paired.');
    await api.authorize(
      txId,
      approvalCode(fromBase64Url(pairing.secret), current.intentHash),
      verified
    );
  }

  async function submit() {
    if (!tx) return;
    const submitted = byCode ? code : answer;
    if (!submitted) return;

    setBusy(true);
    setError(null);
    try {
      /*
       * Biometric FIRST on the code path. The digits are already on screen, so
       * the thumb is the only thing between a picked-up phone and an approval.
       * On the quiz path it stays after the answer, where the typing is what
       * carries the comprehension.
       */
      if (byCode) {
        const bio = await requireBiometric(`Approve ${tx.amountFormatted} to ${tx.payeeName}`);
        if (!bio.ok) {
          setError(bio.reason);
          setBusy(false);
          return;
        }
        await api.stepUp(txId, submitted);
        await reauthorize(tx, bio.verified);
        nav.replace({ name: 'status', txId });
        return;
      }

      await api.stepUp(txId, submitted);
      const bio = await requireBiometric(`Approve ${tx.amountFormatted} to ${tx.payeeName}`);
      if (!bio.ok) {
        setError(bio.reason);
        setBusy(false);
        return;
      }
      await reauthorize(tx, bio.verified);
      nav.replace({ name: 'status', txId });
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.details as { attemptsRemaining?: number; expired?: boolean };
        if (typeof details?.attemptsRemaining === 'number') setLeft(details.attemptsRemaining);
        if (details?.expired) {
          setError('That window closed. Get a new one and try again.');
          setExpiresAt(0);
          setBusy(false);
          return;
        }
        if (details?.attemptsRemaining === 0 || err.failureCode !== 'STEP_UP_FAILED') {
          nav.replace({ name: 'status', txId });
          return;
        }
        setError(byCode ? 'PRISM refused that code.' : 'That is not the right number.');
        setAnswer('');
      } else {
        setError('That could not be checked.');
      }
      setBusy(false);
    }
  }

  if (!tx) return <Loading what="Loading this payment…" />;

  const expired = byCode && secondsLeft <= 0;

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
              {'•'} {r}
            </Text>
          ))}
        </View>
      )}

      <Small>
        PRISM will never call you and ask you to move money. Neither will your bank, and no genuine
        bank has a &ldquo;safe account&rdquo; to transfer funds into.
      </Small>

      {byCode ? (
        <View style={{ marginTop: 22 }}>
          <Label>THIS PAYMENT&rsquo;S CODE</Label>
          <Card>
            <Text style={s.code}>{code ?? '——————'}</Text>
            <Text style={s.codeNote}>
              {expired
                ? 'PRISM is no longer accepting it. Get a new window below.'
                : `PRISM accepts it for ${secondsLeft}s.`}
            </Text>
          </Card>
          <Small>
            These six digits are derived from this transaction alone — a different amount or a
            different recipient produces different digits, so they authorize nothing else.
          </Small>
        </View>
      ) : (
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
      )}

      {error && <Notice tone="danger">{error}</Notice>}

      {expired ? (
        <Button title="Get a new window" onPress={reopen} busy={busy} />
      ) : (
        <Button
          title={byCode ? 'Approve with this code' : 'Confirm and approve'}
          onPress={submit}
          disabled={byCode ? !code : answer.length !== 2}
          busy={busy}
        />
      )}
      <View style={{ marginTop: 10 }}>
        <Small>
          {byCode
            ? 'PRISM allows three wrong codes against this payment, then closes it for good.'
            : 'Answering correctly does not send the payment on its own. This device still has to approve it afterwards.'}
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
  code: {
    ...mono,
    color: t.text,
    fontSize: 40,
    letterSpacing: 8,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  codeNote: { ...ty.small, color: t.dim, textAlign: 'center', marginTop: 8 },
});
