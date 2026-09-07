import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Catalog, IssueMap, JsonSchema, WorkflowEntity } from "../catalog";
import { hasIssueUnder } from "../catalog";
import { entityKindForKey, optionsForKind, useEntityOptions, ENTITY_KIND_LABEL } from "../entity-options";
import { EntitySelect, NONE } from "../fields/EntitySelect";
import { ContactPicker } from "../fields/ContactPicker";
import { FieldShell, fieldId } from "./FieldShell";
import { configKeyLabel, enumValueLabel } from "./labels";

// =============================================================================
// Schema-driven configuration editor. Every trigger/action config is rendered
// from the JSON Schema published by GET /workflows/catalog; the only knowledge
// added here is WHICH control fits a key (a selector for tenant references, a
// recipient picker for assignee/recipient/to, a field-set editor for nested
// `fields` objects). No raw JSON editing anywhere.
// =============================================================================

const RECIPIENT_KEYS = new Set(["assignee", "recipient", "to"]);
const DATE_RE = "^\\d{4}-\\d{2}-\\d{2}$";
const TIME_RE = "^([01]\\d|2[0-3]):[0-5]\\d$";

export interface ConfigFieldsProps {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  path: string;
  entity: WorkflowEntity | undefined;
  errors: IssueMap;
  disabled?: boolean;
  catalog: Catalog;
  idPrefix: string;
  hints?: Record<string, string>;
  /** Labels for enum members of array fields (e.g. trigger `fields` → condition field labels). */
  memberLabel?: (key: string, value: string) => string;
}

function schemaType(schema: JsonSchema): string | undefined {
  return Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
}

function isNumeric(schema: JsonSchema): boolean {
  const t = schemaType(schema);
  return t === "number" || t === "integer";
}

function numberBounds(schema: JsonSchema): { min?: number; max?: number; step?: number } {
  const min = schema.minimum ?? (schema.exclusiveMinimum != null ? schema.exclusiveMinimum + 1 : undefined);
  const max = schema.maximum != null && schema.maximum < 1e15 ? schema.maximum : undefined;
  return { min, max, step: schemaType(schema) === "integer" ? 1 : undefined };
}

function rangeHint(schema: JsonSchema): string | undefined {
  const { min, max } = numberBounds(schema);
  if (min != null && max != null) return `${min}–${max}`;
  if (min != null) return `Minimum ${min}`;
  if (max != null) return `Maximum ${max}`;
  return undefined;
}

/** Is a config key visible given the current sibling values (conditional fields)? */
export function isConfigKeyVisible(key: string, schema: JsonSchema, value: Record<string, unknown>): boolean {
  if (key === "assignedToId" && schema.properties?.strategy) {
    const strategy = value.strategy ?? schema.properties.strategy.default ?? "manual";
    return strategy === "manual";
  }
  return true;
}

/**
 * Defaults declared by the schema (e.g. strategy: manual, type: custom). A
 * required nested object (assignee / recipient / to) is seeded too, and its
 * required enum keys without a declared default take the first enum member —
 * for recipients that is "the record's owner", the safest choice.
 */
export function schemaDefaults(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const required = new Set(schema.required ?? []);
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    if (s.default !== undefined) {
      out[k] = s.default;
      continue;
    }
    if (required.has(k)) {
      if (schemaType(s) === "object" && s.properties) {
        out[k] = schemaDefaults(s);
      } else if (s.enum && s.enum.length > 0 && schemaType(s) === "string") {
        out[k] = s.enum[0];
      }
    }
  }
  return out;
}

export function ConfigFields(props: ConfigFieldsProps) {
  const { schema, value, onChange, path, entity, errors, disabled, catalog, idPrefix, hints, memberLabel } = props;
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0) {
    return <p className="text-sm text-muted-foreground">No configuration needed.</p>;
  }
  const required = new Set(schema.required ?? []);

  const setKey = (key: string, next: unknown) => {
    const draft: Record<string, unknown> = { ...value };
    if (next === undefined) delete draft[key];
    else draft[key] = next;
    // Conditional cleanup: a rule-based assignment strategy never carries a user.
    if (key === "strategy" && next !== "manual") delete draft.assignedToId;
    onChange(draft);
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {properties.map(([key, sub]) => {
        if (!isConfigKeyVisible(key, schema, value)) return null;
        const wide = sub.properties != null || schemaType(sub) === "array" || (sub.maxLength != null && sub.maxLength >= 500);
        return (
          <div key={key} className={cn("min-w-0", wide && "sm:col-span-2")}>
            <SchemaField
              name={key}
              schema={sub}
              required={required.has(key)}
              value={value[key]}
              onChange={(next) => setKey(key, next)}
              path={`${path}.${key}`}
              entity={entity}
              errors={errors}
              disabled={disabled}
              catalog={catalog}
              idPrefix={idPrefix}
              hint={hints?.[key]}
              memberLabel={memberLabel}
            />
          </div>
        );
      })}
    </div>
  );
}

interface SchemaFieldProps {
  name: string;
  schema: JsonSchema;
  required?: boolean;
  value: unknown;
  onChange: (next: unknown) => void;
  path: string;
  entity: WorkflowEntity | undefined;
  errors: IssueMap;
  disabled?: boolean;
  catalog: Catalog;
  idPrefix: string;
  hint?: string;
  memberLabel?: (key: string, value: string) => string;
}

export function SchemaField(props: SchemaFieldProps) {
  const { name, schema, required, value, onChange, path, errors, disabled, catalog, idPrefix, hint } = props;
  const id = fieldId(idPrefix, path);
  const error = errors[path];
  const describedBy = error ? `${id}-error` : undefined;
  const label = configKeyLabel(name);
  const opts = useEntityOptions();
  const kind = entityKindForKey(name);

  // ── tenant references → selectors (never raw ids) ───────────────────────
  if (kind === "contact") {
    return (
      <FieldShell id={id} path={path} label={label} required={required} hint={hint} error={error}>
        <ContactPicker id={id} value={typeof value === "number" ? value : null} onChange={(n) => onChange(n ?? undefined)} disabled={disabled} invalid={!!error} testId={`field-${path}`} ariaLabel={label} />
      </FieldShell>
    );
  }
  if (kind) {
    const options = optionsForKind(opts, kind);
    const numeric = kind !== "stage";
    return (
      <FieldShell id={id} path={path} label={label} required={required} hint={hint ?? (options.length === 0 && !opts.loading ? `No ${ENTITY_KIND_LABEL[kind]}s exist in this company yet.` : undefined)} error={error}>
        <EntitySelect
          id={id}
          value={value as string | number | null | undefined}
          onChange={(v) => onChange(v == null ? undefined : numeric ? Number(v) : v)}
          options={options}
          placeholder={required ? `Select ${ENTITY_KIND_LABEL[kind]}…` : `Any ${ENTITY_KIND_LABEL[kind]} (not set)`}
          allowClear={!required}
          disabled={disabled}
          loading={opts.loading}
          invalid={!!error}
          testId={`field-${path}`}
          ariaLabel={label}
        />
      </FieldShell>
    );
  }

  // ── nested objects: recipients or a field set ───────────────────────────
  if (schema.properties) {
    if (RECIPIENT_KEYS.has(name)) {
      return <RecipientField {...props} id={id} label={label} error={error} />;
    }
    return <FieldSetEditor {...props} id={id} label={label} />;
  }

  // ── arrays of enum members → checkbox group ─────────────────────────────
  if (schemaType(schema) === "array" && schema.items?.enum) {
    const chosen = Array.isArray(value) ? (value as string[]).map(String) : [];
    const members = schema.items.enum.map(String);
    const max = schema.maxItems;
    return (
      <FieldShell id={id} path={path} label={label} required={required} hint={hint} error={error}>
        <div id={id} role="group" aria-label={label} aria-describedby={describedBy} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 rounded-md border border-border p-3">
          {members.map((m) => {
            const checked = chosen.includes(m);
            const cid = `${id}-${m}`;
            return (
              <label key={m} htmlFor={cid} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={cid}
                  checked={checked}
                  disabled={disabled || (!checked && max != null && chosen.length >= max)}
                  onCheckedChange={(c) => {
                    const next = c ? [...chosen, m] : chosen.filter((x) => x !== m);
                    onChange(next.length ? next : undefined);
                  }}
                />
                <span>{props.memberLabel ? props.memberLabel(name, m) : enumValueLabel(m)}</span>
              </label>
            );
          })}
        </div>
      </FieldShell>
    );
  }

  // ── enum → select ───────────────────────────────────────────────────────
  if (schema.enum) {
    const current = value == null || value === "" ? NONE : String(value);
    return (
      <FieldShell id={id} path={path} label={label} required={required} hint={hint} error={error}>
        <Select value={current} onValueChange={(v) => onChange(v === NONE ? undefined : v)} disabled={disabled}>
          <SelectTrigger id={id} data-testid={`field-${path}`} aria-label={label} aria-invalid={!!error || undefined} aria-describedby={describedBy} className={cn("w-full", error && "border-destructive")}>
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {!required && <SelectItem value={NONE}>Any / not set</SelectItem>}
            {schema.enum.map((e) => (
              <SelectItem key={String(e)} value={String(e)}>
                {enumValueLabel(e)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldShell>
    );
  }

  // ── boolean → switch ────────────────────────────────────────────────────
  if (schemaType(schema) === "boolean") {
    return (
      <FieldShell id={id} path={path} label={label} required={required} hint={hint} error={error}>
        <div className="flex h-10 items-center">
          <Switch id={id} checked={Boolean(value)} onCheckedChange={(c) => onChange(c)} disabled={disabled} aria-describedby={describedBy} data-testid={`field-${path}`} />
        </div>
      </FieldShell>
    );
  }

  // ── numbers ─────────────────────────────────────────────────────────────
  if (isNumeric(schema)) {
    const { min, max, step } = numberBounds(schema);
    return (
      <FieldShell id={id} path={path} label={label} required={required} hint={hint ?? rangeHint(schema)} error={error}>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step ?? "any"}
          value={value == null || value === "" ? "" : String(value)}
          disabled={disabled}
          aria-invalid={!!error || undefined}
          aria-describedby={describedBy}
          data-testid={`field-${path}`}
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

  // ── dates / times by pattern ────────────────────────────────────────────
  if (schema.pattern === DATE_RE || schema.pattern === TIME_RE) {
    const type = schema.pattern === DATE_RE ? "date" : "time";
    return (
      <FieldShell id={id} path={path} label={label} required={required} hint={hint} error={error}>
        <Input
          id={id}
          type={type}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          aria-invalid={!!error || undefined}
          aria-describedby={describedBy}
          data-testid={`field-${path}`}
          className={cn(error && "border-destructive")}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        />
      </FieldShell>
    );
  }

  // ── long text → textarea ────────────────────────────────────────────────
  if (schema.maxLength != null && schema.maxLength >= 500) {
    return (
      <FieldShell id={id} path={path} label={label} required={required} hint={hint ?? `Up to ${schema.maxLength} characters`} error={error}>
        <Textarea
          id={id}
          rows={4}
          maxLength={schema.maxLength}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          aria-invalid={!!error || undefined}
          aria-describedby={describedBy}
          data-testid={`field-${path}`}
          className={cn(error && "border-destructive")}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        />
      </FieldShell>
    );
  }

  // ── short text ──────────────────────────────────────────────────────────
  return (
    <FieldShell id={id} path={path} label={label} required={required} hint={hint} error={error}>
      <Input
        id={id}
        type="text"
        maxLength={schema.maxLength}
        value={typeof value === "string" ? value : value == null ? "" : String(value)}
        disabled={disabled}
        aria-invalid={!!error || undefined}
        aria-describedby={describedBy}
        data-testid={`field-${path}`}
        className={cn(error && "border-destructive")}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      />
    </FieldShell>
  );
}

/**
 * assignee / recipient / to: who receives the task, follow-up, notification or
 * email — a recipient kind plus a specific user when the kind is "user".
 */
function RecipientField(props: SchemaFieldProps & { id: string; label: string; error?: string }) {
  const { schema, value, onChange, path, errors, disabled, catalog, id, label, required, error } = props;
  const opts = useEntityOptions();
  const current = (value && typeof value === "object" ? (value as { kind?: string; userId?: number }) : {}) as { kind?: string; userId?: number };
  const kinds = (schema.properties?.kind?.enum ?? []).map(String);
  const kindLabel = (k: string) => catalog.recipientKinds.find((r) => r.kind === k)?.label ?? enumValueLabel(k);
  const kindError = errors[`${path}.kind`];
  const userError = errors[`${path}.userId`];
  const kindId = `${id}-kind`;
  const userId = `${id}-userId`;
  return (
    <fieldset className="min-w-0 space-y-3 rounded-md border border-border p-3" data-field={path}>
      <legend className="px-1 text-xs font-medium">
        {label}
        {required && (
          <span className="text-destructive" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldShell id={kindId} path={`${path}.kind`} label="Who" required error={kindError}>
          <Select
            value={current.kind ?? NONE}
            disabled={disabled}
            onValueChange={(v) => {
              if (v === NONE) onChange(undefined);
              else onChange(v === "user" ? { kind: v, userId: current.userId } : { kind: v });
            }}
          >
            <SelectTrigger id={kindId} data-testid={`field-${path}.kind`} aria-label={`${label}: who`} aria-invalid={!!kindError || undefined} className={cn("w-full", kindError && "border-destructive")}>
              <SelectValue placeholder="Select recipient…" />
            </SelectTrigger>
            <SelectContent>
              {!required && <SelectItem value={NONE}>Not set</SelectItem>}
              {kinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {kindLabel(k)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldShell>
        {current.kind === "user" && (
          <FieldShell id={userId} path={`${path}.userId`} label="User" required error={userError}>
            <EntitySelect
              id={userId}
              value={current.userId}
              onChange={(v) => onChange({ kind: "user", userId: v == null ? undefined : Number(v) })}
              options={opts.users}
              placeholder="Select user…"
              disabled={disabled}
              loading={opts.loading}
              invalid={!!userError}
              testId={`field-${path}.userId`}
              ariaLabel={`${label}: user`}
            />
          </FieldShell>
        )}
      </div>
      {error && (
        <p role="alert" data-testid={`field-error-${path}`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * Nested `fields` object (update lead/contact fields): the user picks which
 * fields the action sets and edits only those.
 */
function FieldSetEditor(props: SchemaFieldProps & { id: string; label: string }) {
  const { schema, value, onChange, path, errors, disabled, catalog, id, label, required, entity, idPrefix } = props;
  const current = (value && typeof value === "object" ? (value as Record<string, unknown>) : {}) as Record<string, unknown>;
  const all = Object.keys(schema.properties ?? {});
  const chosen = all.filter((k) => k in current);
  const remaining = all.filter((k) => !(k in current));
  const ownError = errors[path];
  const nestedIssue = !ownError && hasIssueUnder(errors, path);
  return (
    <fieldset className="min-w-0 space-y-3 rounded-md border border-border p-3" data-field={path}>
      <legend className="px-1 text-xs font-medium">
        {label} to set
        {required && (
          <span className="text-destructive" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </legend>
      {chosen.length === 0 && <p className="text-sm text-muted-foreground">Choose at least one field this action should set.</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        {chosen.map((key) => (
          <div key={key} className={cn("flex min-w-0 items-start gap-2", (schema.properties?.[key]?.maxLength ?? 0) >= 500 && "sm:col-span-2")}>
            <div className="min-w-0 flex-1">
              <SchemaField
                name={key}
                schema={schema.properties![key]}
                required
                value={current[key]}
                onChange={(next) => onChange({ ...current, [key]: next === undefined ? "" : next })}
                path={`${path}.${key}`}
                entity={entity}
                errors={errors}
                disabled={disabled}
                catalog={catalog}
                idPrefix={idPrefix}
              />
            </div>
            {!disabled && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="mt-6 shrink-0"
                aria-label={`Remove ${configKeyLabel(key)}`}
                onClick={() => {
                  const next = { ...current };
                  delete next[key];
                  onChange(next);
                }}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        ))}
      </div>
      {!disabled && remaining.length > 0 && (
        <Select value={NONE} onValueChange={(k) => k !== NONE && onChange({ ...current, [k]: "" })}>
          <SelectTrigger id={id} data-testid={`field-${path}.add`} aria-label={`Add a field to ${label.toLowerCase()}`} className="w-full sm:w-72">
            <SelectValue placeholder="Add a field to set…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Add a field to set…</SelectItem>
            {remaining.map((k) => (
              <SelectItem key={k} value={k}>
                {configKeyLabel(k)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {ownError && (
        <p role="alert" data-testid={`field-error-${path}`} className="text-xs text-destructive">
          {ownError}
        </p>
      )}
      {nestedIssue && <p className="text-xs text-destructive">Check the highlighted fields.</p>}
    </fieldset>
  );
}
