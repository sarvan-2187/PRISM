/**
 * The security timeline: what PRISM actually did, in order.
 *
 * The one line that matters on this surface is DEVICE_APPROVED. It renders as
 * "Approved on a paired device, not a passkey" — because the mobile path
 * trades key custody for reach, and a trail that blurred the two would be
 * claiming a stronger proof than the one that happened.
 */
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Screen, Title, Button, Loading, Small, Pill } from '../components/ui';
import { api, type TimelineEvent, type TransactionView } from '../lib/api';
import { describeEvent, statusTone, STATUS_LABEL, type Tone } from '../lib/events';
import { t, type as ty, mono, font } from '../lib/theme';
import type { Nav } from '../App';

const DOT: Record<Tone, string> = {
  ok: t.success,
  warn: t.warning,
  danger: t.danger,
  plain: t.faint,
};

export default function Timeline({ txId, nav }: { txId: string; nav: Nav }) {
  const [data, setData] = useState<{ transaction: TransactionView; events: TimelineEvent[] } | null>(
    null
  );

  useEffect(() => {
    api.timeline(txId).then(setData, () => undefined);
  }, [txId]);

  if (!data) return <Loading what="Loading the security trail…" />;

  const tx = data.transaction;

  return (
    <Screen>
      <Title sub={`${tx.amountFormatted} to ${tx.payeeName}`}>Security timeline</Title>
      <Pill tone={statusTone(tx.status)}>{STATUS_LABEL[tx.status] ?? tx.status}</Pill>

      <View style={{ marginTop: 24 }}>
        {data.events.map((e, i) => {
          const { label, tone } = describeEvent(e.event);
          const last = i === data.events.length - 1;
          return (
            <View key={`${e.at}-${i}`} style={s.row}>
              <View style={s.rail}>
                <View style={[s.dot, { backgroundColor: DOT[tone] }]} />
                {!last && <View style={s.line} />}
              </View>
              <View style={{ flex: 1, paddingBottom: 20 }}>
                <Text style={[s.label, tone !== 'plain' && { color: DOT[tone] }]}>{label}</Text>
                <Text style={s.raw}>{e.event}</Text>
                {summarise(e.data).map((line) => (
                  <Text key={line} style={s.detail}>
                    {line}
                  </Text>
                ))}
              </View>
            </View>
          );
        })}
      </View>

      <Small>
        Every line is a row the server wrote as it happened. This screen reads them; it does not
        decide anything.
      </Small>
      <Button title="Back" variant="ghost" onPress={nav.back} />
    </Screen>
  );
}

/** The few fields worth surfacing. Progressive disclosure, not a JSON dump. */
function summarise(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (k: string, label: string) => {
    if (data[k] !== undefined && data[k] !== null) out.push(`${label}: ${String(data[k])}`);
  };
  push('score', 'score');
  push('decision', 'decision');
  push('failureCode', 'code');
  push('via', 'approved via');
  if (data.biometricClaimed === true) out.push('biometric: claimed by the device, not verified here');
  if (Array.isArray(data.firedRules) && data.firedRules.length) {
    out.push(`rules: ${(data.firedRules as string[]).join(', ')}`);
  }
  if (Array.isArray(data.firedRuleIds) && data.firedRuleIds.length) {
    out.push(`rules: ${(data.firedRuleIds as string[]).join(', ')}`);
  }
  const flags: Array<[string, string]> = [
    ['newDevice', 'device not seen before'],
    ['newPayee', 'recipient never paid before'],
    ['amountAnomaly', 'amount above the usual range'],
    ['noBaseline', 'no established pattern yet'],
  ];
  for (const [k, text] of flags) if (data[k] === true) out.push(text);
  return out;
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: 14 },
  rail: { alignItems: 'center', width: 10 },
  dot: { width: 9, height: 9, borderRadius: 5, marginTop: 5 },
  line: { flex: 1, width: 1, backgroundColor: t.border, marginTop: 4 },
  label: { ...ty.body, color: t.text, fontFamily: font.medium },
  raw: { ...mono, fontSize: 10, color: t.faint, marginTop: 3 },
  detail: { ...ty.small, color: t.dim, marginTop: 4 },
});
