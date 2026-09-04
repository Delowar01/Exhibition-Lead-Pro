import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { parseListQuery } from "../lib/list-query.js";
import { TRIGGER_TYPES, WORKFLOW_ENTITIES } from "../lib/workflows/catalog.js";
import * as repo from "../repositories/workflow_runs.repository.js";

// Batch 16 — read-only, tenant-scoped run history for the Batch 17 UI. No
// execute / run-now / replay / retry: automatic JobQueue retries are the only
// re-execution path in this batch.

export const RUN_STATUSES = ["queued", "running", "completed", "failed"] as const;

export function formatRun(row: repo.WorkflowRunRow, summary?: { total: number; completed: number; skipped: number; failed: number }) {
  const snapshot = (row.definitionSnapshot ?? {}) as { name?: unknown };
  return {
    id: row.id,
    companyId: row.companyId,
    workflowDefinitionId: row.workflowDefinitionId ?? null,
    workflowName: typeof snapshot.name === "string" ? snapshot.name : null,
    definitionRevision: row.definitionRevision,
    triggerType: row.triggerType,
    entityType: row.entityType,
    entityId: row.entityId,
    actorUserId: row.actorUserId ?? null,
    eventKey: row.eventKey,
    status: row.status,
    error: row.error ?? null,
    enqueueGeneration: row.enqueueGeneration,
    actionSummary: summary ?? { total: 0, completed: 0, skipped: 0, failed: 0 },
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function formatActionRun(row: repo.WorkflowActionRunRow) {
  return {
    id: row.id,
    actionIndex: row.actionIndex,
    actionType: row.actionType,
    status: row.status,
    attempts: row.attempts,
    error: row.error ?? null,
    result: row.result ?? null,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

function optInt(v: unknown, name: string): number | undefined {
  if (v == null || v === "") return undefined;
  const n = parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < 1) throw new AppError(400, `Invalid ${name} filter`);
  return n;
}

export async function listRuns(user: AuthUser, query: Record<string, unknown>) {
  const lq = parseListQuery(query, { defaultPageSize: 25, maxPageSize: 100 });
  const status = query.status == null || query.status === "" ? undefined : String(query.status);
  if (status !== undefined && !(RUN_STATUSES as readonly string[]).includes(status)) throw new AppError(400, `Invalid status filter; expected one of ${RUN_STATUSES.join(", ")}`);
  const triggerType = query.triggerType == null || query.triggerType === "" ? undefined : String(query.triggerType);
  if (triggerType !== undefined && !(TRIGGER_TYPES as readonly string[]).includes(triggerType)) throw new AppError(400, "Invalid triggerType filter");
  const entityType = query.entityType == null || query.entityType === "" ? undefined : String(query.entityType);
  if (entityType !== undefined && !(WORKFLOW_ENTITIES as readonly string[]).includes(entityType)) throw new AppError(400, "Invalid entityType filter");
  const { rows, total } = await repo.listForCompany(user, {
    workflowDefinitionId: optInt(query.workflowDefinitionId, "workflowDefinitionId"),
    status,
    triggerType,
    entityType,
    entityId: optInt(query.entityId, "entityId"),
    limit: lq.paginated ? lq.limit : undefined,
    offset: lq.paginated ? lq.offset : 0,
  });
  const summaries = await repo.actionSummariesForRuns(rows.map((r) => r.id));
  return { items: rows.map((r) => formatRun(r, summaries.get(r.id))), total, page: lq.page, pageSize: lq.pageSize };
}

export async function getRun(user: AuthUser, id: number) {
  if (!Number.isInteger(id) || id < 1) throw new AppError(404, "Workflow run not found");
  const row = await repo.findForUser(user, id);
  if (!row) throw new AppError(404, "Workflow run not found");
  const actions = await repo.actionsForRun(row.id);
  const summary = { total: actions.length, completed: 0, skipped: 0, failed: 0 };
  for (const a of actions) {
    if (a.status === "completed") summary.completed++;
    else if (a.status === "skipped") summary.skipped++;
    else if (a.status === "failed") summary.failed++;
  }
  return { ...formatRun(row, summary), actions: actions.map(formatActionRun) };
}
