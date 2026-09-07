'use client';
import { useSearchParams } from 'next/navigation';

type TransactionStatus = 'APPROVED' | 'BLOCKED' | 'STEP_UP_REQUIRED' | 'SETTLED' | 'EXPIRED';

const STATUS_CONFIG: Record<TransactionStatus, { label: string; color: string }> = {
  APPROVED:         { label: 'Payment Approved',        color: 'green' },
  SETTLED:          { label: 'Payment Settled',         color: 'green' },
  BLOCKED:          { label: 'Payment Blocked',         color: 'red'   },
  STEP_UP_REQUIRED: { label: 'Verification Required',   color: 'amber' },
  EXPIRED:          { label: 'Transaction Expired',     color: 'gray'  },
};

/**
 * Transaction Status Page
 * Displays the result of a PRISM payment authorization.
 */
export default function StatusPage() {
  const params = useSearchParams();
  const transactionId = params.get('id');
  const status = (params.get('status') as TransactionStatus) ?? 'APPROVED';

  // TODO: If no status in params, fetch from GET /api/v1/transactions/:id

  const cfg = STATUS_CONFIG[status] ?? { label: 'Unknown', color: 'gray' };

  return (
    <div className="status-page">
      <h1>Transaction Status</h1>
      <p><strong>Transaction ID:</strong> {transactionId}</p>
      <p style={{ color: cfg.color }}><strong>{cfg.label}</strong></p>
      {/* TODO: Show full transaction summary (amount, recipient, timestamp) */}
    </div>
  );
}
