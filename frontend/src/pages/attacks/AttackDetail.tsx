/**
 * Attack Detail page — description, impact, mechanism, target selection, and
 * the real Launch button. Clicking Launch calls the real backend
 * (attackApi.launch), which returns a runId for a scenario that is already
 * executing against the live PRISM API; LiveAttackFeed then polls the real
 * run record. There is no local "simulate success" state anywhere here.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Radiation, Info } from 'lucide-react';
import { attackApi, AttackApiError, LiveTransaction, ScenarioDefinition, TargetUser } from '@/lib/attackApi';
import { LiveAttackFeed } from '@/components/attacks/LiveAttackFeed';
import { LiveTransactionsPanel } from '@/components/attacks/LiveTransactionsPanel';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-body-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-small">{children}</CardContent>
    </Card>
  );
}

export default function AttackDetail() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [targets, setTargets] = useState<TargetUser[]>([]);
  const [targetUserId, setTargetUserId] = useState('');
  const [selectedTx, setSelectedTx] = useState<LiveTransaction | null>(null);
  const [victimCookie, setVictimCookie] = useState('');
  const [attackerCookie, setAttackerCookie] = useState('');
  const [attackerLabel, setAttackerLabel] = useState('Laptop 3 (Attacker Device)');
  const [runId, setRunId] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!scenarioId) return;
    setError(null);
    try {
      const [s, t, live] = await Promise.all([attackApi.scenario(scenarioId), attackApi.targets(), attackApi.liveTransactions()]);
      setScenario(s);
      setTargets(t);
      if (t[0]) setTargetUserId(t[0].userId);
      const preselectedId = searchParams.get('tx');
      if (preselectedId) {
        const match = live.find((tx) => tx.id === preselectedId);
        if (match) setSelectedTx(match);
      }
    } catch (err) {
      if (err instanceof AttackApiError && (err.status === 401 || err.status === 503)) {
        navigate('/attacks');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load this scenario.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectTx = (tx: LiveTransaction) => {
    setSelectedTx(tx);
    setSearchParams({ tx: tx.id });
  };

  const launch = async () => {
    if (!scenario || (!selectedTx && !targetUserId)) return;
    setLaunching(true);
    setError(null);
    try {
      const { runId } = await attackApi.launch(scenario.id, {
        transactionId: selectedTx?.id,
        targetUserId: selectedTx ? undefined : targetUserId,
        attackerLabel,
        victimSessionCookie: scenario.usesVictimSession && victimCookie.trim() ? victimCookie.trim() : undefined,
        attackerSessionCookie: scenario.usesAttackerSession && attackerCookie.trim() ? attackerCookie.trim() : undefined,
      });
      setRunId(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not launch the attack.');
    } finally {
      setLaunching(false);
    }
  };

  if (!scenario) {
    return error ? (
      <Alert variant="destructive">
        <AlertTitle>Could not load scenario</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    ) : (
      <p className="text-small text-secondary-foreground">Loading…</p>
    );
  }

  return (
    <div className="animate-enter-up grid gap-6">
      <div>
        <Link
          to="/attacks"
          className="inline-flex items-center gap-1.5 text-small text-secondary-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to dashboard
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-h2 font-semibold max-md:text-h3">{scenario.name}</h1>
          <Badge variant="outline">{scenario.category}</Badge>
          <Badge variant={scenario.severity === 'HIGH' ? 'destructive' : scenario.severity === 'MEDIUM' ? 'warning' : 'default'} dot={false}>
            {scenario.severity}
          </Badge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="1. Attack Description">
          <p className="text-pretty">{scenario.whatItIs}</p>
          <p className="text-pretty text-secondary-foreground">
            <span className="font-medium text-foreground">Why it's dangerous: </span>
            {scenario.howItAffectsTheModel}
          </p>
          <p className="text-pretty text-secondary-foreground">
            <span className="font-medium text-foreground">What the attacker is trying to achieve: </span>
            {scenario.attackerGoal}
          </p>
        </Section>

        <Section title="2. Impact">
          <p className="text-pretty">{scenario.howItAffectsTheModel}</p>
          <p>
            <span className="font-medium">Component under test: </span>
            {scenario.expectedDetectionLayer}
          </p>
          <ul className="list-inside list-disc text-secondary-foreground">
            {scenario.expectedDetectionFiles.map((f) => (
              <li key={f} className="font-mono text-caption">
                {f}
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <Section title="3. Attack Mechanism">
        <p className="text-pretty">{scenario.mechanism}</p>
        <p className="text-pretty">
          <span className="font-medium">Attacker device: </span>
          {scenario.attackerDevice}
        </p>
        <p className="text-pretty">
          <span className="font-medium">Target: </span>
          {scenario.targetDescription}
        </p>
        <div>
          <span className="font-medium">Preconditions:</span>
          <ul className="mt-1 list-inside list-disc text-secondary-foreground">
            {scenario.preconditions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
        <p className="text-pretty">
          <span className="font-medium">Expected security outcome: </span>
          {scenario.expectedOutcome}
        </p>
        {scenario.networkHonestyNote && (
          <Alert variant="info">
            <Info className="size-4" />
            <AlertTitle>Network-detection honesty note</AlertTitle>
            <AlertDescription>{scenario.networkHonestyNote}</AlertDescription>
          </Alert>
        )}
        {(scenario.assumptions.length > 0 || scenario.limitations.length > 0) && (
          <div className="grid gap-2 rounded-md border border-dashed p-3 text-caption text-secondary-foreground">
            {scenario.assumptions.length > 0 && (
              <p>
                <span className="font-medium text-foreground">Assumptions: </span>
                {scenario.assumptions.join(' ')}
              </p>
            )}
            {scenario.limitations.length > 0 && (
              <p>
                <span className="font-medium text-foreground">Limitations: </span>
                {scenario.limitations.join(' ')}
              </p>
            )}
          </div>
        )}
      </Section>

      <Section title="4. Target">
        <LiveTransactionsPanel selectedId={selectedTx?.id} onSelect={selectTx} />

        {selectedTx ? (
          <Alert variant="success">
            <AlertDescription>
              Targeting real live transaction <span className="font-mono">{selectedTx.id.slice(0, 8)}…</span> —{' '}
              {selectedTx.payer_name} → {selectedTx.payee_name}.{' '}
              <button className="underline" onClick={() => setSelectedTx(null)}>
                Clear and use the fallback target below instead
              </button>
            </AlertDescription>
          </Alert>
        ) : (
          <div className="grid max-w-md gap-1.5">
            <Label htmlFor="target-user">No live transaction selected — fallback target user</Label>
            <Select value={targetUserId} onValueChange={setTargetUserId}>
              <SelectTrigger id="target-user">
                <SelectValue placeholder="Select a target" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((t) => (
                  <SelectItem key={t.userId} value={t.userId}>
                    {t.displayName} ({t.email}) — {t.balanceFormatted}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-caption text-secondary-foreground">
              This scenario will create its own transaction against this user — not a live-transaction
              demonstration.
            </p>
          </div>
        )}

        {scenario.usesVictimSession && (
          <div className="grid gap-1.5">
            <Label htmlFor="victim-cookie">Victim session cookie (optional)</Label>
            <textarea
              id="victim-cookie"
              value={victimCookie}
              onChange={(e) => setVictimCookie(e.target.value)}
              placeholder="prism_session=... — paste from the target's own Home page 'Copy session for Attack Lab' button"
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-caption"
            />
            <p className="text-caption text-secondary-foreground">
              {victimCookie.trim()
                ? 'A real captured session will be used — this is a genuine stolen-cookie demonstration.'
                : "Left blank: the engine will authenticate as the transaction's owner itself (a real additional login, not a stolen-cookie demonstration)."}
            </p>
          </div>
        )}

        {scenario.usesAttackerSession && (
          <div className="grid gap-1.5">
            <Label htmlFor="attacker-cookie">Attacker session cookie (optional)</Label>
            <textarea
              id="attacker-cookie"
              value={attackerCookie}
              onChange={(e) => setAttackerCookie(e.target.value)}
              placeholder="prism_session=... — a real session for a separate account the attacker controls"
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-caption"
            />
            <p className="text-caption text-secondary-foreground">
              {attackerCookie.trim()
                ? "A real captured attacker session will be used."
                : 'Left blank: the engine logs in as a separate seeded user itself.'}
            </p>
          </div>
        )}

        <div className="grid max-w-md gap-1.5">
          <Label htmlFor="attacker-label">Attacker device label</Label>
          <input
            id="attacker-label"
            value={attackerLabel}
            onChange={(e) => setAttackerLabel(e.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-body"
          />
        </div>
      </Section>

      <Section title="5. Launch">
        <p className="text-secondary-foreground">
          This sends real requests to the live PRISM API and writes a real run to the database. Nothing
          below is a rendered animation — it is the actual outcome.
        </p>
        <Button
          size="lg"
          variant="destructive"
          onClick={launch}
          disabled={launching || (!selectedTx && !targetUserId)}
          className="w-fit"
        >
          <Radiation className="size-4" aria-hidden="true" />
          {launching ? 'Launching…' : 'Launch Attack'}
        </Button>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </Section>

      {runId && <LiveAttackFeed key={runId} runId={runId} />}
    </div>
  );
}
