/**
 * Live Attack Lab discovery feed — real transactions read straight from the
 * backend's `transactions` table (GET /api/v1/attacks/live-transactions),
 * polled at ~1s. A row here was created either by a real browser (Laptop 1/2
 * via the ordinary Pay flow) or by this Lab's own "Run legitimate
 * transaction" helper — the feed cannot and does not distinguish them,
 * because nothing about how a transaction was created changes what it is.
 */
import { usePoll } from '@/lib/usePoll';
import { useState } from 'react';
import { attackApi, LiveTransaction } from '@/lib/attackApi';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

function amountLabel(minor: string): string {
  return `₹${(Number(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

const STATUS_VARIANT: Record<string, 'default' | 'warning' | 'success'> = {
  PENDING: 'default',
  STEP_UP_REQUIRED: 'warning',
  SETTLED: 'success',
};

export function LiveTransactionsPanel({
  selectedId,
  onSelect,
}: {
  selectedId?: string;
  onSelect: (tx: LiveTransaction) => void;
}) {
  const [rows, setRows] = useState<LiveTransaction[] | null>(null);

  usePoll(() => attackApi.liveTransactions(), 1000, {
    onData: setRows,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-body-lg">Live transactions</CardTitle>
          <Badge variant="info">Polling every ~1s</Badge>
        </div>
        <CardDescription>
          Real, currently-observable transactions across every account — anything not yet settled, plus
          anything settled in the last 10 minutes. Select one to attack it directly.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!rows && <p className="text-small text-secondary-foreground">Loading live transactions…</p>}
        {rows && rows.length === 0 && (
          <p className="text-small text-secondary-foreground">
            No live transactions right now. Start a payment from another device (or use "Run legitimate
            transaction" below) to see it appear here in real time.
          </p>
        )}
        {rows && rows.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payer</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Payee</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Age</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((tx) => (
                  <TableRow
                    key={tx.id}
                    className={cn('cursor-pointer', selectedId === tx.id && 'bg-accent')}
                    onClick={() => onSelect(tx)}
                  >
                    <TableCell className="font-medium">{tx.payer_name}</TableCell>
                    <TableCell className="tabular">{amountLabel(tx.amount_minor)}</TableCell>
                    <TableCell className="text-secondary-foreground">{tx.payee_name}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[tx.status] ?? 'default'}>{tx.status}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right text-secondary-foreground">
                      {relativeTime(tx.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
