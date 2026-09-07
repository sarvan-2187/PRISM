/**
 * Plain-English labels/tones for the Attack Simulation Dashboard, in the same
 * spirit as lib/events.ts — kept separate so extending the attack vocabulary
 * never touches the payment-flow event map.
 */
import type { BadgeVariant } from './events';
import type { EventActor, PrismLayer, RunOutcome, RunStatus } from './attackApi';

export const OUTCOME_INFO: Record<RunOutcome, { label: string; variant: BadgeVariant; description: string }> = {
  SIMULATED: {
    label: 'Simulated',
    variant: 'default',
    description: 'The run executed real requests but did not reach a decisive block/succeed result — see the summary.',
  },
  DETECTED: {
    label: 'Detected',
    variant: 'info',
    description: 'PRISM recognized the attack pattern (an audit event fired) even though the request was not necessarily blocked.',
  },
  BLOCKED: {
    label: 'Blocked',
    variant: 'success',
    description: 'A real PRISM check rejected the attack, confirmed by the actual API response and audit trail.',
  },
  PARTIALLY_MITIGATED: {
    label: 'Partially mitigated',
    variant: 'warning',
    description: 'Some but not all parts of a multi-step attack were blocked.',
  },
  SUCCEEDED: {
    label: 'Attack succeeded',
    variant: 'destructive',
    description: 'The attack achieved its goal — this is a real finding, not a display error.',
  },
  PROTECTION_UNAVAILABLE: {
    label: 'Protection unavailable',
    variant: 'destructive',
    description: 'The relevant control was disabled (e.g. PRISM_DISABLE) or otherwise not active for this run.',
  },
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  RUNNING: 'Running',
  COMPLETE: 'Complete',
  ERROR: 'Error',
};

export const ACTOR_LABEL: Record<EventActor, string> = {
  ATTACKER: 'Attacker device',
  LEGITIMATE: 'Legitimate device',
  PRISM: 'PRISM',
  SYSTEM: 'System',
};

export const ACTOR_TONE_CLASS: Record<EventActor, string> = {
  ATTACKER: 'text-destructive',
  LEGITIMATE: 'text-success',
  PRISM: 'text-primary',
  SYSTEM: 'text-muted-foreground',
};

export const LAYER_LABEL: Record<PrismLayer, string> = {
  IDENTITY: 'Identity (PERSON)',
  INTENT: 'Intent Lock',
  CONTEXT: 'Context / Fingerprint',
  RISK: 'Risk Engine',
  SEMANTIC: 'Semantic Step-Up',
  AUTHORIZATION: 'Authorization',
  LEDGER: 'Ledger / Settlement',
  NETWORK: 'Network Microfingerprint',
  NONE: 'No PRISM layer',
};
