import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowDown, ArrowUp, Play, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Catalog, EditorAction, IssueMap, WorkflowEntity } from "../catalog";
import { actionOf, actionsForEntity, hasIssueUnder, paths, uid } from "../catalog";
import { ConfigFields, schemaDefaults } from "./ConfigFields";
import { userFacing } from "../format";
import { NONE } from "../fields/EntitySelect";

export function ActionsSection({
  catalog,
  entity,
  actions,
  onChange,
  errors,
  disabled,
  announce,
}: {
  catalog: Catalog;
  entity: WorkflowEntity | undefined;
  actions: EditorAction[];
  onChange: (next: EditorAction[]) => void;
  errors: IssueMap;
  disabled?: boolean;
  announce?: (message: string) => void;
}) {
  const compatible = actionsForEntity(catalog, entity);
  const max = catalog.limits.maxActions;
  const sectionError = errors["actions"];
  const sectionIssue = sectionError != null || hasIssueUnder(errors, "actions");

  const add = (type: string) => {
    const def = actionOf(catalog, type);
    if (!def) return;
    onChange([...actions, { id: uid(), type, config: schemaDefaults(def.configSchema) }]);
    announce?.(`${def.label} added as action ${actions.length + 1}`);
  };
  const remove = (i: number) => {
    onChange(actions.filter((_, idx) => idx !== i));
    announce?.(`Action ${i + 1} removed`);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= actions.length) return;
    const next = actions.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    announce?.(`Action moved to position ${j + 1} of ${actions.length}`);
  };
  const updateConfig = (i: number, config: Record<string, unknown>) => onChange(actions.map((a, idx) => (idx === i ? { ...a, config } : a)));

  return (
    <Card className={cn("rounded-xl border-border shadow-sm", sectionIssue && "border-destructive/50")} data-testid="section-actions">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-success-soft text-success" aria-hidden="true">
            <Play className="h-4 w-4" />
          </span>
          <CardTitle className="text-lg font-semibold">3. Actions</CardTitle>
        </div>
        <CardDescription>Run in the order shown, one after another. At least one action is required to publish.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {actions.length === 0 && (
          <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground" data-testid="actions-empty">
            No actions yet. Add the first action below.
          </p>
        )}
        <ol className="space-y-4" aria-label="Actions in execution order">
          {actions.map((a, i) => {
            const def = actionOf(catalog, a.type);
            const rowIssue = hasIssueUnder(errors, paths.action(i));
            const typeError = errors[`${paths.action(i)}.type`];
            return (
              <li key={a.id} className={cn("rounded-lg border border-border bg-muted/20", rowIssue && "border-destructive/50")} data-testid={`action-row-${i}`}>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums" aria-hidden="true">
                      {i + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold" data-testid={`action-title-${i}`}>
                        <span className="sr-only">Action {i + 1}: </span>
                        {def?.label ?? a.type}
                      </p>
                      {def && <p className="truncate text-xs text-muted-foreground">{userFacing(def.description)}</p>}
                    </div>
                  </div>
                  {!disabled && (
                    <div className="flex items-center gap-1" role="group" aria-label={`Reorder or remove action ${i + 1}`}>
                      <Button type="button" variant="ghost" size="icon" aria-label={`Move action ${i + 1} up`} data-testid={`action-move-up-${i}`} disabled={i === 0} onClick={() => move(i, -1)}>
                        <ArrowUp className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" aria-label={`Move action ${i + 1} down`} data-testid={`action-move-down-${i}`} disabled={i === actions.length - 1} onClick={() => move(i, 1)}>
                        <ArrowDown className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" aria-label={`Remove action ${i + 1}`} data-testid={`action-remove-${i}`} onClick={() => remove(i)}>
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </div>
                <div className="p-3">
                  {typeError && (
                    <p role="alert" data-testid={`field-error-${paths.action(i)}.type`} className="mb-3 text-xs text-destructive">
                      {typeError}
                    </p>
                  )}
                  {def ? (
                    <ConfigFields schema={def.configSchema} value={a.config} onChange={(cfg) => updateConfig(i, cfg)} path={`${paths.action(i)}.config`} entity={entity} errors={errors} disabled={disabled} catalog={catalog} idPrefix={`act${i}`} />
                  ) : (
                    <p className="text-sm text-destructive">Unknown action type "{a.type}" — remove it.</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {sectionError && (
          <p role="alert" data-testid="field-error-actions" className="text-xs text-destructive">
            {sectionError}
          </p>
        )}
        {!disabled && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select value={NONE} onValueChange={(t) => t !== NONE && add(t)} disabled={!entity || actions.length >= max}>
              <SelectTrigger data-testid="action-add" aria-label="Add action" className="w-full sm:w-80">
                <SelectValue placeholder={actions.length >= max ? `Maximum of ${max} actions reached` : "Add an action…"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Add an action…</SelectItem>
                {compatible.map((c) => (
                  <SelectItem key={c.type} value={c.type}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Only actions that apply to {entity === "contact" ? "contacts" : entity === "lead" ? "leads" : "the trigger's record"} are offered.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
