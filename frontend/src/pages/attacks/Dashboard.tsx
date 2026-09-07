/**
 * Attack Simulation Dashboard — the entry point.
 *
 * Everything here is real: the scenario catalog, live-transaction feed, and
 * target list come from the live backend, and the history table is the
 * actual attack_runs table. No visual state here is faked; a failed fetch
 * shows an error, not a placeholder success.
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { attackApi, AttackApiError, AttackRun, LiveTransaction, ScenarioDefinition, TargetUser } from '@/lib/attackApi';
import { getAttackToken, setAttackToken } from '@/lib/attackApi';
import { AttackCard } from '@/components/attacks/AttackCard';
import { OutcomeBadge } from '@/components/attacks/OutcomeBadge';
import { LegitTransactionPanel } from '@/components/attacks/LegitTransactionPanel';
import { LiveTransactionsPanel } from '@/components/attacks/LiveTransactionsPanel';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { relativeTime } from '@/lib/format';

export default function AttackDashboard() {
  const [tokenInput, setTokenInput] = useState(getAttackToken());
  const [needsToken, setNeedsToken] = useState(false);
  const [scenarios, setScenarios] = useState<ScenarioDefinition[] | null>(null);
  const [targets, setTargets] = useState<TargetUser[]>([]);
  const [selectedTarget, setSelectedTarget] = useState('');
  const [selectedTx, setSelectedTx] = useState<LiveTransaction | null>(null);
  const [runs, setRuns] = useState<AttackRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, t, r] = await Promise.all([attackApi.scenarios(), attackApi.targets(), attackApi.runs()]);
      setScenarios(s);
      setTargets(t);
      setRuns(r);
      setNeedsToken(false);
      if (!selectedTarget && t[0]) setSelectedTarget(t[0].userId);
    } catch (err) {
      if (err instanceof AttackApiError && (err.status === 401 || err.status === 503)) {
        setNeedsToken(true);
      } else {
        setError(err instanceof Error ? err.message : 'Could not reach the attack simulation backend.');
      }
    }
  }, [selectedTarget]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveToken = () => {
    setAttackToken(tokenInput.trim());
    void load();
  };

  const attackHref = (scenarioId: string) => (selectedTx ? `/attacks/${scenarioId}?tx=${selectedTx.id}` : `/attacks/${scenarioId}`);

  return (
    <div className="animate-enter-up">
      <div className="mb-6 flex items-start gap-3">
        <ShieldAlert className="mt-1 size-6 text-destructive" aria-hidden="true" />
        <div>
          <h1 className="text-h2 font-semibold max-md:text-h3">Live Attack Lab</h1>
          <p className="mt-2 max-w-[70ch] text-pretty text-small text-secondary-foreground">
            Every scenario here fires real HTTP requests at the running PRISM backend against a real,
            currently-live transaction you select below — real WebAuthn signatures, real audit log rows,
            the same authorize path a genuine client uses. Outcomes are read from the actual API responses,
            never asserted in the UI.
          </p>
        </div>
      </div>

      {needsToken && (
        <Card className="mb-6 border-warning-mark">
          <CardHeader>
            <CardTitle className="text-body-lg">Operator token required</CardTitle>
            <CardDescription>
              The attack routes are gated by ATTACK_ADMIN_TOKEN on the backend (PRISM has no admin/session
              system, so this stands in for one). Enter it below — it is kept only in this tab's
              sessionStorage and sent solely as the X-Attack-Token header.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="attack-token">Operator token</Label>
              <Input
                id="attack-token"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                className="w-64"
              />
            </div>
            <Button onClick={saveToken}>Save &amp; connect</Button>
          </CardContent>
        </Card>
      )}

      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Could not load the dashboard</AlertTitle>
          <AlertDescription>
            {error}
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={load}>
                Try again
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {!needsToken && (
        <>
          <div className="mb-6">
            <LiveTransactionsPanel selectedId={selectedTx?.id} onSelect={setSelectedTx} />
          </div>

          {selectedTx ? (
            <Alert variant="success" className="mb-6">
              <AlertTitle>Attack target selected</AlertTitle>
              <AlertDescription>
                {selectedTx.payer_name} → {selectedTx.payee_name}, real transaction {selectedTx.id.slice(0, 8)}…
                Every attack card below will target this exact live transaction.{' '}
                <button className="underline" onClick={() => setSelectedTx(null)}>
                  Clear selection
                </button>
              </AlertDescription>
            </Alert>
          ) : (
            <Alert className="mb-6">
              <AlertTitle>No live transaction selected</AlertTitle>
              <AlertDescription>
                Select a row above to attack a real live transaction. Without one, launching a scenario
                falls back to a self-contained mode where the engine creates its own transaction — every
                run says clearly which mode it used.
              </AlertDescription>
            </Alert>
          )}

          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-body-lg">Self-contained fallback target</CardTitle>
              <CardDescription>
                Only used when no live transaction is selected above — the account a scenario targets when
                it needs to create its own transaction.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Select value={selectedTarget} onValueChange={setSelectedTarget}>
                <SelectTrigger className="max-w-sm">
                  <SelectValue placeholder="Select a fallback target user" />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => (
                    <SelectItem key={t.userId} value={t.userId}>
                      {t.displayName} ({t.email}) — {t.balanceFormatted}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <div className="mb-6">
            <LegitTransactionPanel targets={targets} selectedUserId={selectedTarget} />
          </div>

          <h2 className="mb-4 text-body-lg font-semibold">Attack scenarios</h2>
          {!scenarios && <p className="text-small text-secondary-foreground">Loading scenarios…</p>}
          <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {scenarios?.map((s) => <AttackCard key={s.id} scenario={s} href={attackHref(s.id)} />)}
          </div>

          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-body-lg font-semibold">Run history</h2>
            <Button variant="ghost" size="sm" onClick={load}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Refresh
            </Button>
          </div>
          {runs.length === 0 && (
            <p className="text-small text-secondary-foreground">No runs yet. Launch a scenario above.</p>
          )}
          {runs.length > 0 && (
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Scenario</TableHead>
                    <TableHead>Attacker device</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead className="text-right">Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.scenario_id}</TableCell>
                      <TableCell className="text-secondary-foreground">{r.attacker_label}</TableCell>
                      <TableCell>
                        <OutcomeBadge status={r.status} outcome={r.outcome} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-secondary-foreground">
                        {relativeTime(r.started_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
