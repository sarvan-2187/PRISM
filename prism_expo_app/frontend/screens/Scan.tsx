/**
 * Scan someone's payment request.
 *
 * This is where a phone genuinely beats the web client: a real camera reading
 * a real code, rather than a laptop webcam squinting at another screen.
 *
 * Scanning locks an intent and lands on Review. It does not authorize
 * anything — the amount and recipient come back from the server, so a swapped
 * code shows the real destination before a person approves it.
 */
import { useState } from 'react';
import { Screen, Title, Notice, Button, Small } from '../components/ui';
import Scanner from '../components/Scanner';
import { api, ApiError } from '../lib/api';
import { describeFailure } from '../lib/events';
import type { Nav } from '../App';

export default function Scan({ nav }: { nav: Nav }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handle(raw: string) {
    setBusy(true);
    setError(null);
    try {
      const token = raw.includes('://') ? (raw.split(/[?&]t=/)[1] ?? raw) : raw.trim();
      const tx = await api.scanQr(decodeURIComponent(token));
      nav.replace({ name: 'review', txId: tx.txId });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.failureCode === 'QR_INVALID_SIGNATURE' &&
            (err.details as { reason?: string })?.reason === 'cannot pay yourself'
            ? 'You cannot pay yourself.'
            : describeFailure(err.failureCode)
          : 'That code could not be read.'
      );
      setBusy(false);
    }
  }

  if (error) {
    return (
      <Screen>
        <Title>Not accepted</Title>
        <Notice tone="danger">{error}</Notice>
        <Small>
          PRISM checks the signature on every code before it will lock a payment from it. A code it
          did not issue is refused here, before any money is involved.
        </Small>
        <Button title="Try another code" onPress={() => setError(null)} />
        <Button title="Back" variant="ghost" onPress={nav.back} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title sub="Point the camera at a PRISM request. You will see the real amount and recipient before anything is approved.">
        Scan to pay
      </Title>
      {busy ? (
        <Small>Locking the payment…</Small>
      ) : (
        <Scanner
          hint="The code carries a reference only. PRISM resolves who gets paid from its own records."
          placeholder="Paste a payment request token"
          onScanned={handle}
        />
      )}
    </Screen>
  );
}
