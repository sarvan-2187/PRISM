'use client';
import { QRCodeSVG } from 'qrcode.react';

interface QRDisplayProps {
  /** Signed QR payload string from /api/v1/qr/generate */
  payload: string;
  /** Size in pixels */
  size?: number;
}

/**
 * QR Display Component
 * Renders the signed QR payload as an SVG QR code.
 * The payload contains only a signed transaction reference — no payment details.
 */
export default function QRDisplay({ payload, size = 256 }: QRDisplayProps) {
  if (!payload) return null;
  // TODO: Add expiry countdown (QR codes live 60s)
  return (
    <div className="qr-container">
      <QRCodeSVG value={payload} size={size} />
      {/* TODO: Show countdown timer overlay */}
    </div>
  );
}
