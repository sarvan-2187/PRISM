'use client';
import { useState } from 'react';
import QRDisplay from '@/components/QRDisplay';
import { apiClient } from '@/lib/api-client';

/**
 * QR Display/Scan Page
 * Fetches a signed QR payload from the backend and displays it.
 * The QR contains only a signed transaction reference.
 */
export default function QRPage() {
  const [qrPayload, setQrPayload] = useState<string | null>(null);

  const fetchQR = async (transactionId: string) => {
    // TODO: const payload = await apiClient.generateQR(transactionId);
    // TODO: setQrPayload(payload);
  };

  return (
    <div className="qr-page">
      <h1>Scan to Pay</h1>
      {qrPayload ? (
        <QRDisplay payload={qrPayload} />
      ) : (
        <p>Loading QR code...</p>
      )}
      {/* TODO: Auto-refresh QR if expired (every 60s) */}
    </div>
  );
}
