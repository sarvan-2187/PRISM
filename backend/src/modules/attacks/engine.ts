/**
 * Attack engine — the orchestrator behind "Launch Attack".
 *
 * Runs are executed asynchronously: launchScenario() returns a runId
 * immediately (the row already exists in Postgres, status RUNNING), and the
 * scenario keeps running in the background, writing real events as real
 * things happen. The dashboard polls GET /api/v1/attacks/runs/:id and sees
 * genuine progress — there is no separate "replay" of a scripted timeline.
 *
 * Every scenario is asked to attack a LiveTarget (types.ts): when the
 * operator selected a real, currently-live transaction from
 * GET /api/v1/attacks/live-transactions, that transaction is what gets
 * attacked — the primary, "real attacker vs. real live transaction" path.
 * When no live transaction was selected, a scenario falls back to creating
 * its own transaction against the chosen target user (today's self-contained
 * mode), and every such run's summary says so explicitly.
 */
import { ScenarioId, getScenario } from './catalog';
import { tamperIntent } from './attackers/tamperIntent';
import { replaySettled } from './attackers/replaySettled';
import { idorCrossUser } from './attackers/idorCrossUser';
import { forgedWebauthnAssertion } from './attackers/forgedWebauthnAssertion';
import { sessionJwtTamper } from './attackers/sessionJwtTamper';
import { stepUpBruteforce } from './attackers/stepUpBruteforce';
import { runLegitPayment } from './legitPayment';
import { getUser, getKnownPayee, getNeverPaidPayee, getTransaction } from './demoData';
import { audit } from '../audit/logger';
import {
  appendEvent,
  createRun,
  errorRun,
  finishRun,
  setRunTarget,
} from './runStore';
import { AttackContext, AttackFn, LiveTarget } from './types';

const ATTACKERS: Record<ScenarioId, AttackFn> = {
  TRANSACTION_TAMPERING: tamperIntent,
  REPLAY_SETTLED_TRANSACTION: replaySettled,
  IDOR_CROSS_USER: idorCrossUser,
  FORGED_WEBAUTHN_ASSERTION: forgedWebauthnAssertion,
  SESSION_JWT_TAMPER: sessionJwtTamper,
  STEPUP_BRUTEFORCE: stepUpBruteforce,
};

function makeContext(runId: string, attackerLabel: string): AttackContext {
  return {
    runId,
    attackerLabel,
    log: async (actor, layer, message, detail) => {
      await appendEvent(runId, actor, layer, message, detail);
    },
  };
}

/** Folds the target transaction's REAL audit_logs timeline into the run's event stream. */
async function attachRealAuditTrail(ctx: AttackContext, transactionId: string | undefined): Promise<void> {
  if (!transactionId) return;
  const trail = await audit.trail(transactionId);
  for (const row of trail) {
    await ctx.log('PRISM', mapAuditEventToLayer(row.event_type), `[audit_logs] ${row.event_type}`, row.event_data);
  }
}

function mapAuditEventToLayer(eventType: string) {
  if (eventType.startsWith('PASSKEY') || eventType.startsWith('LOGIN') || eventType.includes('ASSERTION') || eventType.includes('CHALLENGE') || eventType.includes('CREDENTIAL')) return 'IDENTITY' as const;
  if (eventType.startsWith('INTENT')) return 'INTENT' as const;
  if (eventType.startsWith('CONTEXT')) return 'CONTEXT' as const;
  if (eventType.startsWith('RISK')) return 'RISK' as const;
  if (eventType.startsWith('STEP_UP')) return 'SEMANTIC' as const;
  if (eventType.startsWith('PAYMENT')) return 'AUTHORIZATION' as const;
  return 'NONE' as const;
}

export interface LaunchOptions {
  /** A real, currently-live transaction selected from the discovery feed. */
  transactionId?: string;
  /** Self-contained fallback: attack a user without a pre-existing live transaction. */
  targetUserId?: string;
  /** A real captured "prism_session=..." cookie for the transaction's payer. */
  victimSessionCookie?: string;
  /** A real captured session for a separate attacker-controlled account (IDOR). */
  attackerSessionCookie?: string;
}

async function resolveLiveTarget(opts: LaunchOptions): Promise<LiveTarget> {
  if (opts.transactionId) {
    const tx = await getTransaction(opts.transactionId);
    const payer = await getUser(tx.payer_user_id);
    return {
      transactionId: tx.id,
      payerUserId: payer.id,
      payerEmail: payer.email,
      victimSessionCookie: opts.victimSessionCookie,
      attackerSessionCookie: opts.attackerSessionCookie,
    };
  }
  if (opts.targetUserId) {
    const payer = await getUser(opts.targetUserId);
    return {
      payerUserId: payer.id,
      payerEmail: payer.email,
      victimSessionCookie: opts.victimSessionCookie,
      attackerSessionCookie: opts.attackerSessionCookie,
    };
  }
  throw new Error('Either a live transaction or a target user must be provided.');
}

export async function launchScenario(
  scenarioId: string,
  opts: LaunchOptions,
  attackerLabel: string
): Promise<string> {
  const scenario = getScenario(scenarioId);
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  const attacker = ATTACKERS[scenario.id];

  const target = await resolveLiveTarget(opts);
  const run = await createRun({ scenarioId: scenario.id, attackerLabel, targetUserId: target.payerUserId });
  if (target.transactionId) await setRunTarget(run.id, target.transactionId);
  const ctx = makeContext(run.id, attackerLabel);

  // Fire and forget — the HTTP handler already returned the runId.
  void (async () => {
    try {
      await ctx.log(
        'SYSTEM',
        null,
        target.transactionId
          ? `Attack run started: ${scenario.name} — targeting live transaction ${target.transactionId}`
          : `Attack run started: ${scenario.name} — no live transaction selected; this run creates its own (not a live-transaction demonstration)`,
        { scenarioId: scenario.id, attackerLabel }
      );

      const result = await attacker(ctx, target);

      if (result.targetTransactionId) {
        await setRunTarget(run.id, result.targetTransactionId);
        await attachRealAuditTrail(ctx, result.targetTransactionId);
      }

      await ctx.log('SYSTEM', null, `Run finished: ${result.outcome}`, {});
      await finishRun(run.id, result.outcome, result.summary);
    } catch (err) {
      const message = (err as Error).message;
      await ctx.log('SYSTEM', null, `Run errored: ${message}`, {});
      await errorRun(run.id, message);
    }
  })();

  return run.id;
}

/** The "run a legitimate transaction" control feature — not an attack, uses the same run/event model. */
export async function launchLegitPayment(
  targetUserId: string,
  attackerLabel: string,
  opts: { amountMinor?: number; useNeverPaidPayee?: boolean } = {}
): Promise<string> {
  const run = await createRun({ scenarioId: 'LEGIT_PAYMENT', attackerLabel, targetUserId });
  const ctx = makeContext(run.id, attackerLabel);

  void (async () => {
    try {
      const targetUser = await getUser(targetUserId);
      const payee = opts.useNeverPaidPayee
        ? await getNeverPaidPayee(targetUser.id)
        : (await getKnownPayee(targetUser.id)) ?? (await getNeverPaidPayee(targetUser.id));
      if (!payee) throw new Error('No payee available for this user.');

      await ctx.log('SYSTEM', null, 'Legitimate transaction started', {});
      const { txId, authorize } = await runLegitPayment(ctx, {
        userId: targetUser.id,
        email: targetUser.email,
        payeeAccountId: payee.id,
        amountMinor: opts.amountMinor ?? 25_000,
        deliberationMs: 4000,
      });

      await setRunTarget(run.id, txId);
      await attachRealAuditTrail(ctx, txId);

      const outcome: 'SUCCEEDED' | 'SIMULATED' | 'BLOCKED' =
        authorize.body?.decision === 'APPROVED' ? 'SUCCEEDED' : authorize.body?.decision === 'STEP_UP' ? 'SIMULATED' : 'BLOCKED';
      const summary =
        authorize.body?.decision === 'APPROVED'
          ? `Payment settled normally. Balance now ${authorize.body.balanceFormatted}.`
          : authorize.body?.decision === 'STEP_UP'
            ? 'Payment requires the semantic step-up challenge before it can settle.'
            : `Payment did not settle (${authorize.body?.failureCode ?? 'unknown'}).`;

      await ctx.log('SYSTEM', null, `Run finished: ${outcome}`, {});
      await finishRun(run.id, outcome, summary);
    } catch (err) {
      const message = (err as Error).message;
      await ctx.log('SYSTEM', null, `Run errored: ${message}`, {});
      await errorRun(run.id, message);
    }
  })();

  return run.id;
}
