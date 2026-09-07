import { EventActor, PrismLayer, RunOutcome } from './runStore';

/**
 * What an attacker function is asked to attack. `transactionId` is set when
 * the operator selected a real, currently-live transaction from
 * GET /api/v1/attacks/live-transactions — the primary path. When absent, the
 * attacker falls back to creating its own transaction against `payerUserId`,
 * which keeps single-machine testing working with zero setup but is NOT a
 * "live" demonstration and is labeled as such in the UI and in run summaries.
 *
 * `victimSessionCookie` / `attackerSessionCookie` are real session cookies
 * (`prism_session=...`) an operator captured and pasted in — see
 * demoSessionReveal.ts for how a device can produce one for itself. When a
 * cookie a scenario needs is not supplied, the attacker establishes its own
 * session for the relevant account instead (today's behavior) and says so in
 * its narration, so a run is never presented as a stolen-cookie attack when
 * it was not one.
 */
export interface LiveTarget {
  transactionId?: string;
  payerUserId: string;
  payerEmail: string;
  victimSessionCookie?: string;
  attackerSessionCookie?: string;
}

export interface AttackContext {
  runId: string;
  attackerLabel: string;
  log(actor: EventActor, layer: PrismLayer | null, message: string, detail?: Record<string, unknown>): Promise<void>;
}

export interface AttackResult {
  outcome: RunOutcome;
  summary: string;
  targetTransactionId?: string;
}

export type AttackFn = (ctx: AttackContext, target: LiveTarget) => Promise<AttackResult>;
