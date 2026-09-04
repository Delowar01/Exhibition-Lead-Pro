import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { parseListQuery } from "../lib/list-query.js";
import { refInCompany } from "../lib/tenant.js";
import * as repo from "../repositories/workflow_definitions.repository.js";
import * as stagesRepo from "../repositories/pipeline_stages.repository.js";
import {
  TRIGGER_TYPES,
  WORKFLOW_LIFECYCLE,
  WORKFLOW_LIMITS,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_STATUSES,
  describeCatalog,
  type WorkflowStatus,
} from "../lib/workflows/catalog.js";
import {
  collectTenantRefs,
  validateDefinitionSpec,
  type WorkflowDefinitionSpec,
  type WorkflowValidationIssue,
} from "../lib/workflows/definition.js";

// =============================================================================
// Workflow definitions service (Batch 15). Definition MANAGEMENT only.
// =============================================================================
// This service creates, reads, updates, validates and transitions definitions.
// It never executes one: no CRM mutation, no event subscription, no job
// enqueue, no scheduler, no email/notification, no AI call happens here or as
// a consequence of any state change. Execution is Batch 16.

// 400 carrying the structured validation issues (rendered as the standard
// `details: [{ field, message }]` envelope by the workflows router).
export class WorkflowValidationError extends AppError {
  readonly issues: WorkflowValidationIssue[];
  constructor(issues: WorkflowValidationIssue[]) {
    super(400, "Workflow definition is invalid", { code: "WORKFLOW_INVALID" });
    this.issues = issues;
    Object.setPrototypeOf(this, WorkflowValidationError.prototype);
  }
}

export interface DefinitionInput {
  name?: unknown;
  description?: unknown;
  trigger?: unknown;
  conditions?: unknown;
  actions?: unknown;
  revision?: unknown;
}

export function formatDefinition(row: repo.WorkflowDefinitionRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description ?? null,
    status: row.status as WorkflowStatus,
    trigger: row.trigger,
    conditions: row.conditions,
    actions: row.actions,
    schemaVersion: row.schemaVersion,
    revision: row.revision,
    createdById: row.createdById ?? null,
    updatedById: row.updatedById ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}
export type FormattedDefinition = ReturnType<typeof formatDefinition>;

// ── input readers (issues, never throws) ────────────────────────────────────
function readName(value: unknown, issues: WorkflowValidationIssue[]): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ path: "name", message: "name is required", code: "WORKFLOW_INVALID_NAME" });
    return undefined;
  }
  const name = value.trim();
  if (name.length > WORKFLOW_LIMITS.nameMaxLength) {
    issues.push({ path: "name", message: `name must be at most ${WORKFLOW_LIMITS.nameMaxLength} characters`, code: "WORKFLOW_INVALID_NAME" });
    return undefined;
  }
  return name;
}

function readDescription(value: unknown, issues: WorkflowValidationIssue[]): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") {
    issues.push({ path: "description", message: "description must be a string", code: "WORKFLOW_INVALID_DESCRIPTION" });
    return undefined;
  }
  const d = value.trim();
  if (d.length > WORKFLOW_LIMITS.descriptionMaxLength) {
    issues.push({ path: "description", message: `description must be at most ${WORKFLOW_LIMITS.descriptionMaxLength} characters`, code: "WORKFLOW_INVALID_DESCRIPTION" });
    return undefined;
  }
  return d === "" ? null : d;
}

// The caller's view of the definition's current revision (JSON body `revision` on
// PATCH, publish, unpublish, archive and DELETE alike).
function readRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new AppError(400, "revision is required (the definition's current revision)", { code: "WORKFLOW_REVISION_REQUIRED" });
  }
  return value;
}

function specInput(body: DefinitionInput, fallback?: repo.WorkflowDefinitionRow): Record<string, unknown> {
  return {
    trigger: body.trigger !== undefined ? body.trigger : fallback?.trigger,
    conditions: body.conditions !== undefined ? body.conditions : (fallback?.conditions ?? []),
    actions: body.actions !== undefined ? body.actions : (fallback?.actions ?? []),
  };
}

// ── tenant reference validation (the only I/O part of validation) ───────────
const REF_LABELS = { users: "user", tags: "tag", teams: "team", events: "event", organizations: "organization" } as const;

async function tenantRefIssues(companyId: number, spec: WorkflowDefinitionSpec): Promise<WorkflowValidationIssue[]> {
  const issues: WorkflowValidationIssue[] = [];
  for (const ref of collectTenantRefs(spec)) {
    if (ref.kind === "stageKey") {
      const stage = await stagesRepo.findByKey(companyId, ref.key);
      if (!stage) issues.push({ path: ref.path, message: `Pipeline stage "${ref.key}" does not exist in this company`, code: "WORKFLOW_UNKNOWN_STAGE" });
      continue;
    }
    // Target-tenant scoped on purpose: the reference must belong to the
    // definition's company, not merely to a company the caller can access.
    const ok = await refInCompany(ref.table, companyId, ref.id);
    if (!ok) issues.push({ path: ref.path, message: `Referenced ${REF_LABELS[ref.table]} #${ref.id} does not exist in this company`, code: "WORKFLOW_UNKNOWN_REFERENCE" });
  }
  return issues;
}

type SpecResult = { ok: true; spec: WorkflowDefinitionSpec } | { ok: false; issues: WorkflowValidationIssue[] };

async function validateSpecForCompany(companyId: number, input: unknown): Promise<SpecResult> {
  const r = validateDefinitionSpec(input);
  if (!r.ok) return r;
  const refIssues = await tenantRefIssues(companyId, r.spec);
  if (refIssues.length > 0) return { ok: false, issues: refIssues };
  return { ok: true, spec: r.spec };
}

async function mustFind(user: AuthUser, id: number): Promise<repo.WorkflowDefinitionRow> {
  if (!Number.isInteger(id) || id < 1) throw new AppError(404, "Workflow definition not found");
  const row = await repo.findById(user, id);
  if (!row) throw new AppError(404, "Workflow definition not found");
  return row;
}

function revisionConflict(current: number): AppError {
  return new AppError(409, "Workflow definition was modified by someone else; reload and retry with the current revision", {
    code: "WORKFLOW_REVISION_CONFLICT",
    details: { currentRevision: current },
  });
}

function assertRevision(row: repo.WorkflowDefinitionRow, expected: number): void {
  if (row.revision !== expected) throw revisionConflict(row.revision);
}

// Only drafts are editable. A PUBLISHED definition is immutable (unpublish → edit →
// publish again is the only path), and an archived one is terminal history.
function assertEditable(row: repo.WorkflowDefinitionRow): void {
  const status = row.status as WorkflowStatus;
  if (!WORKFLOW_LIFECYCLE[status].editable) {
    const article = status === "archived" ? "An" : "A";
    throw new AppError(409, `${article} ${status} workflow definition is read-only${status === "published" ? " — unpublish it to edit" : ""}`, {
      code: "WORKFLOW_READ_ONLY",
      details: { status },
    });
  }
}

function companyOf(user: AuthUser): number {
  if (!user.companyId) throw new AppError(400, "No company context");
  return user.companyId;
}

// ── catalog ─────────────────────────────────────────────────────────────────
export function getCatalog() {
  return describeCatalog();
}

// ── reads ───────────────────────────────────────────────────────────────────
const SORTS = ["name", "createdAt", "updatedAt", "status"] as const;

export async function listDefinitions(user: AuthUser, query: Record<string, unknown>) {
  const lq = parseListQuery(query, { defaultPageSize: 25, maxPageSize: 100, allowedSort: [...SORTS], defaultSort: "updatedAt" });
  const status = query.status == null || query.status === "" ? undefined : String(query.status);
  if (status !== undefined && !(WORKFLOW_STATUSES as readonly string[]).includes(status)) {
    throw new AppError(400, `Invalid status filter; expected one of ${WORKFLOW_STATUSES.join(", ")}`);
  }
  const triggerType = query.triggerType == null || query.triggerType === "" ? undefined : String(query.triggerType);
  if (triggerType !== undefined && !(TRIGGER_TYPES as readonly string[]).includes(triggerType)) {
    throw new AppError(400, "Invalid triggerType filter");
  }
  const includeArchived = query.includeArchived === true || String(query.includeArchived) === "true";
  const { rows, total } = await repo.list(user, {
    status,
    includeArchived,
    triggerType,
    search: lq.search,
    sort: (lq.sort ?? "updatedAt") as (typeof SORTS)[number],
    order: lq.order,
    limit: lq.paginated ? lq.limit : undefined,
    offset: lq.paginated ? lq.offset : 0,
  });
  return { items: rows.map(formatDefinition), total, page: lq.page, pageSize: lq.pageSize };
}

export async function getDefinition(user: AuthUser, id: number) {
  return formatDefinition(await mustFind(user, id));
}

// ── validation without persistence ──────────────────────────────────────────
function validationResult(issues: WorkflowValidationIssue[], spec: WorkflowDefinitionSpec | undefined) {
  const valid = issues.length === 0;
  return {
    valid,
    publishable: valid && (spec?.actions.length ?? 0) > 0,
    errors: issues.map((i) => ({ field: i.path, message: i.message, code: i.code })),
    normalized: valid && spec ? spec : null,
  };
}

// POST /workflows/validate — validates a candidate body for the caller's company.
export async function validateDefinitionBody(user: AuthUser, body: DefinitionInput) {
  const companyId = companyOf(user);
  const issues: WorkflowValidationIssue[] = [];
  if (body.name !== undefined) readName(body.name, issues);
  if (body.description !== undefined) readDescription(body.description, issues);
  const v = await validateSpecForCompany(companyId, specInput(body));
  if (!v.ok) issues.push(...v.issues);
  return validationResult(issues, v.ok ? v.spec : undefined);
}

// POST /workflows/{id}/validate — re-validates a STORED definition (references may
// have been deleted since it was saved). 404 across tenants like every read.
export async function validateStoredDefinition(user: AuthUser, id: number) {
  const row = await mustFind(user, id);
  const v = await validateSpecForCompany(row.companyId, { trigger: row.trigger, conditions: row.conditions, actions: row.actions });
  return { id: row.id, revision: row.revision, status: row.status as WorkflowStatus, ...validationResult(v.ok ? [] : v.issues, v.ok ? v.spec : undefined) };
}

// ── writes ──────────────────────────────────────────────────────────────────
export async function createDefinition(user: AuthUser, body: DefinitionInput) {
  const companyId = companyOf(user);
  const issues: WorkflowValidationIssue[] = [];
  const name = readName(body.name, issues);
  const description = body.description === undefined ? null : readDescription(body.description, issues);
  const v = await validateSpecForCompany(companyId, specInput(body));
  if (!v.ok) issues.push(...v.issues);
  if (issues.length > 0 || !v.ok || name === undefined) throw new WorkflowValidationError(issues);

  if (await repo.findActiveByName(companyId, name)) {
    throw new AppError(409, "A workflow definition with this name already exists", { code: "WORKFLOW_NAME_TAKEN" });
  }
  const row = await repo.insert({
    companyId,
    name,
    description: description ?? null,
    status: "draft",
    triggerType: v.spec.trigger.type,
    trigger: v.spec.trigger as unknown as Record<string, unknown>,
    conditions: v.spec.conditions,
    actions: v.spec.actions,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    revision: 1,
    createdById: user.id,
    updatedById: user.id,
  });
  return formatDefinition(row);
}

export async function updateDefinition(user: AuthUser, id: number, body: DefinitionInput) {
  const row = await mustFind(user, id);
  assertEditable(row);
  const expected = readRevision(body.revision);
  assertRevision(row, expected);

  const issues: WorkflowValidationIssue[] = [];
  const data: Partial<repo.WorkflowDefinitionInsert> = {};
  if (body.name !== undefined) {
    const name = readName(body.name, issues);
    if (name !== undefined) data.name = name;
  }
  if (body.description !== undefined) {
    const d = readDescription(body.description, issues);
    if (d !== undefined) data.description = d;
  }
  if (body.trigger !== undefined || body.conditions !== undefined || body.actions !== undefined) {
    const v = await validateSpecForCompany(row.companyId, specInput(body, row));
    if (!v.ok) issues.push(...v.issues);
    else {
      data.trigger = v.spec.trigger as unknown as Record<string, unknown>;
      data.triggerType = v.spec.trigger.type;
      data.conditions = v.spec.conditions;
      data.actions = v.spec.actions;
    }
  }
  if (issues.length > 0) throw new WorkflowValidationError(issues);
  if (Object.keys(data).length === 0) throw new AppError(400, "No valid fields to update");
  if (data.name && (await repo.findActiveByName(row.companyId, data.name, row.id))) {
    throw new AppError(409, "A workflow definition with this name already exists", { code: "WORKFLOW_NAME_TAKEN" });
  }
  data.updatedById = user.id;
  const updated = await repo.updateIfRevision(row.companyId, row.id, expected, data);
  if (!updated) {
    const fresh = await repo.findById(user, id);
    throw fresh ? revisionConflict(fresh.revision) : new AppError(404, "Workflow definition not found");
  }
  return formatDefinition(updated);
}

// Lifecycle transitions (definition management only — NO state executes):
//   publish   draft → published   (gate: fully valid definition with ≥ 1 action)
//   unpublish published → draft
//   archive   draft|published → archived (terminal)
const TRANSITION_VERBS: Record<WorkflowStatus, string> = { published: "publish", draft: "unpublish", archived: "archive" };

export async function transitionDefinition(user: AuthUser, id: number, target: WorkflowStatus, body: DefinitionInput) {
  const row = await mustFind(user, id);
  const current = row.status as WorkflowStatus;
  const verb = TRANSITION_VERBS[target];
  if (current === target) {
    throw new AppError(409, `Workflow definition is already ${target}`, { code: "WORKFLOW_INVALID_TRANSITION", details: { status: current } });
  }
  if (!WORKFLOW_LIFECYCLE[current].transitions.includes(target)) {
    throw new AppError(409, `Cannot ${verb} an ${current} workflow definition`, {
      code: "WORKFLOW_INVALID_TRANSITION",
      details: { status: current, allowed: [...WORKFLOW_LIFECYCLE[current].transitions] },
    });
  }
  const expected = readRevision(body.revision);
  assertRevision(row, expected);

  if (target === "published") {
    const v = await validateSpecForCompany(row.companyId, { trigger: row.trigger, conditions: row.conditions, actions: row.actions });
    const issues = v.ok ? [] : v.issues;
    if (v.ok && v.spec.actions.length === 0) {
      issues.push({ path: "actions", message: "At least one action is required to publish", code: "WORKFLOW_NO_ACTIONS" });
    }
    if (issues.length > 0) throw new WorkflowValidationError(issues);
  }

  const updated = await repo.updateIfRevision(row.companyId, row.id, expected, {
    status: target,
    archivedAt: target === "archived" ? new Date() : null,
    updatedById: user.id,
  });
  if (!updated) {
    const fresh = await repo.findById(user, id);
    throw fresh ? revisionConflict(fresh.revision) : new AppError(404, "Workflow definition not found");
  }
  return { definition: formatDefinition(updated), from: current };
}

function notDeletable(status: string): AppError {
  return new AppError(409, "Only draft workflow definitions can be deleted; archive it instead", {
    code: "WORKFLOW_NOT_DELETABLE",
    details: { status },
  });
}

// Hard delete is reserved for drafts; anything else is history and must be archived.
// Revision-safe like every other mutation: the caller must pass the definition's
// current revision (JSON body { revision }) and the repository delete is atomic on
// id + company + status=draft + revision, so a stale client can never delete a draft
// someone else has updated in the meantime.
export async function deleteDefinition(user: AuthUser, id: number, revisionParam: unknown) {
  const row = await mustFind(user, id);
  if (row.status !== "draft") throw notDeletable(row.status);
  const expected = readRevision(revisionParam);
  assertRevision(row, expected);
  const deleted = await repo.deleteDraftIfRevision(row.companyId, row.id, expected);
  if (!deleted) {
    // Lost a race between the read and the conditional delete: report the current state.
    const fresh = await repo.findById(user, id);
    if (!fresh) throw new AppError(404, "Workflow definition not found");
    if (fresh.status !== "draft") throw notDeletable(fresh.status);
    throw revisionConflict(fresh.revision);
  }
  return { success: true, message: "Workflow definition deleted", name: deleted.name, revision: deleted.revision };
}
