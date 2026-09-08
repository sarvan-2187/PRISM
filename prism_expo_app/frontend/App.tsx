/**
 * PRISM App — the payment portal, on a phone.
 *
 * Navigation is a small stack in useState rather than expo-router. Ten screens
 * with one back action do not need a file-based router, and the router would
 * have been a restructure plus a dependency for behaviour this replaces in
 * thirty lines.
 *
 * Sign-in is the paired-device code, not a passkey: React Native has no
 * navigator.credentials and a native passkey needs a signed build. See
 * APP-PLAN/APP-PLAN.md §1 for what that trade costs and why the audit trail
 * names it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Platform,
  StatusBar as RNStatusBar,
  AppState,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import {
  useFonts,
  Geist_400Regular,
  Geist_500Medium,
  Geist_600SemiBold,
  Geist_700Bold,
} from '@expo-google-fonts/geist';
import { GeistMono_400Regular, GeistMono_700Bold } from '@expo-google-fonts/geist-mono';
import { Feather } from '@expo/vector-icons';

import Mark from './components/Mark';
import Setup from './screens/Setup';
import SignIn from './screens/SignIn';
import Home from './screens/Home';
import Send from './screens/Send';
import Review from './screens/Review';
import StepUp from './screens/StepUp';
import Status from './screens/Status';
import Timeline from './screens/Timeline';
import Receive from './screens/Receive';
import Scan from './screens/Scan';
import Settings from './screens/Settings';
import Authenticator from './screens/Authenticator';

import { api, ApiError, type Me } from './lib/api';
import { getApiBase, getPairing, getToken, clearToken, clearPairing } from './lib/store';
import { requireBiometric } from './lib/biometric';
import { t, type as ty, font } from './lib/theme';

export type Route =
  | { name: 'home' }
  | { name: 'send' }
  | { name: 'review'; txId: string }
  | { name: 'stepup'; txId: string }
  | { name: 'status'; txId: string }
  | { name: 'timeline'; txId: string }
  | { name: 'receive' }
  | { name: 'scan' }
  | { name: 'settings' }
  | { name: 'authenticator'; token?: string };

/**
 * Foreground notifications are silent by default in Expo Go — without this,
 * a step-up notification would only ever appear while the app is backgrounded.
 * A pending payment is exactly the case where the user might already be
 * looking at the phone, so it has to show either way.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export interface Nav {
  push: (r: Route) => void;
  replace: (r: Route) => void;
  back: () => void;
  home: () => void;
}

type Phase = 'loading' | 'setup' | 'signin' | 'locked' | 'ready';

export default function App() {
  const [fontsReady] = useFonts({
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    Geist_700Bold,
    GeistMono_400Regular,
    GeistMono_700Bold,
  });

  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);
  const route = stack[stack.length - 1];

  const nav: Nav = {
    push: (r) => setStack((s) => [...s, r]),
    replace: (r) => setStack((s) => [...s.slice(0, -1), r]),
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    home: () => setStack([{ name: 'home' }]),
  };

  /** Where are we: no server, no pairing, no session, or signed in? */
  const boot = useCallback(async () => {
    const [base, pairing, token] = await Promise.all([getApiBase(), getPairing(), getToken()]);
    if (!base || !pairing) {
      setPhase('setup');
      return;
    }
    if (!token) {
      setPhase('signin');
      return;
    }
    try {
      setMe(await api.me());
      setStack([{ name: 'home' }]);
      setPhase('ready');
    } catch (err) {
      // An expired or forged token reads as signed out rather than an error.
      if (err instanceof ApiError && err.status === 401) await clearToken();
      setPhase('signin');
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch {
      /* the screen that needed it will show its own error */
    }
  }, []);

  /*
   * Notice a web-portal step-up the instant it appears, and raise a local
   * notification for it — no EAS project or push server involved, so this
   * only fires while the app is running (foreground or recently
   * backgrounded), never from fully closed. Tapping the notification jumps
   * straight to the code screen with the token already in hand, skipping the
   * manual QR scan.
   *
   * `notified` tracks the last txId a notification was already raised for,
   * so a step-up still waiting on the next poll tick does not re-notify
   * every 5 seconds.
   */
  const notified = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== 'ready') return;
    void Notifications.requestPermissionsAsync();

    let cancelled = false;
    const tick = async () => {
      try {
        const pending = await api.devicePending();
        if (cancelled || !pending.pending || pending.txId === notified.current) return;
        notified.current = pending.txId;
        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'PRISM needs your approval',
            body: 'A payment on the web portal is waiting for your code. Tap to open it.',
            data: { token: pending.token },
          },
          trigger: null,
        });
      } catch {
        /* a dropped poll just means the next tick tries again */
      }
    };

    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase]);

  // A tapped notification carries the already-signed token, so the
  // Authenticator screen opens straight to the code instead of the scanner.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const token = response.notification.request.content.data?.token;
      if (typeof token === 'string') nav.push({ name: 'authenticator', token });
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Lock on returning from the background.
   *
   * The stored device secret can authorize payments, so leaving the app open
   * on a desk is the same risk as leaving a signed-in banking tab open. The
   * OS lock screen is not enough: the phone may already be unlocked.
   */
  useEffect(() => {
    if (phase !== 'ready') return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') setPhase('locked');
    });
    return () => sub.remove();
  }, [phase]);

  async function unlock() {
    const r = await requireBiometric('Unlock PRISM');
    if (r.ok) {
      setPhase('ready');
      void refreshMe();
    }
  }

  if (!fontsReady || phase === 'loading') {
    return (
      <SafeAreaView style={s.screen}>
        <StatusBar style="light" />
        <ActivityIndicator color={t.primary} style={{ marginTop: 96 }} />
      </SafeAreaView>
    );
  }

  if (phase === 'setup') {
    return (
      <SafeAreaView style={s.screen}>
        <StatusBar style="light" />
        <Setup onDone={boot} />
      </SafeAreaView>
    );
  }

  if (phase === 'signin') {
    return (
      <SafeAreaView style={s.screen}>
        <StatusBar style="light" />
        <SignIn
          onSignedIn={boot}
          onReset={async () => {
            await clearPairing();
            await boot();
          }}
        />
      </SafeAreaView>
    );
  }

  if (phase === 'locked') {
    return (
      <SafeAreaView style={s.screen}>
        <StatusBar style="light" />
        <View style={s.lock}>
          <Mark size={30} />
          <Text style={s.lockTitle}>PRISM is locked</Text>
          <Text style={s.lockBody}>
            This phone can approve payments, so it locks itself whenever you leave the app.
          </Text>
          <Pressable style={s.lockBtn} onPress={unlock}>
            <Text style={s.lockBtnText}>Unlock</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  /*
   * Icons chosen for what they mean here, not for decoration: the send and
   * receive arrows are the SAME glyphs the statement uses for debit and
   * credit, so one visual language covers "money out" and "money in" across
   * the whole app.
   */
  const NAV: { r: Route['name']; label: string; icon: keyof typeof Feather.glyphMap }[] = [
    { r: 'home', label: 'Home', icon: 'home' },
    { r: 'send', label: 'Send', icon: 'arrow-up-right' },
    { r: 'receive', label: 'Receive', icon: 'arrow-down-left' },
    { r: 'scan', label: 'Scan', icon: 'maximize' },
    { r: 'settings', label: 'Device', icon: 'smartphone' },
  ];

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar style="light" />

      <View style={s.header}>
        <Pressable style={s.brand} onPress={nav.home}>
          <Mark size={20} />
          <Text style={s.brandText}>PRISM</Text>
        </Pressable>
        {me && (
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.who}>{me.displayName.split(' ')[0]}</Text>
            <Text style={s.balance}>{me.balanceFormatted}</Text>
          </View>
        )}
      </View>

      <View style={{ flex: 1 }}>
        {route.name === 'home' && <Home me={me} nav={nav} onRefresh={refreshMe} />}
        {route.name === 'send' && <Send nav={nav} />}
        {route.name === 'review' && <Review txId={route.txId} nav={nav} onSettled={refreshMe} />}
        {route.name === 'stepup' && <StepUp txId={route.txId} nav={nav} />}
        {route.name === 'status' && <Status txId={route.txId} nav={nav} />}
        {route.name === 'timeline' && <Timeline txId={route.txId} nav={nav} />}
        {route.name === 'receive' && <Receive nav={nav} onRefresh={refreshMe} />}
        {route.name === 'scan' && <Scan nav={nav} />}
        {route.name === 'authenticator' && <Authenticator token={route.token} nav={nav} />}
        {route.name === 'settings' && (
          <Settings
            me={me}
            nav={nav}
            onSignOut={async () => {
              await clearToken();
              setMe(null);
              await boot();
            }}
            onUnpair={async () => {
              await clearPairing();
              setMe(null);
              await boot();
            }}
          />
        )}
      </View>

      <View style={s.tabs}>
        {NAV.map((item) => {
          const active = route.name === item.r;
          return (
            <Pressable
              key={item.r}
              style={s.tab}
              onPress={() => setStack([{ name: item.r } as Route])}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <Feather
                name={item.icon}
                size={19}
                color={active ? t.primary : t.faint}
              />
              <Text style={[s.tabText, active && { color: t.text }]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: t.bg,
    // SafeAreaView only insets on iOS; on Android it is a plain View.
    paddingTop: Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 0) : 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: t.border,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandText: { ...ty.heading, color: t.text, letterSpacing: 0.4 },
  who: { ...ty.small, color: t.faint },
  balance: { ...ty.heading, color: t.text, fontVariant: ['tabular-nums'] },

  tabs: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: t.border,
    paddingBottom: Platform.OS === 'ios' ? 0 : 6,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, gap: 4 },
  tabText: { ...ty.small, fontFamily: font.medium, color: t.faint, fontSize: 11 },

  lock: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 14 },
  lockTitle: { ...ty.title, color: t.text, marginTop: 6 },
  lockBody: { ...ty.small, color: t.dim, textAlign: 'center' },
  lockBtn: {
    marginTop: 12,
    backgroundColor: t.primary,
    borderRadius: t.control,
    paddingVertical: 15,
    paddingHorizontal: 40,
  },
  lockBtnText: { ...ty.heading, color: t.primaryInk, fontFamily: font.semibold },
});
