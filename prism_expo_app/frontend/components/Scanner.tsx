/**
 * Camera scanner with a manual-entry fallback.
 *
 * The fallback is built in from the start, not bolted on: a refused camera
 * permission or a phone that will not focus on a laptop screen is the single
 * most likely way this fails in a demo, and "type it instead" has to be one
 * tap away when it happens rather than a rebuild.
 */
import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { t, type as ty, font } from '../lib/theme';

export default function Scanner({
  hint,
  placeholder,
  onScanned,
}: {
  hint: string;
  placeholder: string;
  onScanned: (value: string) => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState(false);
  const [typed, setTyped] = useState('');
  // The camera fires continuously while a code is in frame; without this the
  // handler would run dozens of times for one scan.
  const [handled, setHandled] = useState(false);

  function accept(v: string) {
    if (handled) return;
    setHandled(true);
    onScanned(v);
  }

  return (
    <View>
      <Text style={s.hint}>{hint}</Text>

      {!manual && permission?.granted && (
        <View style={s.frame}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => accept(data)}
          />
        </View>
      )}

      {!manual && permission && !permission.granted && (
        <View style={s.notice}>
          <Text style={s.noticeText}>
            {permission.canAskAgain
              ? 'PRISM needs the camera to read a payment code. Nothing is uploaded.'
              : 'Camera access is off for PRISM. Turn it on in your phone settings, or type the code.'}
          </Text>
          {permission.canAskAgain && (
            <Pressable style={s.btn} onPress={requestPermission}>
              <Text style={s.btnText}>Allow camera</Text>
            </Pressable>
          )}
        </View>
      )}

      {!manual && !permission && <ActivityIndicator color={t.primary} style={{ marginTop: 28 }} />}

      {manual && (
        <View style={{ marginTop: 16 }}>
          <TextInput
            style={s.input}
            value={typed}
            onChangeText={setTyped}
            placeholder={placeholder}
            placeholderTextColor={t.faint}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
          <Pressable
            style={[s.btn, !typed.trim() && { opacity: 0.4 }]}
            disabled={!typed.trim()}
            onPress={() => accept(typed.trim())}
          >
            <Text style={s.btnText}>Use this code</Text>
          </Pressable>
        </View>
      )}

      <Pressable style={s.link} onPress={() => setManual((m) => !m)}>
        <Text style={s.linkText}>
          {manual ? 'Use the camera instead' : 'Camera not working? Type the code'}
        </Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  hint: { ...ty.small, color: t.dim, marginBottom: 16 },
  frame: {
    height: 300,
    borderRadius: t.radius,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: t.borderStrong,
    backgroundColor: '#000',
  },
  notice: {
    padding: 18,
    borderRadius: t.radius,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.card,
  },
  noticeText: { ...ty.small, color: t.dim },
  input: {
    ...ty.small,
    fontFamily: font.mono,
    color: t.text,
    backgroundColor: t.card,
    borderWidth: 1,
    borderColor: t.borderStrong,
    borderRadius: t.control,
    padding: 14,
    minHeight: 96,
    textAlignVertical: 'top',
  },
  btn: {
    marginTop: 14,
    backgroundColor: t.primary,
    borderRadius: t.control,
    paddingVertical: 15,
    alignItems: 'center',
  },
  btnText: { ...ty.body, color: t.primaryInk, fontFamily: font.semibold },
  link: { paddingVertical: 16, alignItems: 'center' },
  linkText: { ...ty.small, color: t.primary },
});
