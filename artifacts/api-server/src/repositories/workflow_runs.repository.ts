import { db, workflowRunsTable, workflowActionRunsTable, usersTable, leadsTable, contactsTable } from "@workspace/db";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { combine, exec, tenantOnly, type Executor } from "./base.js";

// Batch 16 — workflow execution persistence. API reads are tenant-scoped through
// tenantScope; engine reads are keyed by run id and re-verify the tenant of the
// entity before any mutation (see lib/workflows/engine.ts).

export type WorkflowRunRow = typeof workflowRunsTable.$inferSelect;
export type WorkflowRunInsert = typeof workflowRunsTable.$inferInsert;
export type WorkflowActionRunRow = typeof workflowActionRunsTable.$inferSelect;

// ── creation (dispatch) ──────────────────────────────────────────────────────
// Inserts the run and its action rows atomically. The unique index
// (workflow_definition_id, event_key) makes the run insert itself the race-free
// idempotency check: returns undefined when this definition already has a run
// for this event (nothing else is written).
// With an outer `tx` (Batch 16 durability boundary) the run and its action rows
// join the CRM mutation's own transaction — they commit or roll back together.
export async function createRunWithActions(
  run: WorkflowRunInsert,
  actions: Array<{ actionIndex: number; actionType: string }>,
  outerTx?: Executor,
): Promise<WorkflowRunRow | undefined> {
  const create = async (tx: Executor) => {
    const [row] = await tx
      .insert(workflowRunsTable)
      .values(run)
      .onConflictDoNothing({ target: [workflowRunsTable.workflowDefinitionId, workflowRunsTable.eventKey] })
      .returning();
    if (!row) return undefined;
    if (actions.length > 0) {
      await tx.insert(workflowActionRunsTable).values(
        actions.map((a) => ({ runId: row.id, companyId: row.companyId, actionIndex: a.actionIndex, actionType: a.actionType, status: "pending" })),
      );
    }
    return row;
  };
  return outerTx ? create(outerTx) : db.transaction(create);
}

// ── engine reads/writes (by id; tenant re-verified by the engine) ──────────
export async function findRunById(id: number): Promise<WorkflowRunRow | undefined> {
  const [row] = await db.select().from(workflowRunsTable).where(eq(workflowRunsTable.id, id)).limit(1);
  return row;
}

export async function actionsForRun(runId: number): Promise<WorkflowActionRunRow[]> {
  return db.select().from(workflowActionRunsTable).where(eq(workflowActionRunsTable.runId, runId)).orderBy(asc(workflowActionRunsTable.actionIndex));
}

// Short execution lease: succeeds only when the run is still open and no other
// worker currently holds an unexpired lease — so the original job and an
// orphan-recovery re-enqueue can never execute the same run concurrently.
export async function claimRun(id: number, leaseMs: number): Promise<WorkflowRunRow | undefined> {
  const now = new Date();
  const [row] = await db
    .update(workflowRunsTable)
    .set({
      status: "running",
      startedAt: sql`coalesce(${workflowRunsTable.startedAt}, ${now})`,
      lockExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowRunsTable.id, id),
        inArray(workflowRunsTable.status, ["queued", "running"]),
        or(isNull(workflowRunsTable.lockExpiresAt), lt(workflowRunsTable.lockExpiresAt, now)),
      ),
    )
    .returning();
  return row;
}

export async function refreshRunLock(id: number, leaseMs: number): Promise<void> {
  const now = new Date();
  await db.update(workflowRunsTable).set({ lockExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now }).where(eq(workflowRunsTable.id, id));
}

// Releases the lease without finishing (a transient failure hands the run back to
// the queue's retry/backoff).
export async function releaseRunLock(id: number): Promise<void> {
  await db.update(workflowRunsTable).set({ lockExpiresAt: null, updatedAt: new Date() }).where(eq(workflowRunsTable.id, id));
}

export async function finishRun(id: number, status: "completed" | "failed", error: Record<string, unknown> | null): Promise<void> {
  const now = new Date();
  await db
    .update(workflowRunsTable)
    .set({ status, error, completedAt: now, lockExpiresAt: null, updatedAt: now })
    .where(eq(workflowRunsTable.id, id));
}

// `tx` lets an executor commit its side effect and the action's completion in ONE
// transaction (task/follow-up creation), closing the retry-duplication window.
export async function updateActionRun(id: number, data: Partial<typeof workflowActionRunsTable.$inferInsert>, tx?: Executor): Promise<void> {
  await exec(tx).update(workflowActionRunsTable).set({ ...data, updatedAt: new Date() }).where(eq(workflowActionRunsTable.id, id));
}

// ── orphan recovery ─────────────────────────────────────────────────────────
// Runs that are still `queued` after the grace period (the process died between
// persisting the run and enqueueing its job, or the enqueue failed) and runs stuck
// in `running` far longer than any execution lease (worker died and the queue
// exhausted its attempts). Ordered oldest first, bounded per sweep.
export async function listOrphanedRuns(queuedBefore: Date, runningBefore: Date, limit: number): Promise<WorkflowRunRow[]> {
  return db
    .select()
    .from(workflowRunsTable)
    .where(
      or(
        and(eq(workflowRunsTable.status, "queued"), lt(workflowRunsTable.updatedAt, queuedBefore)),
        and(eq(workflowRunsTable.status, "running"), lt(workflowRunsTable.updatedAt, runningBefore)),
      ),
    )
    .orderBy(asc(workflowRunsTable.updatedAt))
    .limit(limit);
}

// A new enqueue generation gives the re-enqueue a fresh queue dedupe key while the
// run row (and its idempotent action state) is reused. Bumping also touches
// updated_at so the same run is not picked up again by the very next sweep.
export async function bumpEnqueueGeneration(id: number): Promise<WorkflowRunRow | undefined> {
  const [row] = await db
    .update(workflowRunsTable)
    .set({ enqueueGeneration: sql`${workflowRunsTable.enqueueGeneration} + 1`, updatedAt: new Date() })
    .where(and(eq(workflowRunsTable.id, id), inArray(workflowRunsTable.status, ["queued", "running"])))
    .returning();
  return row;
}

// ── tenant-scoped API reads ─────────────────────────────────────────────────
export interface ListRunsParams {
  workflowDefinitionId?: number;
  status?: string;
  triggerType?: string;
  entityType?: string;
  entityId?: number;
  limit?: number;
  offset?: number;
}

export async function listForCompany(user: AuthUser, p: ListRunsParams): Promise<{ rows: WorkflowRunRow[]; total: number }> {
  const extra: Array<SQL | undefined> = [];
  if (p.workflowDefinitionId != null) extra.push(eq(workflowRunsTable.workflowDefinitionId, p.workflowDefinitionId));
  if (p.status) extra.push(eq(workflowRunsTable.status, p.status));
  if (p.triggerType) extra.push(eq(workflowRunsTable.triggerType, p.triggerType));
  if (p.entityType) extra.push(eq(workflowRunsTable.entityType, p.entityType));
  if (p.entityId != null) extra.push(eq(workflowRunsTable.entityId, p.entityId));
  const where = tenantOnly(user, workflowRunsTable.companyId, ...extra);
  let q = db.select().from(workflowRunsTable).where(where).orderBy(desc(workflowRunsTable.id)).$dynamic();
  if (p.limit != null) q = q.limit(p.limit);
  if (p.offset) q = q.offset(p.offset);
  const [rows, [{ count }]] = await Promise.all([q, db.select({ count: sql<number>`count(*)::int` }).from(workflowRunsTable).where(where)]);
  return { rows, total: count };
}

export async function findForUser(user: AuthUser, id: number): Promise<WorkflowRunRow | undefined> {
  const [row] = await db
    .select()
    .from(workflowRunsTable)
    .where(tenantOnly(user, workflowRunsTable.companyId, eq(workflowRunsTable.id, id)))
    .limit(1);
  return row;
}

export async function actionSummariesForRuns(runIds: number[]): Promise<Map<number, { total: number; completed: number; skipped: number; failed: number }>> {
  const m = new Map<number, { total: number; completed: number; skipped: number; failed: number }>();
  if (runIds.length === 0) return m;
  const rows = await db
    .select({ runId: workflowActionRunsTable.runId, status: workflowActionRunsTable.status, count: sql<number>`count(*)::int` })
    .from(workflowActionRunsTable)
    .where(inArray(workflowActionRunsTable.runId, runIds))
    .groupBy(workflowActionRunsTable.runId, workflowActionRunsTable.status);
  for (const r of rows) {
    const s = m.get(r.runId) ?? { total: 0, completed: 0, skipped: 0, failed: 0 };
    s.total += r.count;
    if (r.status === "completed") s.completed += r.count;
    else if (r.status === "skipped") s.skipped += r.count;
    else if (r.status === "failed") s.failed += r.count;
    m.set(r.runId, s);
  }
  return m;
}

// ── entity / user loaders used by the engine (always company-pinned) ───────
export async function leadInCompany(companyId: number, id: number) {
  const [row] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, id), eq(leadsTable.companyId, companyId), isNull(leadsTable.deletedAt)))
    .limit(1);
  return row;
}

export async function contactInCompany(companyId: number, id: number) {
  const [row] = await db
    .select()
    .from(contactsTable)
    .where(and(eq(contactsTable.id, id), eq(contactsTable.companyId, companyId), isNull(contactsTable.deletedAt)))
    .limit(1);
  return row;
}

export async function activeUserInCompany(companyId: number, id: number) {
  const [row] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.id, id), eq(usersTable.companyId, companyId), isNull(usersTable.deletedAt), eq(usersTable.isActive, true)))
    .limit(1);
  return row;
}

export async function firstActivePrimaryAdmin(companyId: number) {
  const [row] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.companyId, companyId), eq(usersTable.role, "primary_admin"), isNull(usersTable.deletedAt), eq(usersTable.isActive, true)))
    .orderBy(asc(usersTable.id))
    .limit(1);
  return row;
}

export const _internal = { combine };
