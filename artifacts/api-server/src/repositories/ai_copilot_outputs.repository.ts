import { db, aiCopilotOutputsTable } from "@workspace/db";
import type { AiCopilotOutput } from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { tenantScope, type AuthUser } from "../middlewares/requireAuth.js";
import { combine } from "./base.js";

// Data access for the persisted, reviewable AI Sales Copilot outputs (Stage 5B).
// Outputs are keyed uniquely by (companyId, entityType, entityId, outputType), so a
// re-generation UPSERTS the latest draft while preserving the first generatedAt. All
// reads are tenant-scoped via tenantScope (never by companyId alone).

export type EntityType = "lead" | "contact" | "organization" | "business_card";
export type OutputType =
  | "email"
  | "whatsapp"
  | "call_prep"
  | "meeting_prep"
  | "proposal"
  | "followup"
  | "coaching"
  | "summary";

export interface UpsertCopilotOutputInput {
  companyId: number;
  entityType: EntityType;
  entityId: number;
  outputType: OutputType;
  content: Record<string, unknown>;
  confidence: number | null;
  reasoning: string | null;
  source: "ai" | "deterministic";
  provider?: string | null;
  model?: string | null;
  promptKey?: string | null;
  promptVersion?: number | null;
  language: string;
}

// Upserts one output. On re-generation the content fields + lastGeneratedAt are updated
// and the review status is reset to "generated" (a fresh draft, so a prior edit/use no
// longer applies — editedContent/usedBy are cleared); generatedAt is preserved from the
// original insert.
export async function upsertOutput(input: UpsertCopilotOutputInput): Promise<AiCopilotOutput> {
  const now = new Date();
  const [row] = await db
    .insert(aiCopilotOutputsTable)
    .values({
      companyId: input.companyId,
      entityType: input.entityType,
      entityId: input.entityId,
      outputType: input.outputType,
      content: input.content,
      editedContent: null,
      confidence: input.confidence,
      reasoning: input.reasoning,
      source: input.source,
      provider: input.provider ?? null,
      model: input.model ?? null,
      promptKey: input.promptKey ?? null,
      promptVersion: input.promptVersion ?? null,
      language: input.language,
      status: "generated",
      generatedAt: now,
      lastGeneratedAt: now,
    })
    .onConflictDoUpdate({
      target: [aiCopilotOutputsTable.companyId, aiCopilotOutputsTable.entityType, aiCopilotOutputsTable.entityId, aiCopilotOutputsTable.outputType],
      set: {
        content: input.content,
        editedContent: null,
        confidence: input.confidence,
        reasoning: input.reasoning,
        source: input.source,
        provider: input.provider ?? null,
        model: input.model ?? null,
        promptKey: input.promptKey ?? null,
        promptVersion: input.promptVersion ?? null,
        language: input.language,
        status: "generated",
        usedById: null,
        usedAt: null,
        lastGeneratedAt: now,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

// Company-scoped lookup of the stored draft for one (entity, outputType) slot.
// Used by the generation failure path to decide whether a previous successful
// draft exists and must be preserved instead of overwritten with a placeholder.
export async function findForCompanyEntityOutput(
  companyId: number,
  entityType: EntityType,
  entityId: number,
  outputType: string,
): Promise<AiCopilotOutput | undefined> {
  const [row] = await db
    .select()
    .from(aiCopilotOutputsTable)
    .where(
      and(
        eq(aiCopilotOutputsTable.companyId, companyId),
        eq(aiCopilotOutputsTable.entityType, entityType),
        eq(aiCopilotOutputsTable.entityId, entityId),
        eq(aiCopilotOutputsTable.outputType, outputType),
      ),
    )
    .limit(1);
  return row;
}

export async function listByEntity(user: AuthUser, entityType: EntityType, entityId: number): Promise<AiCopilotOutput[]> {
  return db
    .select()
    .from(aiCopilotOutputsTable)
    .where(combine(tenantScope(user, aiCopilotOutputsTable.companyId), eq(aiCopilotOutputsTable.entityType, entityType), eq(aiCopilotOutputsTable.entityId, entityId)))
    .orderBy(aiCopilotOutputsTable.outputType);
}

export async function getById(user: AuthUser, id: number): Promise<AiCopilotOutput | undefined> {
  const [row] = await db
    .select()
    .from(aiCopilotOutputsTable)
    .where(combine(tenantScope(user, aiCopilotOutputsTable.companyId), eq(aiCopilotOutputsTable.id, id)))
    .limit(1);
  return row;
}

// Save a human edit. The edited version is stored separately from the AI/deterministic
// content so provenance of the original draft is preserved; status becomes "edited".
export async function saveEdit(user: AuthUser, id: number, editedContent: Record<string, unknown>): Promise<AiCopilotOutput | undefined> {
  const [row] = await db
    .update(aiCopilotOutputsTable)
    .set({ editedContent, status: "edited", updatedAt: new Date() })
    .where(and(combine(tenantScope(user, aiCopilotOutputsTable.companyId), eq(aiCopilotOutputsTable.id, id))!))
    .returning();
  return row;
}

export async function setUsed(user: AuthUser, id: number, usedById: number): Promise<AiCopilotOutput | undefined> {
  const [row] = await db
    .update(aiCopilotOutputsTable)
    .set({ status: "used", usedById, usedAt: new Date(), updatedAt: new Date() })
    .where(and(combine(tenantScope(user, aiCopilotOutputsTable.companyId), eq(aiCopilotOutputsTable.id, id))!))
    .returning();
  return row;
}

export async function setDismissed(user: AuthUser, id: number): Promise<AiCopilotOutput | undefined> {
  const [row] = await db
    .update(aiCopilotOutputsTable)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(and(combine(tenantScope(user, aiCopilotOutputsTable.companyId), eq(aiCopilotOutputsTable.id, id))!))
    .returning();
  return row;
}

// Company-wide status counts (tenant-scoped) — feeds the copilot overview.
export async function statusCounts(user: AuthUser): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: aiCopilotOutputsTable.status, n: sql<number>`count(*)` })
    .from(aiCopilotOutputsTable)
    .where(tenantScope(user, aiCopilotOutputsTable.companyId))
    .groupBy(aiCopilotOutputsTable.status);
  const out: Record<string, number> = { generated: 0, edited: 0, used: 0, dismissed: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

// Most recent outputs across the tenant (for a review inbox) — tenant-scoped.
export async function recentForCompany(user: AuthUser, limit: number): Promise<AiCopilotOutput[]> {
  return db
    .select()
    .from(aiCopilotOutputsTable)
    .where(tenantScope(user, aiCopilotOutputsTable.companyId))
    .orderBy(desc(aiCopilotOutputsTable.lastGeneratedAt))
    .limit(limit);
}
