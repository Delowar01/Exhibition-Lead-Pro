import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Filter, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Catalog, CatalogField, CatalogOperator, EditorCondition, IssueMap, WorkflowEntity } from "../catalog";
import { fieldOf, hasIssueUnder, operatorOf, paths, uid } from "../catalog";
import { entityKindForKey, optionsForKind, useEntityOptions, ENTITY_KIND_LABEL } from "../entity-options";
import { EntitySelect, MultiEntityPicker, NONE } from "../fields/EntitySelect";
import { ContactPicker } from "../fields/ContactPicker";
import { TokenInput } from "../fields/TokenInput";
import { FieldShell } from "./FieldShell";
import { enumValueLabel } from "./labels";

export function ConditionsSection({
  catalog,
  entity,
  conditions,
  onChange,
  errors,
  disabled,
}: {
  catalog: Catalog;
  entity: WorkflowEntity | undefined;
  conditions: EditorCondition[];
  onChange: (next: EditorCondition[]) => void;
  errors: IssueMap;
  disabled?: boolean;
}) {
  const fields = entity ? catalog.conditionFields[entity] ?? [] : [];
  const max = catalog.limits.maxConditions;
  const sectionIssue = hasIssueUnder(errors, "conditions");

  const update = (i: number, patch: Partial<EditorCondition>) => onChange(conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const remove = (i: number) => onChange(conditions.filter((_, idx) => idx !== i));
  const add = () => {
    const first = fields[0];
    const op = first ? first.operators[0] : "";
    onChange([...conditions, { id: uid(), field: first?.key ?? "", operator: op, value: undefined }]);
  };

  return (
    <Card className={cn("rounded-xl border-border shadow-sm", sectionIssue && "border-destructive/50")} data-testid="section-conditions">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-info-soft text-info" aria-hidden="true">
              <Filter className="h-4 w-4" />
            </span>
            <CardTitle className="text-lg font-semibold">2. Conditions</CardTitle>
            <span className="text-xs text-muted-foreground">optional</span>
          </div>
          {!disabled && (
            <Button type="button" variant="outline" size="sm" onClick={add} disabled={!entity || conditions.length >= max} data-testid="condition-add">
              <Plus className="me-1 h-4 w-4" aria-hidden="true" /> Add condition
            </Button>
          )}
        </div>
        <CardDescription>All conditions must match (AND) for the actions to run. They are evaluated against the {entity ? entity : "record"} after the change.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {conditions.length === 0 && (
          <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground" data-testid="conditions-empty">
            No conditions — the automation runs for every matching event.
          </p>
        )}
        <ol className="space-y-3">
          {conditions.map((c, i) => {
            const field = fieldOf(catalog, entity ?? "lead", c.field);
            const ops = (field?.operators ?? []).map((o) => operatorOf(catalog, o)).filter((o): o is CatalogOperator => !!o);
            const op = operatorOf(catalog, c.operator);
            const rowIssue = hasIssueUnder(errors, paths.condition(i));
            return (
              <li key={c.id} className={cn("rounded-lg border border-border bg-muted/20 p-3", rowIssue && "border-destructive/50")} data-testid={`condition-row-${i}`}>
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] md:items-start">
                  <FieldShell id={`cond-${c.id}-field`} path={paths.condition(i, "field")} label={`Field ${i + 1}`} error={errors[paths.condition(i, "field")]}>
                    <Select
                      value={c.field || undefined}
                      disabled={disabled}
                      onValueChange={(key) => {
                        const f = fieldOf(catalog, entity ?? "lead", key);
                        const nextOp = f && f.operators.includes(c.operator) ? c.operator : f?.operators[0] ?? "";
                        update(i, { field: key, operator: nextOp, value: undefined });
                      }}
                    >
                      <SelectTrigger id={`cond-${c.id}-field`} data-testid={`condition-field-${i}`} className="w-full">
                        <SelectValue placeholder="Field…" />
                      </SelectTrigger>
                      <SelectContent>
                        {fields.map((f) => (
                          <SelectItem key={f.key} value={f.key}>
                            {f.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FieldShell>
                  <FieldShell id={`cond-${c.id}-op`} path={paths.condition(i, "operator")} label="Operator" error={errors[paths.condition(i, "operator")]}>
                    <Select
                      value={c.operator || undefined}
                      disabled={disabled || !field}
                      onValueChange={(o) => {
                        const nextShape = operatorOf(catalog, o)?.valueShape;
                        const keep = nextShape === op?.valueShape && nextShape !== "none";
                        update(i, { operator: o, value: keep ? c.value : undefined });
                      }}
                    >
                      <SelectTrigger id={`cond-${c.id}-op`} data-testid={`condition-operator-${i}`} className="w-full">
                        <SelectValue placeholder="Operator…" />
                      </SelectTrigger>
                      <SelectContent>
                        {ops.map((o) => (
                          <SelectItem key={o.operator} value={o.operator}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FieldShell>
                  <div className="min-w-0">
                    {field && op && op.valueShape !== "none" ? (
                      <ConditionValue key={`${c.id}-${c.field}-${c.operator}`} index={i} condition={c} field={field} operator={op} onChange={(v) => update(i, { value: v })} errors={errors} disabled={disabled} />
                    ) : (
                      <FieldShell id={`cond-${c.id}-value`} path={paths.condition(i, "value")} label="Value" error={errors[paths.condition(i, "value")]}>
                        <div className="flex h-10 items-center text-sm text-muted-foreground">{op?.valueShape === "none" ? "No value needed" : "—"}</div>
                      </FieldShell>
                    )}
                  </div>
                  {!disabled && (
                    <div className="md:pt-6">
                      <Button type="button" variant="ghost" size="icon" aria-label={`Remove condition ${i + 1}`} data-testid={`condition-remove-${i}`} onClick={() => remove(i)}>
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {conditions.length >= max && <p className="text-xs text-muted-foreground">Maximum of {max} conditions reached.</p>}
      </CardContent>
    </Card>
  );
}

function ConditionValue({
  index,
  condition,
  field,
  operator,
  onChange,
  errors,
  disabled,
}: {
  index: number;
  condition: EditorCondition;
  field: CatalogField;
  operator: CatalogOperator;
  onChange: (value: unknown) => void;
  errors: IssueMap;
  disabled?: boolean;
}) {
  const opts = useEntityOptions();
  const path = paths.condition(index, "value");
  const id = `cond-${condition.id}-value`;
  const error = errors[path] ?? (hasIssueUnder(errors, path) ? Object.entries(errors).find(([k]) => k.startsWith(path + "["))?.[1] : undefined);
  const testId = `condition-value-${index}`;
  const kind = entityKindForKey(field.key);
  const value = condition.value;

  if (operator.valueShape === "list") {
    const list = Array.isArray(value) ? (value as Array<string | number>) : [];
    if (field.type === "enum" && field.enumValues) {
      const chosen = list.map(String);
      return (
        <FieldShell id={id} path={path} label="Values" error={error}>
          <div id={id} role="group" aria-label="Values" className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-2">
            {field.enumValues.map((v) => {
              const cid = `${id}-${v}`;
              const checked = chosen.includes(v);
              return (
                <label key={v} htmlFor={cid} className="flex items-center gap-2 text-sm">
                  <Checkbox id={cid} checked={checked} disabled={disabled} onCheckedChange={(c) => onChange(c ? [...chosen, v] : chosen.filter((x) => x !== v))} />
                  <span>{enumValueLabel(v)}</span>
                </label>
              );
            })}
          </div>
        </FieldShell>
      );
    }
    if (kind && kind !== "contact") {
      return (
        <FieldShell id={id} path={path} label="Values" error={error}>
          <MultiEntityPicker id={id} values={list} onChange={(next) => onChange(next.map((v) => Number(v)))} options={optionsForKind(opts, kind)} placeholder={`Add ${ENTITY_KIND_LABEL[kind]}…`} disabled={disabled} loading={opts.loading} invalid={!!error} testId={testId} ariaLabel="Values" />
        </FieldShell>
      );
    }
    return (
      <FieldShell id={id} path={path} label="Values" error={error}>
        <TokenInput id={id} values={list} onChange={onChange} numeric={field.type === "number" || kind === "contact"} disabled={disabled} invalid={!!error} testId={testId} ariaLabel="Values" />
      </FieldShell>
    );
  }

  // single value
  if (field.type === "enum" && field.enumValues) {
    return (
      <FieldShell id={id} path={path} label="Value" error={error}>
        <Select value={value == null || value === "" ? NONE : String(value)} disabled={disabled} onValueChange={(v) => onChange(v === NONE ? undefined : v)}>
          <SelectTrigger id={id} data-testid={testId} aria-invalid={!!error || undefined} className={cn("w-full", error && "border-destructive")}>
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Select…</SelectItem>
            {field.enumValues.map((v) => (
              <SelectItem key={v} value={v}>
                {enumValueLabel(v)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldShell>
    );
  }
  if (field.type === "boolean") {
    return (
      <FieldShell id={id} path={path} label="Value" error={error}>
        <Select value={value === true ? "true" : value === false ? "false" : NONE} disabled={disabled} onValueChange={(v) => onChange(v === NONE ? undefined : v === "true")}>
          <SelectTrigger id={id} data-testid={testId} className="w-full">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Select…</SelectItem>
            <SelectItem value="true">Yes</SelectItem>
            <SelectItem value="false">No</SelectItem>
          </SelectContent>
        </Select>
      </FieldShell>
    );
  }
  if (kind === "contact") {
    return (
      <FieldShell id={id} path={path} label="Value" error={error}>
        <ContactPicker id={id} value={typeof value === "number" ? value : null} onChange={(n) => onChange(n ?? undefined)} disabled={disabled} invalid={!!error} testId={testId} />
      </FieldShell>
    );
  }
  if (kind) {
    const numeric = kind !== "stage";
    return (
      <FieldShell id={id} path={path} label="Value" error={error}>
        <EntitySelect id={id} value={value as string | number | null | undefined} onChange={(v) => onChange(v == null ? undefined : numeric ? Number(v) : v)} options={optionsForKind(opts, kind)} placeholder={`Select ${ENTITY_KIND_LABEL[kind]}…`} disabled={disabled} loading={opts.loading} invalid={!!error} testId={testId} ariaLabel="Value" />
      </FieldShell>
    );
  }
  if (field.type === "number") {
    return (
      <FieldShell id={id} path={path} label="Value" error={error}>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          step="any"
          value={value == null || value === "" ? "" : String(value)}
          disabled={disabled}
          aria-invalid={!!error || undefined}
          data-testid={testId}
          className={cn(error && "border-destructive")}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") onChange(undefined);
            else {
              const n = Number(raw);
              onChange(Number.isNaN(n) ? raw : n);
            }
          }}
        />
      </FieldShell>
    );
  }
  return (
    <FieldShell id={id} path={path} label="Value" error={error} hint={field.type === "list" ? "A tag label on the record's tag list." : undefined}>
      <Input id={id} type="text" value={typeof value === "string" ? value : value == null ? "" : String(value)} disabled={disabled} aria-invalid={!!error || undefined} data-testid={testId} className={cn(error && "border-destructive")} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />
    </FieldShell>
  );
}
