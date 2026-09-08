/**
 * PRISM Authenticator.
 *
 * Four screens on a useState switch. Four screens do not need a navigation
 * library, and the dependency not added is the one that cannot break at 3 AM.
 *
 * Design: docs/superpowers/specs/2026-09-07-prism-authenticator-design.md
 */
import { useCallback, useEffect, useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Platform,
  StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  useFonts,
  Geist_400Regular,
  Geist_500Medium,
  Geist_600SemiBold,
  Geist_700Bold,
} from '@expo-google-fonts/geist';
import { GeistMono_400Regular, GeistMono_700Bold } from '@expo-google-fonts/geist-mono';

import Pair from './screens/Pair';
import Scan from './screens/Scan';
import Code from './screens/Code';
import Settings from './screens/Settings';
import Mark from './components/Mark';
import { clearPairing, getApiBase, getServerKey, loadPairing, type Pairing } from './lib/store';
import type { StepUpToken } from './lib/verify';
import { t, type as ty, attested } from './lib/theme';

type Screen = 'home' | 'scan' | 'code' | 'settings';

export default function App() {
  const [fontsReady] = useFonts({
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    Geist_700Bold,
    GeistMono_400Regular,
    GeistMono_700Bold,
  });

  const [loading, setLoading] = useState(true);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [apiBase, setApiBase] = useState('');
  const [serverKey, setServerKey] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('home');
  const [token, setToken] = useState<StepUpToken | null>(null);

  const refresh = useCallback(async () => {
    const [p, a, k] = await Promise.all([loadPairing(), getApiBase(), getServerKey()]);
    setPairing(p);
    setApiBase(a);
    setServerKey(k);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Nothing renders in a fallback typeface first. A flash of the wrong font on
  // the amount is the one place this app cannot afford to look uncertain.
  if (!fontsReady || loading) {
    return (
      <SafeAreaView style={s.screen}>
        <StatusBar style="light" />
        <ActivityIndicator color={t.primary} style={{ marginTop: 96 }} />
      </SafeAreaView>
    );
  }

  if (!pairing) {
    return (
      <SafeAreaView style={s.screen}>
        <StatusBar style="light" />
        <Pair
          onPaired={async () => {
            await refresh();
            setScreen('home');
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar style="light" />

      {screen === 'home' && (
        <View style={s.home}>
          <View style={s.brandRow}>
            <Mark size={22} />
            <View>
              <Text style={s.brand}>PRISM</Text>
              <Text style={s.brandSub}>Authenticator</Text>
            </View>
          </View>

          {/* The screen's one statement, and the only place type goes large.
              Everything below defers to it. */}
          <View style={s.statementWrap}>
            <Text style={s.statement}>
              This phone is the factor your laptop cannot fake.
            </Text>
            <Text style={s.statementNote}>
              PRISM asks for it when a payment is large or unusual. The code you get is derived
              from that transaction alone, so it can authorize nothing else.
            </Text>
          </View>

          <View style={s.spacer} />

          <View style={s.statusRow}>
            <View style={s.dot} />
            <Text style={s.statusText}>Paired</Text>
            <Text style={s.statusDim} numberOfLines={1}>
              {apiBase.replace(/^https?:\/\//, '')}
            </Text>
          </View>

          <Pressable style={s.primary} onPress={() => setScreen('scan')}>
            <Text style={s.primaryText}>Scan a payment code</Text>
          </Pressable>

          <Pressable style={s.quiet} onPress={() => setScreen('settings')} hitSlop={8}>
            <Text style={s.quietText}>This device</Text>
          </Pressable>

          <Text style={s.footnote}>Works with no signal.</Text>
        </View>
      )}

      {screen === 'scan' && (
        <Scan
          serverKey={serverKey}
          onCancel={() => setScreen('home')}
          onVerified={(tok) => {
            setToken(tok);
            setScreen('code');
          }}
        />
      )}

      {screen === 'code' && token && (
        <Code
          token={token}
          secret={pairing.secret}
          onDone={() => {
            setToken(null);
            setScreen('home');
          }}
        />
      )}

      {screen === 'settings' && (
        <Settings
          deviceId={pairing.deviceId}
          apiBase={apiBase}
          hasServerKey={Boolean(serverKey)}
          onBack={() => setScreen('home')}
          onUnpair={async () => {
            await clearPairing();
            await refresh();
            setScreen('home');
          }}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: t.bg,
    // SafeAreaView only insets on iOS; on Android it is a plain View, so the
    // status bar would sit on the first line of every screen.
    paddingTop: Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 0) : 0,
  },
  home: { flex: 1, paddingHorizontal: 24, paddingTop: 28, paddingBottom: 32 },

  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brand: { ...ty.heading, color: t.text, letterSpacing: 0.4 },
  brandSub: { ...ty.small, color: t.faint, marginTop: -2 },

  statementWrap: { ...attested, marginTop: 44 },
  statement: { ...ty.display, color: t.text },
  statementNote: { ...ty.body, color: t.dim, marginTop: 14 },

  // Pushes the actions to the thumb rather than stacking everything at the top.
  spacer: { flex: 1, minHeight: 24 },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: t.success },
  statusText: { ...ty.small, color: t.success, fontFamily: 'Geist_500Medium' },
  statusDim: { ...ty.small, color: t.faint, flexShrink: 1 },

  primary: {
    backgroundColor: t.primary,
    borderRadius: t.control,
    paddingVertical: 17,
    alignItems: 'center',
  },
  primaryText: { ...ty.heading, color: t.primaryInk },
  quiet: { paddingVertical: 16, alignItems: 'center' },
  quietText: { ...ty.body, color: t.dim },
  footnote: { ...ty.small, color: t.faint, textAlign: 'center' },
});
