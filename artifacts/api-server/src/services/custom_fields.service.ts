import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as repo from "../repositories/custom_fields.repository.js";
import type { CustomFieldDefinitionRow } from "../repositories/custom_fields.repository.js";

// Field types supported by a custom-field definition. Kept in sync with the
// OpenAPI CustomFieldDefinition.fieldType enum.
const FIELD_TYPES = [
  "text", "number", "date", "dropdown", "checkbox", "radio", "url", "email", "phone", "currency",
] as const;
type FieldType = (typeof FIELD_TYPES)[number];

const ENTITY_TYPES = ["lead", "contact"] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

const OPTION_TYPES = new Set<FieldType>(["dropdown", "radio"]);

interface FieldOption { label: string; value: string; }
interface FieldValidation {
  min?: number | null;
  max?: number | null;
  minLength?: number | null;
  maxLength?: number | null;
  pattern?: string | null;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// ── Response formatting ──────────────────────────────────────────────────────

function formatDefinition(d: CustomFieldDefinitionRow) {
  return {
    id: d.id,
    companyId: d.companyId,
    entityType: d.entityType,
    fieldKey: d.fieldKey,
    label: d.label,
    fieldType: d.fieldType,
    options: parseJson<FieldOption[]>(d.options) ?? [],
    required: d.required,
    defaultValue: d.defaultValue ?? null,
    validation: parseJson<FieldValidation>(d.validation),
    visibilityCondition: parseJson<Record<string, unknown>>(d.visibilityCondition),
    sortOrder: d.sortOrder,
    createdById: d.createdById ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt ? d.updatedAt.toISOString() : null,
  };
}

// ── Input normalization / validation ─────────────────────────────────────────

function assertEntityType(v: unknown): EntityType {
  if (typeof v !== "string" || !ENTITY_TYPES.includes(v as EntityType)) {
    throw new AppError(400, `entityType must be one of: ${ENTITY_TYPES.join(", ")}`);
  }
  return v as EntityType;
}

function assertFieldType(v: unknown): FieldType {
  if (typeof v !== "string" || !FIELD_TYPES.includes(v as FieldType)) {
    throw new AppError(400, `fieldType must be one of: ${FIELD_TYPES.join(", ")}`);
  }
  return v as FieldType;
}

// A stable machine key: lowercase alphanumeric + underscore, must start with a letter.
function assertFieldKey(v: unknown): string {
  if (typeof v !== "string" || !/^[a-z][a-z0-9_]*$/.test(v)) {
    throw new AppError(400, "fieldKey must be lowercase alphanumeric/underscore and start with a letter");
  }
  return v;
}

function assertLabel(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new AppError(400, "label is required");
  return v.trim();
}

function normalizeOptions(fieldType: FieldType, raw: unknown): FieldOption[] | null {
  if (!OPTION_TYPES.has(fieldType)) return null;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError(400, `${fieldType} fields require a non-empty options array`);
  }
  const seen = new Set<string>();
  const out: FieldOption[] = [];
  for (const o of raw) {
    if (!o || typeof o !== "object") throw new AppError(400, "each option must be an object with label and value");
    const label = (o as { label?: unknown }).label;
    const value = (o as { value?: unknown }).value;
    if (typeof label !== "string" || label.trim() === "") throw new AppError(400, "option.label is required");
    if (typeof value !== "string" || value.trim() === "") throw new AppError(400, "option.value is required");
    if (seen.has(value)) throw new AppError(400, `duplicate option value: ${value}`);
    seen.add(value);
    out.push({ label: label.trim(), value });
  }
  return out;
}

function normalizeValidation(raw: unknown): FieldValidation | null {
  if (raw == null) return null;
  if (typeof raw !== "object") throw new AppError(400, "validation must be an object");
  const v = raw as Record<string, unknown>;
  const num = (k: string): number | null => {
    if (v[k] == null) return null;
    if (typeof v[k] !== "number" || Number.isNaN(v[k])) throw new AppError(400, `validation.${k} must be a number`);
    return v[k] as number;
  };
  const validation: FieldValidation = {
    min: num("min"),
    max: num("max"),
    minLength: num("minLength"),
    maxLength: num("maxLength"),
    pattern: typeof v.pattern === "string" ? v.pattern : null,
  };
  if (validation.pattern) {
    try { new RegExp(validation.pattern); } catch { throw new AppError(400, "validation.pattern is not a valid regular expression"); }
  }
  return validation;
}

function normalizeVisibility(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw !== "object") throw new AppError(400, "visibilityCondition must be an object");
  const v = raw as Record<string, unknown>;
  const operators = ["equals", "not_equals", "in", "not_empty"];
  if (typeof v.fieldKey !== "string" || v.fieldKey.trim() === "") throw new AppError(400, "visibilityCondition.fieldKey is required");
  if (typeof v.operator !== "string" || !operators.includes(v.operator)) {
    throw new AppError(400, `visibilityCondition.operator must be one of: ${operators.join(", ")}`);
  }
  return { fieldKey: v.fieldKey, operator: v.operator, value: v.value ?? null };
}

// ── Definitions CRUD ─────────────────────────────────────────────────────────

export interface ListDefinitionsParams { entityType?: string; }

export async function listDefinitions(user: AuthUser, params: ListDefinitionsParams) {
  const entityType = params.entityType ? assertEntityType(params.entityType) : undefined;
  const { rows, total } = await repo.listDefinitions(user, { entityType });
  return { definitions: rows.map(formatDefinition), total };
}

export async function getDefinition(user: AuthUser, id: number) {
  const d = await repo.findDefinitionById(user, id);
  if (!d) throw new AppError(404, "Custom field not found");
  return formatDefinition(d);
}

export async function createDefinition(user: AuthUser, body: Record<string, unknown>) {
  const companyId = user.companyId ?? null;
  if (!companyId) throw new AppError(400, "No company context");

  const entityType = assertEntityType(body.entityType);
  const fieldKey = assertFieldKey(body.fieldKey);
  const label = assertLabel(body.label);
  const fieldType = assertFieldType(body.fieldType);
  const options = normalizeOptions(fieldType, body.options);
  const validation = normalizeValidation(body.validation);
  const visibilityCondition = normalizeVisibility(body.visibilityCondition);
  const defaultValue = normalizeDefault(fieldType, validation, options ?? [], body.defaultValue);

  const conflict = await repo.findKeyConflict(companyId, entityType, fieldKey);
  if (conflict !== undefined) throw new AppError(409, `A field with key "${fieldKey}" already exists for ${entityType}`);

  const created = await repo.insertDefinition({
    companyId,
    entityType,
    fieldKey,
    label,
    fieldType,
    options: options ? JSON.stringify(options) : null,
    required: body.required === true,
    defaultValue,
    validation: validation ? JSON.stringify(validation) : null,
    visibilityCondition: visibilityCondition ? JSON.stringify(visibilityCondition) : null,
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
    createdById: user.id,
  });
  return formatDefinition(created);
}

export async function updateDefinition(user: AuthUser, id: number, body: Record<string, unknown>) {
  const existing = await repo.findDefinitionById(user, id);
  if (!existing) throw new AppError(404, "Custom field not found");

  // fieldType can change; options/validation are re-validated against the
  // effective (possibly new) type. entityType and fieldKey are immutable — a
  // key change would orphan stored values.
  const fieldType = body.fieldType !== undefined ? assertFieldType(body.fieldType) : (existing.fieldType as FieldType);

  const updateData: Record<string, unknown> = {};
  if (body.label !== undefined) updateData.label = assertLabel(body.label);
  if (body.fieldType !== undefined) updateData.fieldType = fieldType;

  // Resolve the EFFECTIVE options/validation (new value if provided, else the
  // stored one) so a defaultValue — new or pre-existing — can be re-validated
  // against the field's final shape after this update.
  let effectiveOptions: FieldOption[] = parseJson<FieldOption[]>(existing.options) ?? [];
  let effectiveValidation: FieldValidation | null = parseJson<FieldValidation>(existing.validation);
  if (body.options !== undefined) {
    const options = normalizeOptions(fieldType, body.options);
    updateData.options = options ? JSON.stringify(options) : null;
    effectiveOptions = options ?? [];
  } else if (body.fieldType !== undefined && OPTION_TYPES.has(fieldType)) {
    // Switching TO an option type without providing options: the existing
    // options must already be valid, otherwise reject.
    const current = parseJson<FieldOption[]>(existing.options);
    if (!current || current.length === 0) throw new AppError(400, `${fieldType} fields require a non-empty options array`);
    effectiveOptions = current;
  }
  if (body.required !== undefined) updateData.required = body.required === true;
  if (body.validation !== undefined) {
    const validation = normalizeValidation(body.validation);
    updateData.validation = validation ? JSON.stringify(validation) : null;
    effectiveValidation = validation;
  }
  // Validate defaultValue against the effective type/options/validation. Also
  // re-validate a STORED default whenever the shape that constrains it changes —
  // fieldType, options, OR validation — because a default valid under the old
  // shape (e.g. dropdown option "A", or a 3-char text) can become invalid under
  // the new one (options ["B"], or minLength 5). normalizeDefault throws 400 on
  // an now-invalid default so we never leave an inconsistent default behind.
  if (body.defaultValue !== undefined) {
    updateData.defaultValue = normalizeDefault(fieldType, effectiveValidation, effectiveOptions, body.defaultValue);
  } else if ((body.fieldType !== undefined || body.options !== undefined || body.validation !== undefined) && existing.defaultValue) {
    updateData.defaultValue = normalizeDefault(fieldType, effectiveValidation, effectiveOptions, existing.defaultValue);
  }
  if (body.visibilityCondition !== undefined) {
    const visibility = normalizeVisibility(body.visibilityCondition);
    updateData.visibilityCondition = visibility ? JSON.stringify(visibility) : null;
  }
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== "number") throw new AppError(400, "sortOrder must be a number");
    updateData.sortOrder = body.sortOrder;
  }

  if (Object.keys(updateData).length === 0) throw new AppError(400, "No valid fields to update");
  updateData.updatedAt = new Date();

  const updated = await repo.updateDefinition(id, updateData);
  if (!updated) throw new AppError(404, "Custom field not found");
  return formatDefinition(updated);
}

export async function deleteDefinition(user: AuthUser, id: number) {
  const existing = await repo.findDefinitionById(user, id);
  if (!existing) throw new AppError(404, "Custom field not found");
  await repo.softDeleteDefinition(id);
  return { success: true, message: "Custom field deleted" };
}

// ── Value validation per type ────────────────────────────────────────────────

// Validate a NON-EMPTY raw value against the field TYPE + rules (no required
// check). Returns the normalized value. Shared by stored-value validation and
// definition defaultValue validation.
function validateTypedValue(
  fieldType: FieldType,
  validation: FieldValidation | null,
  options: FieldOption[],
  label: string,
  raw: string,
): string {
  switch (fieldType) {
    case "number":
    case "currency": {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new AppError(400, `${label} must be a number`);
      if (validation?.min != null && n < validation.min) throw new AppError(400, `${label} must be >= ${validation.min}`);
      if (validation?.max != null && n > validation.max) throw new AppError(400, `${label} must be <= ${validation.max}`);
      return String(n);
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new AppError(400, `${label} must be a date (YYYY-MM-DD)`);
      const d = new Date(`${raw}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) throw new AppError(400, `${label} is not a valid date`);
      return raw;
    }
    case "checkbox": {
      if (raw !== "true" && raw !== "false") throw new AppError(400, `${label} must be true or false`);
      return raw;
    }
    case "dropdown":
    case "radio": {
      if (!options.some((o) => o.value === raw)) throw new AppError(400, `${label} must be one of the defined options`);
      return raw;
    }
    case "email": {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw new AppError(400, `${label} must be a valid email`);
      return raw;
    }
    case "url": {
      try { new URL(raw); } catch { throw new AppError(400, `${label} must be a valid URL`); }
      return raw;
    }
    case "phone": {
      if (raw.replace(/\D/g, "").length < 7) throw new AppError(400, `${label} must be a valid phone number`);
      return raw;
    }
    case "text":
    default: {
      if (validation?.minLength != null && raw.length < validation.minLength) {
        throw new AppError(400, `${label} must be at least ${validation.minLength} characters`);
      }
      if (validation?.maxLength != null && raw.length > validation.maxLength) {
        throw new AppError(400, `${label} must be at most ${validation.maxLength} characters`);
      }
      if (validation?.pattern) {
        const re = new RegExp(validation.pattern);
        if (!re.test(raw)) throw new AppError(400, `${label} does not match the required format`);
      }
      return raw;
    }
  }
}

function validateValue(def: CustomFieldDefinitionRow, raw: string | null): string | null {
  if (raw == null || raw === "") {
    if (def.required) throw new AppError(400, `${def.label} is required`);
    return null;
  }
  const validation = parseJson<FieldValidation>(def.validation);
  const options = parseJson<FieldOption[]>(def.options) ?? [];
  return validateTypedValue(def.fieldType as FieldType, validation, options, def.label, raw);
}

// Validate/normalize a definition's defaultValue against its (effective) type +
// rules. An empty/absent default is stored as null; a non-empty default must be
// a VALID value for the field type (e.g. a dropdown default must be a real
// option, a number default must parse) so invalid defaults are rejected early.
function normalizeDefault(
  fieldType: FieldType,
  validation: FieldValidation | null,
  options: FieldOption[],
  raw: unknown,
): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  return validateTypedValue(fieldType, validation, options, "defaultValue", raw);
}

function formatValue(def: CustomFieldDefinitionRow, value: string | null) {
  return {
    definitionId: def.id,
    fieldKey: def.fieldKey,
    label: def.label,
    fieldType: def.fieldType,
    value: value ?? null,
  };
}

// ── Values (shared by contacts + leads) ──────────────────────────────────────

export async function getValues(user: AuthUser, entityType: EntityType, companyId: number, entityId: number) {
  const rows = await repo.valuesForEntity(companyId, entityType, entityId);
  return { values: rows.map((r) => formatValue(r.definition, r.value.value)) };
}

// Set custom-field values for one entity. Validates each value against its
// definition (type + rules) and upserts/clears in a single transaction. The
// caller (contacts/leads service) is responsible for verifying the entity exists
// and is tenant-accessible, and passes its resolved companyId.
export async function setValues(
  user: AuthUser,
  entityType: EntityType,
  companyId: number,
  entityId: number,
  body: { values?: Array<{ definitionId?: unknown; value?: unknown }> },
) {
  const items = Array.isArray(body.values) ? body.values : [];
  const defs = await repo.definitionsForEntityType(companyId, entityType);
  const defById = new Map(defs.map((d) => [d.id, d]));

  const resolved: Array<{ def: CustomFieldDefinitionRow; value: string | null }> = [];
  const seen = new Set<number>();
  for (const item of items) {
    const definitionId = item.definitionId;
    if (typeof definitionId !== "number") throw new AppError(400, "each value requires a numeric definitionId");
    if (seen.has(definitionId)) throw new AppError(400, `duplicate definitionId: ${definitionId}`);
    seen.add(definitionId);
    const def = defById.get(definitionId);
    if (!def) throw new AppError(400, `Invalid definitionId: ${definitionId}`);
    const rawValue = item.value == null ? null : String(item.value);
    resolved.push({ def, value: validateValue(def, rawValue) });
  }

  // For every definition NOT explicitly provided in this payload, look at what is
  // already stored so we can (a) auto-apply a configured default on first set and
  // (b) enforce required fields across the merged (existing + payload + default)
  // state. A field the caller explicitly sends as null is a deliberate clear and
  // is handled above (validateValue 400s if that field is required).
  const existingRows = await repo.valuesForEntity(companyId, entityType, entityId);
  const existingByDefId = new Map(existingRows.map((r) => [r.definition.id, r.value.value]));
  for (const def of defs) {
    if (seen.has(def.id)) continue;
    const existing = existingByDefId.get(def.id) ?? null;
    if (existing != null && existing !== "") continue; // already satisfied; leave untouched
    if (def.defaultValue != null && def.defaultValue !== "") {
      // First-time set with no explicit value: persist the (already-validated) default.
      resolved.push({ def, value: validateValue(def, def.defaultValue) });
    } else if (def.required) {
      throw new AppError(400, `${def.label} is required`);
    }
  }

  await repo.upsertValuesTransaction(companyId, entityType, entityId, resolved);
  return getValues(user, entityType, companyId, entityId);
}
