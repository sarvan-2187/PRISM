/**
 * Drives one real, ordinary payment (initiate -> challenge -> sign -> settle)
 * for the "Live Transaction Demonstration" — so a judge can watch a genuine
 * transaction succeed on the same screen as an attack failing.
 */
import { useState } from 'react';
import { Play } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { attackApi, TargetUser } from '@/lib/attackApi';
import { LiveAttackFeed } from './LiveAttackFeed';

export function LegitTransactionPanel({ targets, selectedUserId }: { targets: TargetUser[]; selectedUserId: string }) {
  const [runId, setRunId] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  const launch = async () => {
    if (!selectedUserId) return;
    setLaunching(true);
    try {
      const { runId } = await attackApi.launchLegitPayment(selectedUserId, 'Laptop A / Laptop B (legitimate device)');
      setRunId(runId);
    } finally {
      setLaunching(false);
    }
  };

  const targetName = targets.find((t) => t.userId === selectedUserId)?.displayName ?? 'the selected user';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-body-lg">Legitimate transaction</CardTitle>
        <CardDescription>
          Runs a real payment for {targetName} through the actual pipeline — initiate, WebAuthn challenge, a
          real Ed25519 signature, risk evaluation, settlement — so you can show it succeeding alongside an
          attack failing.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Button onClick={launch} disabled={launching || !selectedUserId}>
          <Play className="size-4" aria-hidden="true" />
          {launching ? 'Starting…' : 'Run legitimate transaction'}
        </Button>
        {runId && <LiveAttackFeed key={runId} runId={runId} />}
      </CardContent>
    </Card>
  );
}
