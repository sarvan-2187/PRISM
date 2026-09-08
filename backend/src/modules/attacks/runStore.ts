/**
 * Persistence for the Attack Simulation Dashboard.
 *
 * Every row here is written at the moment a real event happens during a run
 * (an HTTP response resolving, a DB read completing) — this module has no
 * concept of a "fake" event. It is deliberately dumb: it stores whatever
 * engine.ts and the attacker modules tell it happened.
 */
import { query } from '../../db/pool';

export type RunStatus = 'RUNNING' | 'COMPLETE' | 'ERROR';

export type RunOutcome =
  | 'SIMULATED'
  | 'DETECTED'
  | 'BLOCKED'
  | 'PARTIALLY_MITIGATED'
  | 'SUCCEEDED'
  | 'PROTECTION_UNAVAILABLE';

export type EventActor = 'ATTACKER' | 'LEGITIMATE' | 'PRISM' | 'SYSTEM';

export type PrismLayer =
  | 'IDENTITY'
  | 'INTENT'
  | 'CONTEXT'
  | 'RISK'
  | 'SEMANTIC'
  | 'AUTHORIZATION'
  | 'LEDGER'
  | 'NETWORK'
  | 'QR'
  | 'NONE';

export interface AttackRunRow {
  id: string;
  scenario_id: string;
  attacker_label: string;
  target_user_id: string | null;
  target_transaction_id: string | null;
  status: RunStatus;
  outcome: RunOutcome | null;
  summary: string | null;
  error_message: string | null;
  started_at: Date;
  finished_at: Date | null;
}

export interface AttackRunEventRow {
  id: string;
  run_id: string;
  seq: number;
  ts: Date;
  actor: EventActor;
  prism_layer: PrismLayer | null;
  message: string;
  detail: Record<string, unknown>;
}

export async function createRun(opts: {
  scenarioId: string;
  attackerLabel: string;
  targetUserId?: string | null;
}): Promise<AttackRunRow> {
  const { rows } = await query<AttackRunRow>(
    `INSERT INTO attack_runs (scenario_id, attacker_label, target_user_id)
     VALUES ($1, $2, $3) RETURNING *`,
    [opts.scenarioId, opts.attackerLabel, opts.targetUserId ?? null]
  );
  return rows[0];
}

export async function setRunTarget(runId: string, targetTransactionId: string): Promise<void> {
  await query('UPDATE attack_runs SET target_transaction_id = $2 WHERE id = $1', [
    runId,
    targetTransactionId,
  ]);
}

export async function finishRun(
  runId: string,
  outcome: RunOutcome,
  summary: string
): Promise<void> {
  await query(
    `UPDATE attack_runs SET status = 'COMPLETE', outcome = $2, summary = $3, finished_at = NOW()
     WHERE id = $1`,
    [runId, outcome, summary]
  );
}

export async function errorRun(runId: string, message: string): Promise<void> {
  await query(
    `UPDATE attack_runs SET status = 'ERROR', error_message = $2, finished_at = NOW() WHERE id = $1`,
    [runId, message]
  );
}

/** Monotonic per-run sequence number, so events render in the order they truly happened. */
const seqCounters = new Map<string, number>();

export async function appendEvent(
  runId: string,
  actor: EventActor,
  prismLayer: PrismLayer | null,
  message: string,
  detail: Record<string, unknown> = {}
): Promise<AttackRunEventRow> {
  const seq = (seqCounters.get(runId) ?? 0) + 1;
  seqCounters.set(runId, seq);
  const { rows } = await query<AttackRunEventRow>(
    `INSERT INTO attack_run_events (run_id, seq, actor, prism_layer, message, detail)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [runId, seq, actor, prismLayer, message, JSON.stringify(detail)]
  );
  return rows[0];
}

export async function getRun(runId: string): Promise<AttackRunRow | null> {
  const { rows } = await query<AttackRunRow>('SELECT * FROM attack_runs WHERE id = $1', [runId]);
  return rows[0] ?? null;
}

export async function getEvents(runId: string): Promise<AttackRunEventRow[]> {
  const { rows } = await query<AttackRunEventRow>(
    'SELECT * FROM attack_run_events WHERE run_id = $1 ORDER BY seq ASC',
    [runId]
  );
  return rows;
}

export async function listRuns(limit = 30): Promise<AttackRunRow[]> {
  const { rows } = await query<AttackRunRow>(
    'SELECT * FROM attack_runs ORDER BY started_at DESC LIMIT $1',
    [limit]
  );
  return rows;
}
