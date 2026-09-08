/**
 * Review and approve. The security-critical screen.
 *
 * NON-NEGOTIABLE: every value here comes from api.payment(txId). Nothing is
 * read from navigation state, a scanned code, or anything the previous screen
 * carried. A payee passed in a route param is a payee an attacker can set.
 *
 * The countdown is the intent lock made visible. At zero the transaction is
 * dead: a new payment means a new id, a new nonce and a new hash.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Screen, Money, Button, Notice, Loading, Small, Label, Attested } from '../components/ui';
import { api, ApiError, type TransactionView } from '../lib/api';
import { approvalCode, fromBase64Url } from '../lib/otp';
import { requireBiometric, biometricAvailable } from '../lib/biometric';
import { getPairing } from '../lib/store';
import { describeFailure } from '../lib/events';
import { t, type as ty, mono, font } from '../lib/theme';
import type { Nav } from '../App';

export default function Review({
  txId,
  nav,
  onSettled,
}: {
  txId: string;
  nav: Nav;
  onSettled: () => void;
}) {
  const [tx, setTx] = useState<TransactionView | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasBiometric, setHasBiometric] = useState(false);

  const load = useCallback(async () => {
    try {
      const fresh = await api.payment(txId);
      setTx(fresh);
      setLeft(fresh.secondsRemaining);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open this payment.');
    }
  }, [txId]);

  useEffect(() => {
    void load();
    void biometricAvailable().then(setHasBiometric);
  }, [load]);

  // Local countdown off the server's own secondsRemaining. The server decides
  // expiry; this only shows it.
  useEffect(() => {
    if (left <= 0) return;
    const id = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [left]);

  async function approve() {
    if (!tx) return;
    setBusy(true);
    setError(null);
    try {
      /*
       * Biometric FIRST, before a code is derived or anything is sent.
       *
       * Without it the device code proves only that someone is holding an
       * unlocked phone. With it, possession of the phone is not enough — which
       * is the "person" half that a passkey gives the web client for free.
       */
      const bio = await requireBiometric(`Approve ${tx.amountFormatted} to ${tx.payeeName}`);
      if (!bio.ok) {
        setError(bio.reason);
        setBusy(false);
        return;
      }

      const pairing = await getPairing();
      if (!pairing) throw new ApiError(0, 'NO_PAIRING', 'This phone is no longer paired.');

      // Derived from the hash the SERVER holds for this transaction. Change a
      // rupee and the hash changes, so this code stops being valid.
      const code = approvalCode(fromBase64Url(pairing.secret), tx.intentHash);
      const result = await api.authorize(txId, code, bio.verified);

      if (result.decision === 'STEP_UP') {
        nav.replace({ name: 'stepup', txId });
        return;
      }
      onSettled();
      nav.replace({ name: 'status', txId });
    } catch (err) {
      if (err instanceof ApiError) {
        // Terminal refusals belong on the status screen with the full reason.
        if (
          ['RISK_BLOCKED', 'POLICY_DENIED', 'TAMPER_BLOCKED', 'REPLAY_BLOCKED', 'INTENT_EXPIRED'].includes(
            err.failureCode
          )
        ) {
          nav.replace({ name: 'status', txId });
          return;
        }
        setError(describeFailure(err.failureCode));
      } else {
        setError('The payment could not be approved.');
      }
      setBusy(false);
    }
  }

  if (error && !tx) {
    return (
      <Screen>
        <Notice tone="danger">{error}</Notice>
        <Button title="Back" variant="secondary" onPress={nav.back} />
      </Screen>
    );
  }
  if (!tx) return <Loading what="Opening the locked transaction…" />;

  const expired = left <= 0;

  return (
    <Screen>
      <Label>REVIEW PAYMENT</Label>

      <Attested>
        <Money value={tx.amountFormatted} size={38} />
        <Text style={s.to}>
          to <Text style={s.payee}>{tx.payeeName}</Text>
        </Text>
        <Text style={s.handle}>{tx.payeeHandle}</Text>
        <Small>Read back from PRISM, not carried here by this screen</Small>
      </Attested>

      <View style={s.timer}>
        <Text style={[s.timerNum, expired && { color: t.danger }]}>
          {expired ? 'Expired' : `${left}s`}
        </Text>
        <Text style={s.timerLabel}>
          {expired ? 'Start a new payment' : 'left to approve this exact transaction'}
        </Text>
      </View>

      {tx.riskReasons.length > 0 && (
        <View style={s.reasons}>
          <Label>WHAT PRISM NOTICED</Label>
          {tx.riskReasons.map((r) => (
            <Text key={r} style={s.reason}>
              • {r}
            </Text>
          ))}
        </View>
      )}

      {error && <Notice tone="danger">{error}</Notice>}

      <Button
        title={hasBiometric ? 'Approve with biometrics' : 'Approve on this device'}
        onPress={approve}
        disabled={expired}
        busy={busy}
      />
      <Button title="Cancel" variant="ghost" onPress={nav.back} />

      <View style={{ marginTop: 12 }}>
        <Small>
          {hasBiometric
            ? 'Your fingerprint or face unlocks a code derived from this transaction’s own fingerprint. It authorizes nothing else.'
            : 'This device signs with a code derived from this transaction’s own fingerprint. It authorizes nothing else.'}
        </Small>
      </View>

      <View style={s.hashBlock}>
        <Label>TRANSACTION FINGERPRINT</Label>
        <Text style={s.hash} numberOfLines={2}>
          {tx.intentHash}
        </Text>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  to: { ...ty.body, color: t.dim, marginTop: 8 },
  payee: { color: t.text, fontFamily: font.semibold },
  handle: { ...ty.small, color: t.faint, marginTop: 2, marginBottom: 8 },
  timer: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 22 },
  timerNum: { ...ty.title, ...mono, color: t.warning },
  timerLabel: { ...ty.small, color: t.faint, flexShrink: 1 },
  reasons: { marginTop: 22 },
  reason: { ...ty.small, color: t.dim, marginBottom: 4 },
  hashBlock: { marginTop: 28, borderTopWidth: 1, borderTopColor: t.border, paddingTop: 16 },
  hash: { ...mono, fontSize: 11, color: t.faint, lineHeight: 16 },
});
