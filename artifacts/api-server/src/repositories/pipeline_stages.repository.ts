import { db, pipelineStagesTable, leadsTable } from "@workspace/db";
import { eq, and, asc, count, inArray } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, notDeleted, exec, type Executor } from "./base.js";

export type PipelineStageRow = typeof pipelineStagesTable.$inferSelect;

// Seeded per company on first access (lazy) and on company creation. Keys match
// the legacy leads.stage text values so pre-existing leads map cleanly.
export const DEFAULT_STAGES: Array<{ key: string; name: string; sortOrder: number; isWon: boolean; isLost: boolean; color: string }> = [
  { key: "prospect", name: "Prospect", sortOrder: 0, isWon: false, isLost: false, color: "#94a3b8" },
  { key: "qualified", name: "Qualified", sortOrder: 1, isWon: false, isLost: false, color: "#38bdf8" },
  { key: "proposal_sent", name: "Proposal Sent", sortOrder: 2, isWon: false, isLost: false, color: "#a78bfa" },
  { key: "negotiation", name: "Negotiation", sortOrder: 3, isWon: false, isLost: false, color: "#fbbf24" },
  { key: "won", name: "Won", sortOrder: 4, isWon: true, isLost: false, color: "#22c55e" },
  { key: "lost", name: "Lost", sortOrder: 5, isWon: false, isLost: true, color: "#ef4444" },
];

export async function countForCompany(companyId: number, tx?: Executor): Promise<number> {
  const [row] = await exec(tx)
    .select({ total: count() })
    .from(pipelineStagesTable)
    .where(and(eq(pipelineStagesTable.companyId, companyId), notDeleted(pipelineStagesTable.deletedAt)));
  return row?.total ?? 0;
}

export async function insertMany(rows: Array<typeof pipelineStagesTable.$inferInsert>, tx?: Executor): Promise<void> {
  if (rows.length === 0) return;
  await exec(tx).insert(pipelineStagesTable).values(rows);
}

// Configured stage flags for one company (companyId-scoped read; used by the
// import pipeline where queries are keyed by the already-authorized company).
export async function stageFlagsByCompany(companyId: number): Promise<Array<{ key: string; isWon: boolean; isLost: boolean }>> {
  return db
    .select({ key: pipelineStagesTable.key, isWon: pipelineStagesTable.isWon, isLost: pipelineStagesTable.isLost })
    .from(pipelineStagesTable)
    .where(and(eq(pipelineStagesTable.companyId, companyId), notDeleted(pipelineStagesTable.deletedAt)));
}

export async function listForCompany(user: AuthUser): Promise<PipelineStageRow[]> {
  const where = activeScope(user, pipelineStagesTable.companyId, pipelineStagesTable.deletedAt);
  return db.select().from(pipelineStagesTable).where(where).orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id));
}

export async function findById(user: AuthUser, id: number): Promise<PipelineStageRow | undefined> {
  const where = activeScope(user, pipelineStagesTable.companyId, pipelineStagesTable.deletedAt, { extra: [eq(pipelineStagesTable.id, id)] });
  const [row] = await db.select().from(pipelineStagesTable).where(where).limit(1);
  return row;
}

export async function findByKey(companyId: number, key: string): Promise<PipelineStageRow | undefined> {
  const [row] = await db
    .select()
    .from(pipelineStagesTable)
    .where(and(eq(pipelineStagesTable.companyId, companyId), eq(pipelineStagesTable.key, key), notDeleted(pipelineStagesTable.deletedAt)))
    .limit(1);
  return row;
}

export async function findByNameActive(companyId: number, name: string): Promise<PipelineStageRow | undefined> {
  const [row] = await db
    .select()
    .from(pipelineStagesTable)
    .where(and(eq(pipelineStagesTable.companyId, companyId), eq(pipelineStagesTable.name, name), notDeleted(pipelineStagesTable.deletedAt)))
    .limit(1);
  return row;
}

export async function maxSortOrder(companyId: number): Promise<number> {
  const rows = await db
    .select({ sortOrder: pipelineStagesTable.sortOrder })
    .from(pipelineStagesTable)
    .where(and(eq(pipelineStagesTable.companyId, companyId), notDeleted(pipelineStagesTable.deletedAt)));
  return rows.reduce((m, r) => Math.max(m, r.sortOrder), -1);
}

export async function insert(values: typeof pipelineStagesTable.$inferInsert): Promise<PipelineStageRow> {
  const [row] = await db.insert(pipelineStagesTable).values(values).returning();
  return row;
}

export async function update(id: number, data: Partial<typeof pipelineStagesTable.$inferInsert>): Promise<PipelineStageRow | undefined> {
  const [row] = await db.update(pipelineStagesTable).set({ ...data, updatedAt: new Date() }).where(eq(pipelineStagesTable.id, id)).returning();
  return row;
}

export async function reorder(companyId: number, order: Array<{ id: number; sortOrder: number }>): Promise<void> {
  await db.transaction(async (tx) => {
    for (const o of order) {
      await tx
        .update(pipelineStagesTable)
        .set({ sortOrder: o.sortOrder, updatedAt: new Date() })
        .where(and(eq(pipelineStagesTable.id, o.id), eq(pipelineStagesTable.companyId, companyId)));
    }
  });
}

// Soft-delete the stage and detach it from any leads in the same company (the
// legacy text `stage` on those leads is left intact for backward compatibility).
export async function softDelete(companyId: number, id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(leadsTable).set({ stageId: null }).where(and(eq(leadsTable.companyId, companyId), eq(leadsTable.stageId, id)));
    await tx.update(pipelineStagesTable).set({ deletedAt: new Date() }).where(eq(pipelineStagesTable.id, id));
  });
}

export async function leadCountsByStageId(companyId: number): Promise<Map<number, number>> {
  const rows = await db
    .select({ stageId: leadsTable.stageId, total: count() })
    .from(leadsTable)
    .where(and(eq(leadsTable.companyId, companyId), notDeleted(leadsTable.deletedAt)))
    .groupBy(leadsTable.stageId);
  const m = new Map<number, number>();
  for (const r of rows) if (r.stageId != null) m.set(r.stageId, r.total);
  return m;
}
