import { CONDITION_FIELDS, conditionField, type ConditionFieldType, type WorkflowEntity } from "./catalog.js";
import type { WorkflowCondition } from "./definition.js";

// =============================================================================
// Pure, deterministic condition evaluator (Batch 16).
// =============================================================================
// Evaluates the B15 condition list against a flat entity record (post-mutation
// state). ALL conditions must hold (AND). No eval, no expressions, no SQL —
// every operator is an explicit, typed comparison, and a value that does not fit
// the field's declared type makes the condition FALSE (fail safe) instead of
// being coerced.
//
// Semantics:
//   equals / not_equals      exact scalar equality (numbers compared numerically,
//                            strings compared exactly, booleans by value)
//   contains / not_contains  string field: case-insensitive substring;
//                            list field: exact list membership
//   in / not_in              scalar membership in the configured list
//   is_empty / is_not_empty  null, undefined, "" (or whitespace) and [] are empty
//   greater_than / less_than numeric only (both sides finite numbers)
// A missing operator/field combination that the catalog does not allow is FALSE.

export type EntityRecord = Record<string, unknown>;

export interface ConditionEvaluation {
  matched: boolean;
  // First failing condition (index + reason) for diagnostics; undefined when matched.
  failed?: { index: number; reason: string };
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // Numeric columns (e.g. leads.value) arrive as decimal strings from PostgreSQL.
  if (typeof v === "string" && v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

function scalarEquals(type: ConditionFieldType, actual: unknown, expected: unknown): boolean | null {
  switch (type) {
    case "number":
    case "id": {
      const a = asNumber(actual);
      const e = asNumber(expected);
      if (a === null || e === null) return null;
      return a === e;
    }
    case "boolean":
      if (typeof actual !== "boolean" || typeof expected !== "boolean") return null;
      return actual === expected;
    case "string":
    case "enum":
      if (typeof expected !== "string") return null;
      if (actual === null || actual === undefined) return false;
      if (typeof actual !== "string") return null;
      return actual === expected;
    case "list":
      return null; // equality is not defined for list fields (catalog forbids it)
  }
}

function evaluateOne(entity: WorkflowEntity, record: EntityRecord, c: WorkflowCondition): { ok: boolean; reason?: string } {
  const field = conditionField(entity, c.field);
  if (!field) return { ok: false, reason: `unknown field "${c.field}"` };
  const actual = record[c.field];
  const expected = c.value;

  switch (c.operator) {
    case "is_empty":
      return { ok: isEmptyValue(actual) };
    case "is_not_empty":
      return { ok: !isEmptyValue(actual) };

    case "equals": {
      const r = scalarEquals(field.type, actual, expected);
      return r === null ? { ok: false, reason: "type mismatch" } : { ok: r };
    }
    case "not_equals": {
      const r = scalarEquals(field.type, actual, expected);
      return r === null ? { ok: false, reason: "type mismatch" } : { ok: !r };
    }

    case "contains":
    case "not_contains": {
      let has: boolean | null = null;
      if (field.type === "list") {
        if (!Array.isArray(actual) || typeof expected !== "string") has = Array.isArray(actual) ? false : null;
        else has = actual.some((item) => typeof item === "string" && item === expected);
      } else if (field.type === "string") {
        if (typeof expected !== "string") has = null;
        else if (actual === null || actual === undefined) has = false;
        else if (typeof actual !== "string") has = null;
        else has = actual.toLowerCase().includes(expected.toLowerCase());
      }
      if (has === null) return { ok: false, reason: "type mismatch" };
      return { ok: c.operator === "contains" ? has : !has };
    }

    case "in":
    case "not_in": {
      if (!Array.isArray(expected)) return { ok: false, reason: "list expected" };
      if (field.type === "list") return { ok: false, reason: "unsupported for list fields" };
      let member = false;
      for (const item of expected) {
        const r = scalarEquals(field.type, actual, item);
        if (r === true) {
          member = true;
          break;
        }
      }
      // A null/undefined actual is never a member (both operators stay well-defined).
      return { ok: c.operator === "in" ? member : !member };
    }

    case "greater_than":
    case "less_than": {
      if (field.type !== "number" && field.type !== "id") return { ok: false, reason: "numeric field expected" };
      const a = asNumber(actual);
      const e = asNumber(expected);
      if (a === null || e === null) return { ok: false, reason: "non-numeric value" };
      return { ok: c.operator === "greater_than" ? a > e : a < e };
    }
  }
}

export function evaluateConditions(entity: WorkflowEntity, record: EntityRecord, conditions: readonly WorkflowCondition[]): ConditionEvaluation {
  for (let i = 0; i < conditions.length; i++) {
    const r = evaluateOne(entity, record, conditions[i]);
    if (!r.ok) return { matched: false, failed: { index: i, reason: r.reason ?? "condition not met" } };
  }
  return { matched: true };
}

// Which keys of a record the catalog recognizes for an entity (used to build
// change-sets for update triggers).
export function conditionFieldKeys(entity: WorkflowEntity): string[] {
  return CONDITION_FIELDS[entity].map((f) => f.key);
}
