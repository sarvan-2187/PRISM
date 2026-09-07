import { Link } from 'react-router-dom';
import { ShieldAlert, ShieldCheck, Shield } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ScenarioDefinition } from '@/lib/attackApi';

const SEVERITY_ICON = { HIGH: ShieldAlert, MEDIUM: Shield, LOW: ShieldCheck } as const;
const SEVERITY_VARIANT = { HIGH: 'destructive', MEDIUM: 'warning', LOW: 'default' } as const;

export function AttackCard({ scenario, href }: { scenario: ScenarioDefinition; href?: string }) {
  const Icon = SEVERITY_ICON[scenario.severity];
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <Badge variant="outline">{scenario.category}</Badge>
          <Badge variant={SEVERITY_VARIANT[scenario.severity]} dot={false}>
            <Icon className="size-3" aria-hidden="true" />
            {scenario.severity}
          </Badge>
        </div>
        <CardTitle className="text-body-lg">{scenario.name}</CardTitle>
        <CardDescription>{scenario.whatItIs}</CardDescription>
      </CardHeader>
      <CardContent className="mt-auto grid gap-3">
        <div className="text-caption text-secondary-foreground">
          <span className="font-medium text-foreground">Expected layer: </span>
          {scenario.expectedDetectionLayer}
        </div>
        <Button asChild block>
          <Link to={href ?? `/attacks/${scenario.id}`}>Select attack</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
