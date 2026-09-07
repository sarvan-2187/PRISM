/**
 * Scan a payment request and lock an intent from it.
 *
 * Scanning is not approving. The code resolves to a transaction on the
 * server, and the review screen then shows what that transaction actually
 * says, read back from PRISM's own records rather than from the code. A
 * swapped sticker can point at an attacker; it cannot make the attacker's
 * name read as the shop's.
 *
 * The camera uses the browser's own BarcodeDetector where it exists, which is
 * desktop Chrome and Edge. No scanner library is bundled: where the API is
 * missing the camera panel is simply absent, and pasting still works.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, CameraOff } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Minimal shape of the parts of BarcodeDetector this file uses. */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function barcodeDetector(): BarcodeDetectorCtor | null {
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

/** Plain English for the refusals this screen can actually produce. */
function explain(err: ApiError): string {
  if (err.failureCode === 'QR_EXPIRED') {
    return 'This code has expired. Ask for a new one: codes last 60 seconds.';
  }
  if (err.failureCode === 'QR_ALREADY_USED') {
    return 'This code was already paid. Each one can be used exactly once.';
  }
  if (err.failureCode === 'QR_INVALID_SIGNATURE') {
    const reason = (err.details as { reason?: string })?.reason;
    if (reason === 'cannot pay yourself') {
      return 'That is your own request. You cannot pay yourself.';
    }
    return 'This code was not issued by PRISM, or it has been altered since it was.';
  }
  return `${err.failureCode}: ${err.message}`;
}

export default function Scan() {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const cameraSupported = barcodeDetector() !== null && !!navigator.mediaDevices?.getUserMedia;

  const redeem = useCallback(
    async (token: string) => {
      setBusy(true);
      setError(null);
      try {
        const tx = await api.scanQr(token.trim());
        navigate(`/pay/${tx.txId}`);
      } catch (err) {
        setError(
          err instanceof ApiError ? explain(err) : 'That does not look like a PRISM code.'
        );
        setBusy(false);
      }
    },
    [navigate]
  );

  // Camera loop. Everything it starts is torn down in the same effect, so
  // leaving the page always releases the camera light.
  useEffect(() => {
    if (!scanning) return;
    const Detector = barcodeDetector();
    if (!Detector) return;

    let stream: MediaStream | null = null;
    let frame = 0;
    let stopped = false;
    const detector = new Detector({ formats: ['qr_code'] });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (stopped) return;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0 && codes[0].rawValue) {
              stopped = true;
              setScanning(false);
              void redeem(codes[0].rawValue);
              return;
            }
          } catch {
            // A dropped frame is normal while the camera focuses.
          }
          frame = requestAnimationFrame(() => void tick());
        };
        void tick();
      } catch {
        if (!stopped) {
          setError('Camera access was refused. Paste the code instead.');
          setScanning(false);
        }
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [scanning, redeem]);

  return (
    <div className="animate-enter-up">
      <h1 className="text-h3 font-semibold">Scan a payment request</h1>
      <p className="mt-2 text-pretty text-small text-secondary-foreground">
        Scanning only opens the payment. You will see who is being paid and how much, read back
        from PRISM&rsquo;s records, before anything is approved.
      </p>

      {error && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {cameraSupported && (
        <Card className="mt-5">
          <CardContent className="pt-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-body-lg font-semibold">Camera</h2>
              {scanning && <Badge variant="info">Looking for a code</Badge>}
            </div>

            {scanning ? (
              <>
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  className="aspect-[4/3] w-full rounded-lg bg-muted object-cover"
                />
                <Button
                  variant="secondary"
                  block
                  className="mt-3"
                  onClick={() => setScanning(false)}
                >
                  <CameraOff />
                  Stop the camera
                </Button>
              </>
            ) : (
              <>
                <p className="text-pretty text-small text-secondary-foreground">
                  Point this laptop&rsquo;s camera at the other screen. Hold it steady: a screen
                  behind glass takes a moment to focus.
                </p>
                <Button block className="mt-4" onClick={() => setScanning(true)} disabled={busy}>
                  <Camera />
                  Start the camera
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="mt-4">
        <CardContent className="pt-6">
          <h2 className="text-body-lg font-semibold">Paste a code</h2>
          <p className="mt-2 text-pretty text-small text-secondary-foreground">
            {cameraSupported
              ? 'Use this when the camera cannot see the other screen.'
              : 'This browser has no barcode reader, so paste the code text from the other device.'}
          </p>
          <div className="mt-4 grid gap-2">
            <Label htmlFor="token">Request code</Label>
            <Textarea
              id="token"
              rows={3}
              value={pasted}
              spellCheck={false}
              placeholder="Paste the code text here"
              onChange={(e) => setPasted(e.target.value)}
            />
          </div>
          <Button
            block
            className="mt-3"
            onClick={() => redeem(pasted)}
            disabled={pasted.trim().length === 0 || busy}
          >
            {busy ? 'Opening the payment…' : 'Open this payment'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
