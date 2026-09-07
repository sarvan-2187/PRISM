import { Badge } from '@/components/ui/badge';
import { OUTCOME_INFO, RUN_STATUS_LABEL } from '@/lib/attackEvents';
import type { RunOutcome, RunStatus } from '@/lib/attackApi';

export function OutcomeBadge({ status, outcome }: { status: RunStatus; outcome: RunOutcome | null }) {
  if (status === 'RUNNING') return <Badge variant="info">Running…</Badge>;
  if (status === 'ERROR') return <Badge variant="destructive">{RUN_STATUS_LABEL.ERROR}</Badge>;
  if (!outcome) return <Badge>Complete</Badge>;
  const info = OUTCOME_INFO[outcome];
  return <Badge variant={info.variant}>{info.label}</Badge>;
}
