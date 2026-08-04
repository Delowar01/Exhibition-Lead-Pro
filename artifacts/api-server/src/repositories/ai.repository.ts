import { db, aiSettingsTable, aiInvocationsTable, aiUsageReservationsTable, companiesTable } from "@workspace/db";
import type { AiSettings, InsertAiInvocation } from "@workspace/db";
import { and, eq, gte, lte, lt, desc, count, sql, type SQL } from "drizzle-orm";
import { tenantScope, type AuthUser } from "../middlewares/requireAuth.js";
import { combine } from "./base.js";

// Advisory-lock namespace for atomic per-tenant AI budget reservation (precedents:
// 74013 document versions, 74021 contact-note dedup).
const AI_BUDGET_LOCK_NS = 74031;

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

// Idempotent by requestId (unique index + DO NOTHING): a retried write after a
// transient failure can never create a duplicate ledger row.
export async function insertInvocation(values: InsertAiInvocation): Promise<void> {
  await db.insert(aiInvocationsTable).values(values).onConflictDoNothing({ target: aiInvocationsTable.requestId });
}

// ---- Batch 6: atomic budget reservation --------------------------------------------

export interface BudgetCheck {
  ok: boolean;
  usedTokens: number;
  usedCostMicroUsd: number;
  exceeded?: "tokens" | "cost";
}

// Atomically checks the tenant's month budget (ledger usage + active reservations)
// and inserts a reservation when allowed. The per-company advisory xact lock
// serializes concurrent reservations so a check-then-write race can never
// collectively overspend the budget. Expired reservations are ignored by the sum and
// opportunistically deleted, so an abandoned reservation (process crash) can never
// block a tenant permanently.
export async function reserveBudget(params: {
  companyId: number;
  requestId: string;
  reserveTokens: number;
  reserveCostMicroUsd: number;
  monthFrom: Date;
  tokenBudget: number | null;
  costBudgetMicroUsd: number | null;
  ttlMs: number;
}): Promise<BudgetCheck> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AI_BUDGET_LOCK_NS}, ${params.companyId})`);

    const now = new Date();
    // Opportunistic cleanup of expired reservations for this tenant (cheap: indexed).
    await tx
      .delete(aiUsageReservationsTable)
      .where(and(eq(aiUsageReservationsTable.companyId, params.companyId), lt(aiUsageReservationsTable.expiresAt, now)));

    const [ledger] = await tx
      .select({
        totalTokens: sql<number>`coalesce(sum(${aiInvocationsTable.totalTokens}),0)`,
        costMicroUsd: sql<number>`coalesce(sum(${aiInvocationsTable.estimatedCostMicroUsd}),0)`,
      })
      .from(aiInvocationsTable)
      .where(and(eq(aiInvocationsTable.companyId, params.companyId), gte(aiInvocationsTable.createdAt, params.monthFrom)));
    const [reserved] = await tx
      .select({
        tokens: sql<number>`coalesce(sum(${aiUsageReservationsTable.reservedTokens}),0)`,
        costMicroUsd: sql<number>`coalesce(sum(${aiUsageReservationsTable.reservedCostMicroUsd}),0)`,
      })
      .from(aiUsageReservationsTable)
      .where(and(eq(aiUsageReservationsTable.companyId, params.companyId), gte(aiUsageReservationsTable.expiresAt, now)));

    const usedTokens = Number(ledger?.totalTokens ?? 0) + Number(reserved?.tokens ?? 0);
    const usedCostMicroUsd = Number(ledger?.costMicroUsd ?? 0) + Number(reserved?.costMicroUsd ?? 0);

    // Admission rule (deliberate): deny when EXISTING usage + active reservations has
    // already reached the budget; the candidate's own reserve is NOT pre-added. This
    // lets tenants whose remaining budget (or entire budget) is smaller than one
    // reserve slice still make calls until genuinely exhausted, at the cost of a
    // bounded overshoot of at most the in-flight calls admitted before the sum
    // crossed the line. Once at/over budget, nothing new is admitted.
    if (params.tokenBudget != null && usedTokens >= params.tokenBudget) {
      return { ok: false, usedTokens, usedCostMicroUsd, exceeded: "tokens" as const };
    }
    if (params.costBudgetMicroUsd != null && usedCostMicroUsd >= params.costBudgetMicroUsd) {
      return { ok: false, usedTokens, usedCostMicroUsd, exceeded: "cost" as const };
    }

    await tx.insert(aiUsageReservationsTable).values({
      companyId: params.companyId,
      requestId: params.requestId,
      reservedTokens: params.reserveTokens,
      reservedCostMicroUsd: params.reserveCostMicroUsd,
      expiresAt: new Date(now.getTime() + params.ttlMs),
    });
    return { ok: true, usedTokens, usedCostMicroUsd };
  });
}

export async function releaseReservation(requestId: string): Promise<void> {
  await db.delete(aiUsageReservationsTable).where(eq(aiUsageReservationsTable.requestId, requestId));
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

// Optional drill-down filters for platform analytics (aggregates only — never content).
export interface UsageFilters {
  companyId?: number;
  feature?: string;
  model?: string;
}

// Builds the WHERE for usage aggregation. Tenant queries are tenantScope-restricted;
// platform=true bypasses tenant scope for cross-tenant platform-owner aggregates.
function usageWhere(
  user: AuthUser | undefined,
  from: Date,
  to: Date,
  platform: boolean,
  filters?: UsageFilters,
): SQL | undefined {
  const conds: Array<SQL | undefined> = [
    gte(aiInvocationsTable.createdAt, from),
    lte(aiInvocationsTable.createdAt, to),
  ];
  if (!platform) conds.push(tenantScope(user, aiInvocationsTable.companyId));
  if (filters?.companyId != null) conds.push(eq(aiInvocationsTable.companyId, filters.companyId));
  if (filters?.feature) conds.push(eq(aiInvocationsTable.feature, filters.feature));
  if (filters?.model) conds.push(eq(aiInvocationsTable.model, filters.model));
  return combine(...conds);
}

// Batch 6 status semantics: "requests" counts PROVIDER calls only (success | error |
// timeout — every historical row predates the new statuses, so history is
// consistent). Non-provider outcomes (cache_hit, dedup_reused, budget_denied,
// rate_limited) carry zero tokens/cost by construction and are surfaced as their own
// counters, never inflating request/latency/failure stats.
const AGG = {
  requests: sql<number>`count(*) filter (where ${aiInvocationsTable.status} in ('success','error','timeout'))`,
  success: sql<number>`count(*) filter (where ${aiInvocationsTable.status} = 'success')`,
  errors: sql<number>`count(*) filter (where ${aiInvocationsTable.status} in ('error','timeout'))`,
  cacheHits: sql<number>`count(*) filter (where ${aiInvocationsTable.status} = 'cache_hit')`,
  dedupReused: sql<number>`count(*) filter (where ${aiInvocationsTable.status} = 'dedup_reused')`,
  budgetDenied: sql<number>`count(*) filter (where ${aiInvocationsTable.status} = 'budget_denied')`,
  rateLimited: sql<number>`count(*) filter (where ${aiInvocationsTable.status} = 'rate_limited')`,
  estimatedRows: sql<number>`count(*) filter (where ${aiInvocationsTable.estimatedUsage} = true)`,
  inputTokens: sql<number>`coalesce(sum(${aiInvocationsTable.inputTokens}),0)`,
  outputTokens: sql<number>`coalesce(sum(${aiInvocationsTable.outputTokens}),0)`,
  totalTokens: sql<number>`coalesce(sum(${aiInvocationsTable.totalTokens}),0)`,
  costMicroUsd: sql<number>`coalesce(sum(${aiInvocationsTable.estimatedCostMicroUsd}),0)`,
  avgLatencyMs: sql<number>`coalesce(avg(${aiInvocationsTable.latencyMs}) filter (where ${aiInvocationsTable.status} in ('success','error','timeout')),0)`,
};

export interface RawAgg {
  requests: number;
  success: number;
  errors: number;
  cacheHits: number;
  dedupReused: number;
  budgetDenied: number;
  rateLimited: number;
  estimatedRows: number;
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
  filters?: UsageFilters,
): Promise<RawAgg> {
  const [row] = await db.select(AGG).from(aiInvocationsTable).where(usageWhere(user, from, to, platform, filters));
  return normalizeAgg(row);
}

export async function usageByFeature(
  user: AuthUser | undefined,
  from: Date,
  to: Date,
  platform: boolean,
  filters?: UsageFilters,
): Promise<Array<RawAgg & { feature: string }>> {
  const rows = await db
    .select({ feature: aiInvocationsTable.feature, ...AGG })
    .from(aiInvocationsTable)
    .where(usageWhere(user, from, to, platform, filters))
    .groupBy(aiInvocationsTable.feature);
  return rows.map((r) => ({ feature: r.feature, ...normalizeAgg(r) }));
}

// Daily usage trend (UTC days — a fixed, timezone-stable bucketing for charts).
export async function usageByDay(
  user: AuthUser | undefined,
  from: Date,
  to: Date,
  platform: boolean,
  filters?: UsageFilters,
): Promise<Array<RawAgg & { day: string }>> {
  const day = sql<string>`to_char(${aiInvocationsTable.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await db
    .select({ day, ...AGG })
    .from(aiInvocationsTable)
    .where(usageWhere(user, from, to, platform, filters))
    .groupBy(day)
    .orderBy(day);
  return rows.map((r) => ({ day: r.day, ...normalizeAgg(r) }));
}

// Paginated per-company aggregates (platform analytics). Ordered by estimated cost.
export async function usageByCompany(
  from: Date,
  to: Date,
  filters?: UsageFilters,
  limit = 25,
  offset = 0,
): Promise<{ items: Array<RawAgg & { companyId: number | null; companyName: string | null }>; total: number }> {
  const where = usageWhere(undefined, from, to, true, filters);
  const [rows, [cnt]] = await Promise.all([
    db
      .select({ companyId: aiInvocationsTable.companyId, companyName: companiesTable.name, ...AGG })
      .from(aiInvocationsTable)
      .leftJoin(companiesTable, eq(aiInvocationsTable.companyId, companiesTable.id))
      .where(where)
      .groupBy(aiInvocationsTable.companyId, companiesTable.name)
      .orderBy(desc(sql`coalesce(sum(${aiInvocationsTable.estimatedCostMicroUsd}),0)`))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(distinct coalesce(${aiInvocationsTable.companyId}, 0))` })
      .from(aiInvocationsTable)
      .where(where),
  ]);
  return {
    items: rows.map((r) => ({ companyId: r.companyId, companyName: r.companyName, ...normalizeAgg(r) })),
    total: Number(cnt?.total ?? 0),
  };
}

// Failure breakdown by low-cardinality category (never message content).
export async function failureCategories(
  user: AuthUser | undefined,
  from: Date,
  to: Date,
  platform: boolean,
  filters?: UsageFilters,
): Promise<Array<{ category: string; count: number }>> {
  const cat = sql<string>`coalesce(${aiInvocationsTable.errorCategory}, 'other')`;
  const rows = await db
    .select({ category: cat, count: count() })
    .from(aiInvocationsTable)
    .where(
      combine(
        usageWhere(user, from, to, platform, filters),
        sql`${aiInvocationsTable.status} in ('error','timeout')`,
      ),
    )
    .groupBy(cat)
    .orderBy(desc(count()));
  return rows.map((r) => ({ category: r.category, count: Number(r.count) }));
}

// Tenants with a configured month budget + their month-to-date usage (two queries,
// no N+1). Percentage math happens in the service.
export async function tenantsWithBudgets(): Promise<
  Array<{ companyId: number; companyName: string | null; tokenBudget: number | null; costBudgetMicroUsd: number | null }>
> {
  const rows = await db
    .select({
      companyId: aiSettingsTable.companyId,
      companyName: companiesTable.name,
      tokenBudget: aiSettingsTable.monthlyTokenBudget,
      costBudgetMicroUsd: aiSettingsTable.monthlyCostBudgetMicroUsd,
    })
    .from(aiSettingsTable)
    .leftJoin(companiesTable, eq(aiSettingsTable.companyId, companiesTable.id))
    .where(sql`${aiSettingsTable.monthlyTokenBudget} is not null or ${aiSettingsTable.monthlyCostBudgetMicroUsd} is not null`);
  return rows.map((r) => ({
    companyId: r.companyId,
    companyName: r.companyName,
    tokenBudget: r.tokenBudget,
    costBudgetMicroUsd: r.costBudgetMicroUsd,
  }));
}

export async function monthUsageByCompany(
  companyIds: number[],
  from: Date,
): Promise<Map<number, { totalTokens: number; costMicroUsd: number }>> {
  if (companyIds.length === 0) return new Map();
  const rows = await db
    .select({
      companyId: aiInvocationsTable.companyId,
      totalTokens: sql<number>`coalesce(sum(${aiInvocationsTable.totalTokens}),0)`,
      costMicroUsd: sql<number>`coalesce(sum(${aiInvocationsTable.estimatedCostMicroUsd}),0)`,
    })
    .from(aiInvocationsTable)
    .where(and(sql`${aiInvocationsTable.companyId} in ${companyIds}`, gte(aiInvocationsTable.createdAt, from)))
    .groupBy(aiInvocationsTable.companyId);
  const map = new Map<number, { totalTokens: number; costMicroUsd: number }>();
  for (const r of rows) {
    if (r.companyId != null) map.set(r.companyId, { totalTokens: Number(r.totalTokens), costMicroUsd: Number(r.costMicroUsd) });
  }
  return map;
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
    cacheHits: Number(row?.cacheHits ?? 0),
    dedupReused: Number(row?.dedupReused ?? 0),
    budgetDenied: Number(row?.budgetDenied ?? 0),
    rateLimited: Number(row?.rateLimited ?? 0),
    estimatedRows: Number(row?.estimatedRows ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    totalTokens: Number(row?.totalTokens ?? 0),
    costMicroUsd: Number(row?.costMicroUsd ?? 0),
    avgLatencyMs: Math.round(Number(row?.avgLatencyMs ?? 0)),
  };
}
