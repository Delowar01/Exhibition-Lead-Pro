import { db, aiSettingsTable, aiInvocationsTable, companiesTable } from "@workspace/db";
import type { AiSettings, InsertAiInvocation } from "@workspace/db";
import { and, eq, gte, lte, desc, count, sql, type SQL } from "drizzle-orm";
import { tenantScope, type AuthUser } from "../middlewares/requireAuth.js";
import { combine } from "./base.js";

// Data access for Stage 5.0 AI Platform Foundation: per-tenant ai_settings (get +
// upsert) and the append-only ai_invocations ledger (insert + aggregation). All
// tenant-facing aggregations are wrapped in tenantScope; only the platform-owner
// aggregations bypass it (by design, cross-tenant).

export async function getSettingsByCompany(companyId: number): Promise<AiSettings | undefined> {
  const [row] = await db.select().from(aiSettingsTable).where(eq(aiSettingsTable.companyId, companyId)).limit(1);
  return row;
}

export async function upsertSettings(
  companyId: number,
  values: Partial<typeof aiSettingsTable.$inferInsert>,
): Promise<AiSettings> {
  const [row] = await db
    .insert(aiSettingsTable)
    .values({ companyId, ...values })
    .onConflictDoUpdate({
      target: aiSettingsTable.companyId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  return row;
}

export async function insertInvocation(values: InsertAiInvocation): Promise<void> {
  await db.insert(aiInvocationsTable).values(values);
}

// Current-month usage totals for a specific company — used by the budget gate. This
// is an internal check for a KNOWN company id (not a request-scoped tenant read), so a
// direct companyId equality filter is correct here.
export async function monthUsage(
  companyId: number,
  from: Date,
): Promise<{ totalTokens: number; costMicroUsd: number }> {
  const [row] = await db
    .select({
      totalTokens: sql<number>`coalesce(sum(${aiInvocationsTable.totalTokens}),0)`,
      costMicroUsd: sql<number>`coalesce(sum(${aiInvocationsTable.estimatedCostMicroUsd}),0)`,
    })
    .from(aiInvocationsTable)
    .where(and(eq(aiInvocationsTable.companyId, companyId), gte(aiInvocationsTable.createdAt, from)));
  return { totalTokens: Number(row?.totalTokens ?? 0), costMicroUsd: Number(row?.costMicroUsd ?? 0) };
}

// Builds the WHERE for usage aggregation. Tenant queries are tenantScope-restricted;
// platform=true bypasses tenant scope for cross-tenant platform-owner aggregates.
function usageWhere(user: AuthUser | undefined, from: Date, to: Date, platform: boolean): SQL | undefined {
  const conds: Array<SQL | undefined> = [
    gte(aiInvocationsTable.createdAt, from),
    lte(aiInvocationsTable.createdAt, to),
  ];
  if (!platform) conds.push(tenantScope(user, aiInvocationsTable.companyId));
  return combine(...conds);
}

const AGG = {
  requests: count(),
  success: sql<number>`coalesce(sum(case when ${aiInvocationsTable.status} = 'success' then 1 else 0 end),0)`,
  errors: sql<number>`coalesce(sum(case when ${aiInvocationsTable.status} <> 'success' then 1 else 0 end),0)`,
  inputTokens: sql<number>`coalesce(sum(${aiInvocationsTable.inputTokens}),0)`,
  outputTokens: sql<number>`coalesce(sum(${aiInvocationsTable.outputTokens}),0)`,
  totalTokens: sql<number>`coalesce(sum(${aiInvocationsTable.totalTokens}),0)`,
  costMicroUsd: sql<number>`coalesce(sum(${aiInvocationsTable.estimatedCostMicroUsd}),0)`,
  avgLatencyMs: sql<number>`coalesce(avg(${aiInvocationsTable.latencyMs}),0)`,
};

export interface RawAgg {
  requests: number;
  success: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicroUsd: number;
  avgLatencyMs: number;
}

export async function usageTotals(
  user: AuthUser | undefined,
  from: Date,
  to: Date,
  platform: boolean,
): Promise<RawAgg> {
  const [row] = await db.select(AGG).from(aiInvocationsTable).where(usageWhere(user, from, to, platform));
  return normalizeAgg(row);
}

export async function usageByFeature(
  user: AuthUser | undefined,
  from: Date,
  to: Date,
  platform: boolean,
): Promise<Array<RawAgg & { feature: string }>> {
  const rows = await db
    .select({ feature: aiInvocationsTable.feature, ...AGG })
    .from(aiInvocationsTable)
    .where(usageWhere(user, from, to, platform))
    .groupBy(aiInvocationsTable.feature);
  return rows.map((r) => ({ feature: r.feature, ...normalizeAgg(r) }));
}

export async function usageByCompany(
  from: Date,
  to: Date,
): Promise<Array<RawAgg & { companyId: number | null; companyName: string | null }>> {
  const rows = await db
    .select({ companyId: aiInvocationsTable.companyId, companyName: companiesTable.name, ...AGG })
    .from(aiInvocationsTable)
    .leftJoin(companiesTable, eq(aiInvocationsTable.companyId, companiesTable.id))
    .where(usageWhere(undefined, from, to, true))
    .groupBy(aiInvocationsTable.companyId, companiesTable.name)
    .orderBy(desc(sql`coalesce(sum(${aiInvocationsTable.estimatedCostMicroUsd}),0)`));
  return rows.map((r) => ({ companyId: r.companyId, companyName: r.companyName, ...normalizeAgg(r) }));
}

export interface RecentInvocation {
  id: number;
  feature: string;
  status: string;
  model: string;
  totalTokens: number;
  estimatedCostMicroUsd: number;
  latencyMs: number;
  confidence: number | null;
  userId: number | null;
  createdAt: Date;
}

export async function recentInvocations(
  user: AuthUser | undefined,
  from: Date,
  to: Date,
  platform: boolean,
  limit: number,
): Promise<RecentInvocation[]> {
  return db
    .select({
      id: aiInvocationsTable.id,
      feature: aiInvocationsTable.feature,
      status: aiInvocationsTable.status,
      model: aiInvocationsTable.model,
      totalTokens: aiInvocationsTable.totalTokens,
      estimatedCostMicroUsd: aiInvocationsTable.estimatedCostMicroUsd,
      latencyMs: aiInvocationsTable.latencyMs,
      confidence: aiInvocationsTable.confidence,
      userId: aiInvocationsTable.userId,
      createdAt: aiInvocationsTable.createdAt,
    })
    .from(aiInvocationsTable)
    .where(usageWhere(user, from, to, platform))
    .orderBy(desc(aiInvocationsTable.createdAt))
    .limit(limit);
}

function normalizeAgg(row: Record<string, unknown> | undefined): RawAgg {
  return {
    requests: Number(row?.requests ?? 0),
    success: Number(row?.success ?? 0),
    errors: Number(row?.errors ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    totalTokens: Number(row?.totalTokens ?? 0),
    costMicroUsd: Number(row?.costMicroUsd ?? 0),
    avgLatencyMs: Math.round(Number(row?.avgLatencyMs ?? 0)),
  };
}
