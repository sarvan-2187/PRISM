/**
 * Camera scanner with a manual-entry fallback, shared by pairing and step-up.
 *
 * The fallback is built in from the start, not bolted on: a camera permission
 * refused or a phone that will not focus on a laptop screen is the single most
 * likely way this demo fails, and "type the code instead" has to be one tap
 * away when it happens rather than a rebuild.
 */
import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { t, type as ty, font } from '../lib/theme';

interface Props {
  title: string;
  hint: string;
  placeholder: string;
  onScanned: (value: string) => void;
  onCancel?: () => void;
}

export default function Scanner({ title, hint, placeholder, onScanned, onCancel }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState(false);
  const [typed, setTyped] = useState('');
  // The camera fires repeatedly while a code is in frame; without this the
  // handler runs dozens of times for one scan.
  const [handled, setHandled] = useState(false);

  function accept(value: string) {
    if (handled) return;
    setHandled(true);
    onScanned(value);
  }

  const showCamera = !manual && permission?.granted;

  return (
    <View style={s.wrap}>
      <Text style={s.title}>{title}</Text>
      <Text style={s.hint}>{hint}</Text>

      {showCamera && (
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
              ? 'PRISM needs the camera to read the code. Nothing is uploaded.'
              : 'Camera access is off for this app. Enable it in Settings, or type the code instead.'}
          </Text>
          {permission.canAskAgain && (
            <Pressable style={s.btn} onPress={requestPermission}>
              <Text style={s.btnText}>Allow camera</Text>
            </Pressable>
          )}
        </View>
      )}

      {!manual && !permission && <ActivityIndicator color={t.primary} style={{ marginTop: 24 }} />}

      {manual && (
        <View style={{ marginTop: 20 }}>
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
            style={[s.btn, !typed.trim() && s.btnOff]}
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

      {onCancel && (
        <Pressable style={s.link} onPress={onCancel}>
          <Text style={s.linkText}>Cancel</Text>
        </Pressable>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: 24, paddingTop: 28 },
  title: { ...ty.title, color: t.text },
  hint: { ...ty.small, color: t.dim, marginTop: 8 },
  frame: {
    marginTop: 22,
    height: 300,
    borderRadius: t.radius,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: t.borderStrong,
    backgroundColor: '#000',
  },
  notice: {
    marginTop: 22,
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
    minHeight: 100,
    textAlignVertical: 'top',
  },
  btn: {
    marginTop: 14,
    backgroundColor: t.primary,
    borderRadius: t.control,
    paddingVertical: 15,
    alignItems: 'center',
  },
  btnOff: { opacity: 0.4 },
  btnText: { ...ty.body, color: t.primaryInk, fontFamily: font.semibold },
  link: { paddingVertical: 16, alignItems: 'center' },
  linkText: { ...ty.small, color: t.primary },
});
