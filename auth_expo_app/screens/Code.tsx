/**
 * The six digits, and what they are for.
 *
 * Everything here comes from the SIGNED token, never from the portal's word
 * for it. That is the whole reason a second device exists: the user reads the
 * payee and amount off a screen the attacker does not control, and compares.
 *
 * No network is used on this screen. Showing it in airplane mode is the
 * clearest statement that the code is bound to the transaction, not a session.
 */
import { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { approvalCode, denialCode, fromBase64Url } from '../lib/otp';
import { formatMinor, type StepUpToken } from '../lib/verify';
import { t, type as ty, mono, attested, font } from '../lib/theme';

interface Props {
  token: StepUpToken;
  secret: string;
  onDone: () => void;
}

export default function Code({ token, secret, onDone }: Props) {
  const [denying, setDenying] = useState(false);
  const [left, setLeft] = useState<number | null>(null);

  const bytes = fromBase64Url(secret);
  const code = denying ? denialCode(bytes, token.intentHash) : approvalCode(bytes, token.intentHash);

  // Mirrors the server's window. Display only: the server decides expiry, this
  // just stops someone reading out a code that is already dead.
  useEffect(() => {
    if (!token.exp) return;
    const tick = () => setLeft(Math.max(0, Math.floor(token.exp! - Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [token.exp]);

  const expired = left !== null && left <= 0;
  const grouped = `${code.slice(0, 3)} ${code.slice(3)}`;

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Text style={[s.eyebrow, denying && { color: t.danger }]}>
        {denying ? 'REPORT AS FRAUD' : 'APPROVE ON THIS DEVICE'}
      </Text>

      {/* The attested block. The hairline rule is the same gesture the portal
          uses, and means the same thing: PRISM asserted this, this page did not. */}
      <View style={[s.attest, denying && { borderLeftColor: t.danger }]}>
        <Text style={s.amount}>{formatMinor(token.amountMinor, token.currency)}</Text>
        <Text style={s.to}>
          to <Text style={s.payee}>{token.payee}</Text>
        </Text>
        <Text style={s.attestNote}>
          Read from PRISM&rsquo;s signature{token.payeeIsNew ? ' · never paid before' : ''}
        </Text>
      </View>

      {!!token.reasons?.length && (
        <View style={s.reasons}>
          {token.reasons.map((r) => (
            <Text key={r} style={s.reason}>
              {r}
            </Text>
          ))}
        </View>
      )}

      {/* The focal point. Everything above is context for these digits. */}
      <View style={s.codeBlock}>
        <Text style={[s.code, expired && s.codeDead]} accessibilityLabel={code.split('').join(' ')}>
          {expired ? '— — —  — — —' : grouped}
        </Text>
        {left !== null && (
          <Text style={[s.timer, expired && { color: t.danger }]}>
            {expired ? 'Expired' : `${left}s`}
          </Text>
        )}
      </View>

      <Text style={s.instruction}>
        {denying
          ? 'Type this into the portal instead. It looks like an ordinary code and reads like one to anyone watching, but it stops the payment and flags it for review.'
          : 'Check the amount and the name above against the screen you are paying from. If they differ, do not type this in.'}
      </Text>

      <Pressable
        style={[s.action, denying ? s.actionBack : s.actionDeny]}
        onPress={() => setDenying((d) => !d)}
      >
        <Text style={[s.actionText, { color: denying ? t.dim : t.danger }]}>
          {denying ? 'Back to the approval code' : "This isn't me"}
        </Text>
      </Pressable>

      <Pressable style={s.done} onPress={onDone} hitSlop={8}>
        <Text style={s.doneText}>Done</Text>
      </Pressable>

      <View style={s.hashBlock}>
        <Text style={s.hashLabel}>TRANSACTION FINGERPRINT</Text>
        <Text style={s.hash} numberOfLines={2}>
          {token.intentHash}
        </Text>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 56 },

  eyebrow: { ...ty.label, color: t.faint },

  attest: { ...attested, marginTop: 14 },
  amount: { ...ty.display, ...mono, color: t.text, fontFamily: font.monoBold, fontSize: 38 },
  to: { ...ty.body, color: t.dim, marginTop: 6 },
  payee: { color: t.text, fontFamily: font.semibold },
  attestNote: { ...ty.small, color: t.faint, marginTop: 8 },

  reasons: { marginTop: 22, gap: 6 },
  reason: { ...ty.small, color: t.dim },

  codeBlock: { alignItems: 'center', marginTop: 40 },
  code: { ...mono, fontFamily: font.monoBold, fontSize: 46, color: t.text, letterSpacing: 2 },
  codeDead: { color: t.faint, letterSpacing: 0 },
  timer: { ...ty.small, ...mono, color: t.faint, marginTop: 10 },

  instruction: { ...ty.small, color: t.dim, marginTop: 28, textAlign: 'center' },

  action: { marginTop: 26, borderRadius: t.control, paddingVertical: 15, alignItems: 'center' },
  actionDeny: { borderWidth: 1, borderColor: t.border },
  actionBack: { backgroundColor: t.raised },
  actionText: { ...ty.body, fontFamily: font.medium },

  done: { paddingVertical: 16, alignItems: 'center' },
  doneText: { ...ty.body, color: t.faint },

  hashBlock: { marginTop: 24, borderTopWidth: 1, borderTopColor: t.border, paddingTop: 16 },
  hashLabel: { ...ty.label, color: t.faint, fontSize: 10 },
  hash: { ...mono, fontSize: 11, color: t.faint, marginTop: 6, lineHeight: 16 },
});
