import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Catalog, IssueMap } from "../catalog";
import { fieldOf, hasIssueUnder, paths, triggerOf } from "../catalog";
import { entityLabel } from "../format";
import { ConfigFields } from "./ConfigFields";
import { TRIGGER_CONFIG_HINTS } from "./labels";

export function TriggerSection({
  catalog,
  triggerType,
  config,
  onTypeChange,
  onConfigChange,
  errors,
  disabled,
}: {
  catalog: Catalog;
  triggerType: string;
  config: Record<string, unknown>;
  onTypeChange: (type: string) => void;
  onConfigChange: (config: Record<string, unknown>) => void;
  errors: IssueMap;
  disabled?: boolean;
}) {
  const trigger = triggerOf(catalog, triggerType);
  const typeError = errors["trigger.type"] ?? errors["trigger"];
  const sectionIssue = hasIssueUnder(errors, "trigger");
  return (
    <Card className={cn("rounded-xl border-border shadow-sm", sectionIssue && "border-destructive/50")} data-testid="section-trigger">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-soft text-primary" aria-hidden="true">
            <Zap className="h-4 w-4" />
          </span>
          <CardTitle className="text-lg font-semibold">1. Trigger</CardTitle>
        </div>
        <CardDescription>The CRM event that starts this automation.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="automation-trigger-type" className="text-xs font-medium">
            When this happens
            <span className="text-destructive" aria-hidden="true">
              {" "}
              *
            </span>
          </Label>
          <Select value={triggerType || undefined} onValueChange={onTypeChange} disabled={disabled}>
            <SelectTrigger id="automation-trigger-type" data-testid="trigger-type" aria-invalid={!!typeError || undefined} className={cn("w-full sm:max-w-md", typeError && "border-destructive")}>
              <SelectValue placeholder="Choose a trigger…" />
            </SelectTrigger>
            <SelectContent>
              {catalog.triggers.map((t) => (
                <SelectItem key={t.type} value={t.type}>
                  <span className="me-2 text-xs uppercase tracking-wide text-muted-foreground">{entityLabel(t.entity)}</span>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {trigger && <p className="text-xs text-muted-foreground">{trigger.description}</p>}
          {typeError && (
            <p role="alert" data-testid="field-error-trigger.type" className="text-xs text-destructive">
              {typeError}
            </p>
          )}
        </div>
        {trigger && (
          <ConfigFields
            schema={trigger.configSchema}
            value={config}
            onChange={onConfigChange}
            path="trigger.config"
            entity={trigger.entity}
            errors={errors}
            disabled={disabled}
            catalog={catalog}
            idPrefix="trg"
            hints={TRIGGER_CONFIG_HINTS}
            memberLabel={(_key, member) => fieldOf(catalog, trigger.entity, member)?.label ?? member}
          />
        )}
        {trigger && Object.keys(trigger.configSchema.properties ?? {}).length === 0 && (
          <p className="text-xs text-muted-foreground">This trigger fires on every {entityLabel(trigger.entity).toLowerCase()} event of this kind.</p>
        )}
      </CardContent>
    </Card>
  );
}
