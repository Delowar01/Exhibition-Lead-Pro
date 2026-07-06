import { db, aiWorkflowRecommendationsTable } from "@workspace/db";
import type { AiWorkflowRecommendation } from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { tenantScope, type AuthUser } from "../middlewares/requireAuth.js";
import { combine } from "./base.js";

// Data access for the persisted, reviewable AI workflow recommendation layer (Stage 5F).
// Recommendations are keyed uniquely by (companyId, entityType, entityId, recommendationType),
// so a re-analysis UPSERTS the latest result while preserving the first generatedAt. All
// reads are tenant-scoped via tenantScope (never by companyId alone). This mirrors the
// ai_insights repository exactly so the review/provenance/lifecycle contract is identical.

export type EntityType = "lead" | "contact" | "organization";
export type RecommendationType =
  | "next_action"
  | "follow_up"
  | "owner"
  | "department"
  | "team"
  | "priority"
  | "due_date"
  | "routing"
  | "progression"
  | "reminder"
  | "task";

export interface UpsertRecommendationInput {
  companyId: number;
  entityType: EntityType;
  entityId: number;
  recommendationType: RecommendationType;
  data: Record<string, unknown>;
  confidence: number | null;
  reasoning: string | null;
  source: "ai" | "deterministic";
  provider?: string | null;
  model?: string | null;
  promptKey?: string | null;
  promptVersion?: number | null;
}

// Upserts one recommendation. On re-analysis the content fields + lastAnalysisAt are
// updated and the review status is reset to "suggested" (the recommendation changed, so a
// prior acceptance no longer applies); generatedAt is preserved from the original insert.
export async function upsertRecommendation(input: UpsertRecommendationInput): Promise<AiWorkflowRecommendation> {
  const now = new Date();
  const [row] = await db
    .insert(aiWorkflowRecommendationsTable)
    .values({
      companyId: input.companyId,
      entityType: input.entityType,
      entityId: input.entityId,
      recommendationType: input.recommendationType,
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
      target: [
        aiWorkflowRecommendationsTable.companyId,
        aiWorkflowRecommendationsTable.entityType,
        aiWorkflowRecommendationsTable.entityId,
        aiWorkflowRecommendationsTable.recommendationType,
      ],
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

export async function listByEntity(user: AuthUser, entityType: EntityType, entityId: number): Promise<AiWorkflowRecommendation[]> {
  return db
    .select()
    .from(aiWorkflowRecommendationsTable)
    .where(combine(tenantScope(user, aiWorkflowRecommendationsTable.companyId), eq(aiWorkflowRecommendationsTable.entityType, entityType), eq(aiWorkflowRecommendationsTable.entityId, entityId)))
    .orderBy(aiWorkflowRecommendationsTable.recommendationType);
}

export async function getById(user: AuthUser, id: number): Promise<AiWorkflowRecommendation | undefined> {
  const [row] = await db
    .select()
    .from(aiWorkflowRecommendationsTable)
    .where(combine(tenantScope(user, aiWorkflowRecommendationsTable.companyId), eq(aiWorkflowRecommendationsTable.id, id)))
    .limit(1);
  return row;
}

export async function setStatus(
  user: AuthUser,
  id: number,
  status: "accepted" | "dismissed" | "suggested",
  acceptedById: number | null,
): Promise<AiWorkflowRecommendation | undefined> {
  const [row] = await db
    .update(aiWorkflowRecommendationsTable)
    .set({
      status,
      acceptedById: status === "accepted" ? acceptedById : null,
      acceptedAt: status === "accepted" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(and(combine(tenantScope(user, aiWorkflowRecommendationsTable.companyId), eq(aiWorkflowRecommendationsTable.id, id))!))
    .returning();
  return row;
}

// Company-wide status counts (tenant-scoped) — feeds the batch/workflow overview.
export async function statusCounts(user: AuthUser): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: aiWorkflowRecommendationsTable.status, n: sql<number>`count(*)` })
    .from(aiWorkflowRecommendationsTable)
    .where(tenantScope(user, aiWorkflowRecommendationsTable.companyId))
    .groupBy(aiWorkflowRecommendationsTable.status);
  const out: Record<string, number> = { suggested: 0, accepted: 0, dismissed: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

// Most recent recommendations across the tenant (for a review inbox) — tenant-scoped.
export async function recentForCompany(user: AuthUser, limit: number): Promise<AiWorkflowRecommendation[]> {
  return db
    .select()
    .from(aiWorkflowRecommendationsTable)
    .where(tenantScope(user, aiWorkflowRecommendationsTable.companyId))
    .orderBy(desc(aiWorkflowRecommendationsTable.lastAnalysisAt))
    .limit(limit);
}
