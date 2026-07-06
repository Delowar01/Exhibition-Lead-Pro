import { db, aiInsightsTable } from "@workspace/db";
import type { AiInsight } from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { tenantScope, type AuthUser } from "../middlewares/requireAuth.js";
import { combine } from "./base.js";

// Data access for the persisted, reviewable AI intelligence layer (Stage 5A).
// Insights are keyed uniquely by (companyId, entityType, entityId, insightType), so a
// re-analysis UPSERTS the latest result while preserving the first generatedAt. All
// reads are tenant-scoped via tenantScope (never by companyId alone).

export type EntityType = "lead" | "contact" | "organization";
export type InsightType =
  | "lead_intelligence"
  | "company_intelligence"
  | "contact_intelligence"
  | "smart_classification"
  | "opportunity_potential"
  | "missing_info"
  | "duplicate_intelligence"
  | "relationship_intelligence";

export interface UpsertInsightInput {
  companyId: number;
  entityType: EntityType;
  entityId: number;
  insightType: InsightType;
  data: Record<string, unknown>;
  confidence: number | null;
  reasoning: string | null;
  source: "ai" | "deterministic";
  provider?: string | null;
  model?: string | null;
  promptKey?: string | null;
  promptVersion?: number | null;
}

// Upserts one insight. On re-analysis the content fields + lastAnalysisAt are updated
// and the review status is reset to "suggested" (the recommendation changed, so a prior
// acceptance no longer applies); generatedAt is preserved from the original insert.
export async function upsertInsight(input: UpsertInsightInput): Promise<AiInsight> {
  const now = new Date();
  const [row] = await db
    .insert(aiInsightsTable)
    .values({
      companyId: input.companyId,
      entityType: input.entityType,
      entityId: input.entityId,
      insightType: input.insightType,
      data: input.data,
      confidence: input.confidence,
      reasoning: input.reasoning,
      source: input.source,
      provider: input.provider ?? null,
      model: input.model ?? null,
      promptKey: input.promptKey ?? null,
      promptVersion: input.promptVersion ?? null,
      status: "suggested",
      generatedAt: now,
      lastAnalysisAt: now,
    })
    .onConflictDoUpdate({
      target: [aiInsightsTable.companyId, aiInsightsTable.entityType, aiInsightsTable.entityId, aiInsightsTable.insightType],
      set: {
        data: input.data,
        confidence: input.confidence,
        reasoning: input.reasoning,
        source: input.source,
        provider: input.provider ?? null,
        model: input.model ?? null,
        promptKey: input.promptKey ?? null,
        promptVersion: input.promptVersion ?? null,
        status: "suggested",
        acceptedById: null,
        acceptedAt: null,
        lastAnalysisAt: now,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

export async function listByEntity(user: AuthUser, entityType: EntityType, entityId: number): Promise<AiInsight[]> {
  return db
    .select()
    .from(aiInsightsTable)
    .where(combine(tenantScope(user, aiInsightsTable.companyId), eq(aiInsightsTable.entityType, entityType), eq(aiInsightsTable.entityId, entityId)))
    .orderBy(aiInsightsTable.insightType);
}

export async function getById(user: AuthUser, id: number): Promise<AiInsight | undefined> {
  const [row] = await db
    .select()
    .from(aiInsightsTable)
    .where(combine(tenantScope(user, aiInsightsTable.companyId), eq(aiInsightsTable.id, id)))
    .limit(1);
  return row;
}

export async function setStatus(
  user: AuthUser,
  id: number,
  status: "accepted" | "dismissed" | "suggested",
  acceptedById: number | null,
): Promise<AiInsight | undefined> {
  const [row] = await db
    .update(aiInsightsTable)
    .set({
      status,
      acceptedById: status === "accepted" ? acceptedById : null,
      acceptedAt: status === "accepted" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(and(combine(tenantScope(user, aiInsightsTable.companyId), eq(aiInsightsTable.id, id))!))
    .returning();
  return row;
}

// Company-wide status counts (tenant-scoped) — feeds the batch/insights overview.
export async function statusCounts(user: AuthUser): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: aiInsightsTable.status, n: sql<number>`count(*)` })
    .from(aiInsightsTable)
    .where(tenantScope(user, aiInsightsTable.companyId))
    .groupBy(aiInsightsTable.status);
  const out: Record<string, number> = { suggested: 0, accepted: 0, dismissed: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

// Most recent insights across the tenant (for a review inbox) — tenant-scoped.
export async function recentForCompany(user: AuthUser, limit: number): Promise<AiInsight[]> {
  return db
    .select()
    .from(aiInsightsTable)
    .where(tenantScope(user, aiInsightsTable.companyId))
    .orderBy(desc(aiInsightsTable.lastAnalysisAt))
    .limit(limit);
}
