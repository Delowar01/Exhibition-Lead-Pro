import type { WorkflowCatalog, WorkflowDefinition } from "@workspace/api-client-react";
import { ApiError } from "@workspace/api-client-react";

// =============================================================================
// Batch 17 — typed view of GET /workflows/catalog + the editor's local model.
// The catalog is the ONLY source of labels, fields, operators, limits, lifecycle
// rules and configuration schemas; nothing here hardcodes a trigger/action list.
// =============================================================================

export type WorkflowEntity = "lead" | "contact";

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: Array<string | number>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  default?: unknown;
  description?: string;
  additionalProperties?: boolean;
}

export interface CatalogTrigger {
  type: string;
  entity: WorkflowEntity;
  label: string;
  description: string;
  configSchema: JsonSchema;
}

export interface CatalogAction {
  type: string;
  label: string;
  description: string;
  entities: WorkflowEntity[];
  configSchema: JsonSchema;
}

export type ValueShape = "single" | "list" | "none";

export interface CatalogOperator {
  operator: string;
  label: string;
  valueShape: ValueShape;
}

export type ConditionFieldType = "string" | "number" | "boolean" | "enum" | "id" | "list";

export interface CatalogField {
  key: string;
  label: string;
  type: ConditionFieldType;
  enumValues?: string[];
  operators: string[];
}

export interface CatalogLifecycleEntry {
  label: string;
  description: string;
  editable: boolean;
  deletable: boolean;
  transitions: string[];
}

export interface CatalogLimits {
  nameMaxLength: number;
  descriptionMaxLength: number;
  maxConditions: number;
  maxActions: number;
  maxListValues: number;
  maxValueLength: number;
  maxDefinitionBytes: number;
}

export interface Catalog {
  schemaVersion: number;
  limits: CatalogLimits;
  statuses: string[];
  lifecycle: Record<string, CatalogLifecycleEntry>;
  entities: WorkflowEntity[];
  triggers: CatalogTrigger[];
  conditionOperators: CatalogOperator[];
  conditionFields: Record<WorkflowEntity, CatalogField[]>;
  actions: CatalogAction[];
  recipientKinds: Array<{ kind: string; label: string }>;
}

/** The generated client types the catalog loosely; narrow it once here. */
export function asCatalog(data: WorkflowCatalog): Catalog {
  return data as unknown as Catalog;
}

export function triggerOf(catalog: Catalog, type: string | undefined): CatalogTrigger | undefined {
  return catalog.triggers.find((t) => t.type === type);
}

export function actionOf(catalog: Catalog, type: string | undefined): CatalogAction | undefined {
  return catalog.actions.find((a) => a.type === type);
}

export function operatorOf(catalog: Catalog, operator: string | undefined): CatalogOperator | undefined {
  return catalog.conditionOperators.find((o) => o.operator === operator);
}

export function fieldOf(catalog: Catalog, entity: WorkflowEntity, key: string | undefined): CatalogField | undefined {
  return (catalog.conditionFields[entity] ?? []).find((f) => f.key === key);
}

/** Actions compatible with the trigger's entity, in catalog order. */
export function actionsForEntity(catalog: Catalog, entity: WorkflowEntity | undefined): CatalogAction[] {
  if (!entity) return [];
  return catalog.actions.filter((a) => a.entities.includes(entity));
}

// ── editor model ────────────────────────────────────────────────────────────

export interface EditorCondition {
  id: string;
  field: string;
  operator: string;
  value?: unknown;
}

export interface EditorAction {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

export interface EditorState {
  name: string;
  description: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  conditions: EditorCondition[];
  actions: EditorAction[];
}

let uidCounter = 0;
export function uid(): string {
  uidCounter += 1;
  return `k${Date.now().toString(36)}${uidCounter}`;
}

export function emptyEditorState(catalog: Catalog | undefined): EditorState {
  return {
    name: "",
    description: "",
    triggerType: catalog?.triggers[0]?.type ?? "",
    triggerConfig: {},
    conditions: [],
    actions: [],
  };
}

export function editorStateFromDefinition(d: WorkflowDefinition): EditorState {
  const trigger = (d.trigger ?? {}) as { type?: string; config?: Record<string, unknown> };
  return {
    name: d.name ?? "",
    description: d.description ?? "",
    triggerType: trigger.type ?? "",
    triggerConfig: { ...(trigger.config ?? {}) },
    conditions: (Array.isArray(d.conditions) ? d.conditions : []).map((c) => ({
      id: uid(),
      field: String((c as { field?: unknown }).field ?? ""),
      operator: String((c as { operator?: unknown }).operator ?? ""),
      value: (c as { value?: unknown }).value,
    })),
    actions: (Array.isArray(d.actions) ? d.actions : []).map((a) => ({
      id: uid(),
      type: String((a as { type?: unknown }).type ?? ""),
      config: { ...(((a as { config?: Record<string, unknown> }).config) ?? {}) },
    })),
  };
}

/**
 * Drop empty values (undefined, null, "", empty arrays) so optional fields the
 * user never touched are not sent — the strict server schemas reject empty
 * strings. Nested objects are cleaned recursively; an empty nested object is
 * kept only when it was explicitly present (the server reports the precise
 * issue, e.g. "at least one field is required").
 */
export function cleanConfig(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      out[k] = v;
      continue;
    }
    if (typeof v === "object") {
      out[k] = cleanConfig(v as Record<string, unknown>);
      continue;
    }
    out[k] = v;
  }
  return out;
}

export interface DefinitionPayload {
  name: string;
  description: string | null;
  trigger: { type: string; config: Record<string, unknown> };
  conditions: Array<{ field: string; operator: string; value?: unknown }>;
  actions: Array<{ type: string; config: Record<string, unknown> }>;
}

export function toPayload(s: EditorState, catalog: Catalog): DefinitionPayload {
  return {
    name: s.name.trim(),
    description: s.description.trim() === "" ? null : s.description.trim(),
    trigger: { type: s.triggerType, config: cleanConfig(s.triggerConfig) },
    conditions: s.conditions.map((c) => {
      const op = operatorOf(catalog, c.operator);
      const out: { field: string; operator: string; value?: unknown } = { field: c.field, operator: c.operator };
      if (op?.valueShape !== "none" && c.value !== undefined && c.value !== "") out.value = c.value;
      return out;
    }),
    actions: s.actions.map((a) => ({ type: a.type, config: cleanConfig(a.config) })),
  };
}

/** Stable fingerprint used for dirty-tracking (ignores local ids). */
export function fingerprint(s: EditorState, catalog: Catalog | undefined): string {
  if (!catalog) return JSON.stringify(s);
  return JSON.stringify(toPayload(s, catalog));
}

// ── server error mapping ────────────────────────────────────────────────────

export interface ServerIssue {
  field: string;
  message: string;
  code?: string;
}

export interface ParsedApiError {
  status: number | null;
  code: string | null;
  message: string;
  issues: ServerIssue[];
  /** Server-supplied context (e.g. { currentRevision } on a 409 conflict). */
  context: Record<string, unknown>;
}

export function parseApiError(err: unknown, fallback = "Something went wrong"): ParsedApiError {
  if (err instanceof ApiError) {
    const data = (err.data ?? {}) as {
      error?: unknown;
      message?: unknown;
      code?: unknown;
      details?: unknown;
      context?: unknown;
    };
    const rawIssues = Array.isArray(data.details) ? (data.details as Array<Record<string, unknown>>) : [];
    const issues: ServerIssue[] = rawIssues
      .filter((d) => typeof d?.field === "string")
      .map((d) => ({ field: String(d.field), message: String(d.message ?? "Invalid value"), code: typeof d.code === "string" ? d.code : undefined }));
    const message = typeof data.error === "string" ? data.error : typeof data.message === "string" ? data.message : err.status >= 500 ? "The server could not complete the request" : fallback;
    return {
      status: err.status,
      code: typeof data.code === "string" ? data.code : null,
      message,
      issues,
      context: (data.context && typeof data.context === "object" ? (data.context as Record<string, unknown>) : {}),
    };
  }
  if (err instanceof TypeError) {
    return { status: null, code: null, message: "Network error — check your connection and try again", issues: [], context: {} };
  }
  return { status: null, code: null, message: err instanceof Error && err.message ? err.message : fallback, issues: [], context: {} };
}

export type IssueMap = Record<string, string>;

export function issueMap(issues: ServerIssue[]): IssueMap {
  const map: IssueMap = {};
  for (const i of issues) if (!(i.field in map)) map[i.field] = i.message;
  return map;
}

/** Path helpers — must match the API's issue paths exactly (e.g. actions[1].config.assignee.userId). */
export const paths = {
  trigger: (key?: string) => (key ? `trigger.config.${key}` : "trigger"),
  condition: (i: number, part?: "field" | "operator" | "value") => (part ? `conditions[${i}].${part}` : `conditions[${i}]`),
  action: (i: number, key?: string) => (key ? `actions[${i}].config.${key}` : `actions[${i}]`),
};

/** True when any issue path starts with the given prefix (section-level highlighting). */
export function hasIssueUnder(map: IssueMap, prefix: string): boolean {
  return Object.keys(map).some((k) => k === prefix || k.startsWith(prefix + ".") || k.startsWith(prefix + "["));
}
