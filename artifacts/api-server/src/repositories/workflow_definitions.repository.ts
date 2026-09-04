import { db, workflowDefinitionsTable } from "@workspace/db";
import { and, asc, desc, eq, ilike, ne, sql, type SQL } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { combine, tenantOnly } from "./base.js";

// Batch 15 — workflow definition persistence. Every read is tenant-scoped through
// tenantScope (never by a caller-supplied companyId); writes are keyed by id AND
// company id so a row can never be updated across the tenant boundary even if a
// service-level check were bypassed.

export type WorkflowDefinitionRow = typeof workflowDefinitionsTable.$inferSelect;
export type WorkflowDefinitionInsert = typeof workflowDefinitionsTable.$inferInsert;

export interface ListParams {
  status?: string;
  includeArchived?: boolean;
  triggerType?: string;
  search?: string;
  sort: "name" | "createdAt" | "updatedAt" | "status";
  order: "asc" | "desc";
  limit?: number;
  offset?: number;
}

const SORT_COLUMNS = {
  name: workflowDefinitionsTable.name,
  createdAt: workflowDefinitionsTable.createdAt,
  updatedAt: workflowDefinitionsTable.updatedAt,
  status: workflowDefinitionsTable.status,
} as const;

function listWhere(user: AuthUser, p: ListParams): SQL | undefined {
  const extra: Array<SQL | undefined> = [];
  if (p.status) extra.push(eq(workflowDefinitionsTable.status, p.status));
  else if (!p.includeArchived) extra.push(ne(workflowDefinitionsTable.status, "archived"));
  if (p.triggerType) extra.push(eq(workflowDefinitionsTable.triggerType, p.triggerType));
  if (p.search) extra.push(ilike(workflowDefinitionsTable.name, `%${p.search.replace(/[%_\\]/g, "\\$&")}%`));
  return tenantOnly(user, workflowDefinitionsTable.companyId, ...extra);
}

export async function list(user: AuthUser, p: ListParams): Promise<{ rows: WorkflowDefinitionRow[]; total: number }> {
  const where = listWhere(user, p);
  const col = SORT_COLUMNS[p.sort];
  const orderBy = p.order === "asc" ? asc(col) : desc(col);
  let q = db.select().from(workflowDefinitionsTable).where(where).orderBy(orderBy, asc(workflowDefinitionsTable.id)).$dynamic();
  if (p.limit != null) q = q.limit(p.limit);
  if (p.offset) q = q.offset(p.offset);
  const [rows, [{ count }]] = await Promise.all([
    q,
    db.select({ count: sql<number>`count(*)::int` }).from(workflowDefinitionsTable).where(where),
  ]);
  return { rows, total: count };
}

export async function findById(user: AuthUser, id: number): Promise<WorkflowDefinitionRow | undefined> {
  const [row] = await db
    .select()
    .from(workflowDefinitionsTable)
    .where(tenantOnly(user, workflowDefinitionsTable.companyId, eq(workflowDefinitionsTable.id, id)))
    .limit(1);
  return row;
}

// Name uniqueness among NON-archived definitions of one company.
export async function findActiveByName(companyId: number, name: string, excludeId?: number): Promise<WorkflowDefinitionRow | undefined> {
  const [row] = await db
    .select()
    .from(workflowDefinitionsTable)
    .where(
      combine(
        eq(workflowDefinitionsTable.companyId, companyId),
        sql`lower(${workflowDefinitionsTable.name}) = lower(${name})`,
        ne(workflowDefinitionsTable.status, "archived"),
        excludeId != null ? ne(workflowDefinitionsTable.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  return row;
}

export async function insert(values: WorkflowDefinitionInsert): Promise<WorkflowDefinitionRow> {
  const [row] = await db.insert(workflowDefinitionsTable).values(values).returning();
  return row;
}

// Optimistic-concurrency write: only applies when the stored revision still equals
// `expectedRevision` (and the row is in this company), bumping the revision. Returns
// undefined when the row moved on — the service turns that into a 409.
export async function updateIfRevision(
  companyId: number,
  id: number,
  expectedRevision: number,
  data: Partial<WorkflowDefinitionInsert>,
): Promise<WorkflowDefinitionRow | undefined> {
  const [row] = await db
    .update(workflowDefinitionsTable)
    .set({ ...data, revision: expectedRevision + 1, updatedAt: new Date() })
    .where(
      and(
        eq(workflowDefinitionsTable.id, id),
        eq(workflowDefinitionsTable.companyId, companyId),
        eq(workflowDefinitionsTable.revision, expectedRevision),
      ),
    )
    .returning();
  return row;
}

// Optimistic-concurrency delete (drafts only): the single DELETE statement is
// conditioned on id AND company AND status = draft AND revision = expected, so a
// stale client can never remove a draft that someone else has since updated (or
// published) — the service never relies on a prior read followed by an
// unconditional delete. Returns the deleted row, or undefined when no row matched.
export async function deleteDraftIfRevision(companyId: number, id: number, expectedRevision: number): Promise<WorkflowDefinitionRow | undefined> {
  const [row] = await db
    .delete(workflowDefinitionsTable)
    .where(
      and(
        eq(workflowDefinitionsTable.id, id),
        eq(workflowDefinitionsTable.companyId, companyId),
        eq(workflowDefinitionsTable.status, "draft"),
        eq(workflowDefinitionsTable.revision, expectedRevision),
      ),
    )
    .returning();
  return row;
}

// Engine lookup (Batch 16): the PUBLISHED definitions of one company for one
// trigger type. Draft and archived definitions are never eligible. Keyed by the
// company of the CRM record that changed — never by a caller-supplied id.
export async function listPublishedForTrigger(companyId: number, triggerType: string): Promise<WorkflowDefinitionRow[]> {
  return db
    .select()
    .from(workflowDefinitionsTable)
    .where(
      and(
        eq(workflowDefinitionsTable.companyId, companyId),
        eq(workflowDefinitionsTable.status, "published"),
        eq(workflowDefinitionsTable.triggerType, triggerType),
      ),
    )
    .orderBy(asc(workflowDefinitionsTable.id));
}
