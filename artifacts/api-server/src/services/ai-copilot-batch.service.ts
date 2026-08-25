import { randomUUID } from "node:crypto";
import { db, contactsTable, leadsTable, organizationsTable, scansTable } from "@workspace/db";
import { and, eq, isNull, isNotNull, or } from "drizzle-orm";
import { AppError } from "../middlewares/errorHandler.js";
import { canAccessCompany, type AuthUser } from "../middlewares/requireAuth.js";
import { logger } from "../lib/logger.js";
import { getQueue } from "../lib/jobs/queue.js";
import { assertEntityType, assertOutputType, generateForBatch, listAvailable } from "./ai-copilot.service.js";
import type { EntityType, OutputType } from "../repositories/ai_copilot_outputs.repository.js";

// Batch runner for the Stage 5B AI Sales Copilot. It lets a tenant generate ONE output
// type (e.g. a follow-up draft) across ALL records of one entity type at once. Mirrors the
// Stage 5A insights batch: enumeration is scoped to the caller's SINGLE company (never
// their full accessible set — a batch never spans tenants), one queue job is enqueued per
// entity (maxAttempts 1 so failures never dead-letter or retry-storm), and a lightweight
// in-memory job store is kept only for UI polling. generateForBatch already soft-degrades
// AI failures, so per-entity errors here are genuine load/tenant failures, recorded as
// soft failures on the job. platform_owner is blocked upstream by requireTenantUser.

const MAX_ENTITIES = 500;
const MAX_ERRORS = 20;
const MAX_JOBS = 200;

export const AI_COPILOT_GENERATE_JOB = "ai:copilot-generate-entity";

export interface AiCopilotJobPayload {
  jobId: string;
  entityType: EntityType;
  entityId: number;
  outputType: OutputType;
  user: AuthUser;
}

export type BatchStatus = "queued" | "running" | "completed" | "failed";

export interface CopilotBatchJob {
  id: string;
  companyId: number;
  requestedById: number;
  entityType: EntityType;
  outputType: OutputType;
  status: BatchStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ entityId: number; message: string }>;
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, CopilotBatchJob>();

function snapshot(j: CopilotBatchJob): CopilotBatchJob {
  return { ...j, errors: j.errors.map((e) => ({ ...e })) };
}

function prune(): void {
  if (jobs.size <= MAX_JOBS) return;
  const ordered = [...jobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const j of ordered) {
    if (jobs.size <= MAX_JOBS) break;
    if (j.status === "completed" || j.status === "failed") jobs.delete(j.id);
  }
}

function finalize(job: CopilotBatchJob): void {
  job.status = "completed";
  job.finishedAt = new Date().toISOString();
  logger.info(
    { jobId: job.id, companyId: job.companyId, entityType: job.entityType, outputType: job.outputType, total: job.total, succeeded: job.succeeded, failed: job.failed },
    "AI copilot batch generation completed",
  );
}

async function enumerateIds(companyId: number, entityType: EntityType): Promise<number[]> {
  if (entityType === "business_card") {
    // Real card scans only — exclude soft-deleted scans and synthetic manual-interaction rows (no image and no card data).
    const rows = await db
      .select({ id: scansTable.id })
      .from(scansTable)
      .where(and(eq(scansTable.companyId, companyId), isNull(scansTable.deletedAt), or(isNotNull(scansTable.imageUrl), isNotNull(scansTable.extractedData))))
      .limit(MAX_ENTITIES);
    return rows.map((r) => r.id);
  }
  const table = entityType === "lead" ? leadsTable : entityType === "contact" ? contactsTable : organizationsTable;
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, companyId), isNull(table.deletedAt)))
    .limit(MAX_ENTITIES);
  return rows.map((r) => r.id);
}

export async function startBatch(user: AuthUser, entityTypeRaw: string, outputTypeRaw: string): Promise<CopilotBatchJob> {
  const entityType = assertEntityType(entityTypeRaw);
  const outputType = assertOutputType(outputTypeRaw);
  if (!listAvailable(entityType).includes(outputType)) {
    throw new AppError(400, `outputType "${outputType}" is not available for ${entityType}`);
  }
  if (user.companyId == null) {
    throw new AppError(400, "A company context is required for batch generation");
  }
  const ids = await enumerateIds(user.companyId, entityType);

  const job: CopilotBatchJob = {
    id: randomUUID(),
    companyId: user.companyId,
    requestedById: user.id,
    entityType,
    outputType,
    status: "queued",
    total: ids.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    errors: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  prune();

  if (ids.length === 0) {
    finalize(job);
    return snapshot(job);
  }

  const queue = getQueue();
  for (const id of ids) {
    void queue.enqueue<AiCopilotJobPayload>(
      AI_COPILOT_GENERATE_JOB,
      { jobId: job.id, entityType, entityId: id, outputType, user },
      { maxAttempts: 1, dedupeKey: `ai-copilot:${job.id}:${entityType}:${id}:${outputType}` },
    );
  }
  return snapshot(job);
}

export async function runAiCopilotGenerateJob(payload: AiCopilotJobPayload): Promise<void> {
  const job = jobs.get(payload.jobId);
  if (!job) return;
  if (job.status === "queued") job.status = "running";
  try {
    await generateForBatch(payload.user, payload.entityType, payload.entityId, payload.outputType);
    job.succeeded += 1;
  } catch (err) {
    job.failed += 1;
    if (job.errors.length < MAX_ERRORS) {
      job.errors.push({ entityId: payload.entityId, message: err instanceof AppError ? err.message : "Generation failed" });
    }
  } finally {
    job.processed += 1;
    if (job.processed >= job.total && job.status !== "completed") finalize(job);
  }
}

export function listBatches(user: AuthUser): CopilotBatchJob[] {
  return [...jobs.values()]
    .filter((j) => canAccessCompany(user, j.companyId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(snapshot);
}

export function getBatch(user: AuthUser, jobId: string): CopilotBatchJob {
  const job = jobs.get(jobId);
  if (!job || !canAccessCompany(user, job.companyId)) {
    throw new AppError(404, "Batch job not found");
  }
  return snapshot(job);
}
