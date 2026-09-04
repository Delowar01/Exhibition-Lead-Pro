import { z } from "zod/v4";
import {
  ACTION_TYPES,
  CONDITION_OPERATORS,
  OPERATOR_DEFS,
  OPERATORS_BY_FIELD_TYPE,
  TRIGGER_TYPES,
  WORKFLOW_ACTIONS,
  WORKFLOW_LIMITS,
  WORKFLOW_TRIGGERS,
  conditionField,
  type ActionDef,
  type ConditionFieldDef,
  type ConditionOperator,
  type RefTable,
  type TenantRef,
  type TriggerDef,
  type WorkflowActionType,
  type WorkflowEntity,
  type WorkflowTriggerType,
} from "./catalog.js";

// =============================================================================
// Workflow definition contract (Batch 15).
// =============================================================================
// The ONE typed contract for a definition body:
//
//   {
//     trigger:    { type, config },
//     conditions: [ { field, operator, value? } ],   // ALL must hold (AND)
//     actions:    [ { type, config } ],              // ordered; index = execution order
//   }
//
// `validateDefinitionSpec` is PURE (no I/O): structural validation, trigger
// config, condition field/operator/value compatibility, action/trigger entity
// compatibility and action config — all against lib/workflows/catalog.ts.
// Tenant-reference checks (ids/keys must belong to the company) are I/O and
// live in the service, driven by `collectTenantRefs` below. Both API validation
// (create/update/publish/validate endpoints) and the future engine/UI consume
// exactly this module — validation rules are never duplicated in routes.
//
// Nothing here executes anything.

const primitive = z.union([z.string().max(WORKFLOW_LIMITS.maxValueLength), z.number(), z.boolean()]);
const conditionValue = z.union([primitive, z.null(), z.array(z.union([z.string().max(WORKFLOW_LIMITS.maxValueLength), z.number()])).max(WORKFLOW_LIMITS.maxListValues)]);

export const WorkflowConditionSchema = z.strictObject({
  field: z.string().trim().min(1).max(64),
  operator: z.enum(CONDITION_OPERATORS),
  value: conditionValue.optional(),
});

export const WorkflowTriggerSchema = z.strictObject({
  type: z.enum(TRIGGER_TYPES),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const WorkflowActionSchema = z.strictObject({
  type: z.enum(ACTION_TYPES),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const WorkflowDefinitionSpecSchema = z.strictObject({
  trigger: WorkflowTriggerSchema,
  conditions: z.array(WorkflowConditionSchema).max(WORKFLOW_LIMITS.maxConditions).default([]),
  actions: z.array(WorkflowActionSchema).max(WORKFLOW_LIMITS.maxActions).default([]),
});

export type WorkflowConditionValue = string | number | boolean | null | Array<string | number>;

export interface WorkflowCondition {
  field: string;
  operator: ConditionOperator;
  value?: WorkflowConditionValue;
}

export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  config: Record<string, unknown>;
}

export interface WorkflowAction {
  type: WorkflowActionType;
  config: Record<string, unknown>;
}

// A fully validated + normalized definition body (configs carry their defaults).
export interface WorkflowDefinitionSpec {
  trigger: WorkflowTrigger;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
}

export interface WorkflowValidationIssue {
  path: string; // dotted/indexed path, e.g. "actions[1].config.tagId"
  message: string;
  code: string; // stable machine-readable code
}

export type WorkflowValidationResult =
  | { ok: true; spec: WorkflowDefinitionSpec; issues: [] }
  | { ok: false; issues: WorkflowValidationIssue[] };

function joinPath(base: string, issuePath: ReadonlyArray<PropertyKey>): string {
  let out = base;
  for (const seg of issuePath) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || "(body)";
}

function zodIssues(base: string, error: z.ZodError, code: string): WorkflowValidationIssue[] {
  return error.issues.map((i) => ({ path: joinPath(base, i.path), message: i.message, code }));
}

export function triggerEntity(type: WorkflowTriggerType): WorkflowEntity {
  return (WORKFLOW_TRIGGERS[type] as TriggerDef).entity;
}

function isPrimitiveCompatible(field: ConditionFieldDef, value: unknown): string | null {
  switch (field.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "expected a number";
    case "id":
      return typeof value === "number" && Number.isInteger(value) && value > 0 ? null : "expected a positive integer id";
    case "boolean":
      return typeof value === "boolean" ? null : "expected true or false";
    case "enum":
      if (typeof value !== "string") return "expected a string";
      return field.enumValues?.includes(value) ? null : `expected one of: ${field.enumValues?.join(", ")}`;
    case "string":
    case "list":
      return typeof value === "string" ? null : "expected a string";
  }
}

function validateCondition(entity: WorkflowEntity, index: number, c: z.infer<typeof WorkflowConditionSchema>, issues: WorkflowValidationIssue[]): void {
  const base = `conditions[${index}]`;
  const field = conditionField(entity, c.field);
  if (!field) {
    issues.push({ path: `${base}.field`, message: `Unknown ${entity} field "${c.field}"`, code: "WORKFLOW_UNKNOWN_FIELD" });
    return;
  }
  if (!OPERATORS_BY_FIELD_TYPE[field.type].includes(c.operator)) {
    issues.push({
      path: `${base}.operator`,
      message: `Operator "${c.operator}" is not supported for field "${c.field}" (${field.type})`,
      code: "WORKFLOW_UNSUPPORTED_OPERATOR",
    });
    return;
  }
  const shape = OPERATOR_DEFS[c.operator].valueShape;
  const v = c.value;
  if (shape === "none") {
    if (v !== undefined && v !== null) {
      issues.push({ path: `${base}.value`, message: `Operator "${c.operator}" takes no value`, code: "WORKFLOW_INVALID_VALUE" });
    }
    return;
  }
  if (shape === "single") {
    if (v === undefined || v === null || Array.isArray(v)) {
      issues.push({ path: `${base}.value`, message: `Operator "${c.operator}" requires a single value`, code: "WORKFLOW_INVALID_VALUE" });
      return;
    }
    const err = isPrimitiveCompatible(field, v);
    if (err) issues.push({ path: `${base}.value`, message: err, code: "WORKFLOW_INVALID_VALUE" });
    return;
  }
  // list
  if (!Array.isArray(v) || v.length === 0) {
    issues.push({ path: `${base}.value`, message: `Operator "${c.operator}" requires a non-empty list of values`, code: "WORKFLOW_INVALID_VALUE" });
    return;
  }
  v.forEach((item, i) => {
    const err = isPrimitiveCompatible(field, item);
    if (err) issues.push({ path: `${base}.value[${i}]`, message: err, code: "WORKFLOW_INVALID_VALUE" });
  });
}

/**
 * Validate an untrusted definition body against the catalog. Pure; never throws.
 * On success returns the NORMALIZED spec (configs parsed with defaults applied,
 * action order preserved exactly as given).
 */
export function validateDefinitionSpec(input: unknown): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = [];

  // Size cap before anything else: the body limit is generous (images), a
  // definition is not.
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input ?? null), "utf8");
  } catch {
    return { ok: false, issues: [{ path: "(body)", message: "Definition is not serializable", code: "WORKFLOW_INVALID_BODY" }] };
  }
  if (bytes > WORKFLOW_LIMITS.maxDefinitionBytes) {
    return {
      ok: false,
      issues: [{ path: "(body)", message: `Definition exceeds the maximum size of ${WORKFLOW_LIMITS.maxDefinitionBytes} bytes`, code: "WORKFLOW_TOO_LARGE" }],
    };
  }

  const parsed = WorkflowDefinitionSpecSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: zodIssues("", parsed.error, "WORKFLOW_INVALID_SHAPE") };
  }
  const { trigger, conditions, actions } = parsed.data;

  // Trigger config.
  const triggerDef: TriggerDef = WORKFLOW_TRIGGERS[trigger.type];
  const triggerConfig = triggerDef.configSchema.safeParse(trigger.config ?? {});
  if (!triggerConfig.success) {
    issues.push(...zodIssues("trigger.config", triggerConfig.error, "WORKFLOW_INVALID_TRIGGER_CONFIG"));
  }
  const entity = triggerDef.entity;

  // Conditions.
  conditions.forEach((c, i) => validateCondition(entity, i, c, issues));

  // Actions (order preserved; index = execution order).
  const normalizedActions: WorkflowAction[] = [];
  actions.forEach((a, i) => {
    const def: ActionDef = WORKFLOW_ACTIONS[a.type];
    if (!def.entities.includes(entity)) {
      issues.push({
        path: `actions[${i}].type`,
        message: `Action "${a.type}" is not available for ${entity} triggers`,
        code: "WORKFLOW_ACTION_ENTITY_MISMATCH",
      });
      return;
    }
    const cfg = def.configSchema.safeParse(a.config ?? {});
    if (!cfg.success) {
      issues.push(...zodIssues(`actions[${i}].config`, cfg.error, "WORKFLOW_INVALID_ACTION_CONFIG"));
      return;
    }
    normalizedActions.push({ type: a.type, config: cfg.data as Record<string, unknown> });
  });

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    issues: [],
    spec: {
      trigger: { type: trigger.type, config: (triggerConfig.success ? triggerConfig.data : {}) as Record<string, unknown> },
      conditions: conditions.map((c) => (c.value === undefined ? { field: c.field, operator: c.operator } : { field: c.field, operator: c.operator, value: c.value })),
      actions: normalizedActions,
    },
  };
}

// ── Tenant references ───────────────────────────────────────────────────────
export type CollectedRef =
  | { path: string; kind: "row"; table: RefTable; id: number }
  | { path: string; kind: "stageKey"; key: string };

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Every id/key inside a (validated) spec that must belong to the definition's
 * company, with the path it was found at — so the service can verify each one
 * with the tenant helpers and report a precise validation issue.
 */
export function collectTenantRefs(spec: WorkflowDefinitionSpec): CollectedRef[] {
  const out: CollectedRef[] = [];
  const push = (base: string, obj: unknown, refs: readonly TenantRef[]) => {
    for (const ref of refs) {
      const v = readPath(obj, ref.path);
      if (v === undefined || v === null) continue;
      const path = `${base}.${ref.path}`;
      if (ref.kind === "stageKey") {
        if (typeof v === "string") out.push({ path, kind: "stageKey", key: v });
      } else if (typeof v === "number") {
        out.push({ path, kind: "row", table: ref.table, id: v });
      }
    }
  };
  push("trigger.config", spec.trigger.config, (WORKFLOW_TRIGGERS[spec.trigger.type] as TriggerDef).refs);
  spec.actions.forEach((a, i) => push(`actions[${i}].config`, a.config, (WORKFLOW_ACTIONS[a.type] as ActionDef).refs));
  return out;
}
