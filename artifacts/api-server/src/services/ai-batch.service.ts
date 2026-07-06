import { randomUUID } from "node:crypto";
import { db, contactsTable, leadsTable, organizationsTable, scansTable } from "@workspace/db";
import { and, isNull } from "drizzle-orm";
import { AppError } from "../middlewares/errorHandler.js";
import { canAccessCompany, tenantScope, type AuthUser } from "../middlewares/requireAuth.js";
import { logger } from "../lib/logger.js";
import { getQueue } from "../lib/jobs/queue.js";
import { analyzeEntity, assertEntityType } from "./ai-insights.service.js";
import type { EntityType } from "../repositories/ai_insights.repository.js";

// Batch runner for Stage 5A. It lets a tenant (re)analyze ALL of one entity type at once.
// Execution runs on the SHARED in-process background-job queue (lib/jobs): startBatch
// enumerates the tenant's entities and enqueues one AI_ANALYZE_ENTITY_JOB per record, so
// the request returns immediately and the workers process them off-band with the queue's
// bounded concurrency. A lightweight in-memory progress store (jobs Map) is kept ONLY for
// UI polling (GET /ai/insights/batch/:jobId); the actual work lives on the queue.
//
// Each per-entity handler catches (never throws on) analyzeEntity failures and records
// them on the batch job, so a failing entity is reported as a soft failure and never
// dead-letters or triggers a retry storm. Jobs are tenant-stamped and only visible to
// callers who can access their company.

const MAX_ENTITIES = 500; // bound the work a single batch can enqueue
const MAX_ERRORS = 20; // cap retained per-entity error detail
const MAX_JOBS = 200; // bound total retained jobs across the process

export const AI_ANALYZE_ENTITY_JOB = "ai:analyze-entity";

export interface AiAnalyzeJobPayload {
  jobId: string;
  entityType: EntityType;
  entityId: number;
  user: AuthUser;
}

export type BatchStatus = "queued" | "running" | "completed" | "failed";

export interface BatchJob {
  id: string;
  companyId: number;
  requestedById: number;
  entityType: EntityType;
  status: BatchStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ entityId: number; message: string }>;
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, BatchJob>();

function snapshot(j: BatchJob): BatchJob {
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

function finalize(job: BatchJob): void {
  job.status = "completed";
  job.finishedAt = new Date().toISOString();
  logger.info(
    { jobId: job.id, companyId: job.companyId, entityType: job.entityType, total: job.total, succeeded: job.succeeded, failed: job.failed },
    "AI batch analysis completed",
  );
}

// Tenant-scoped enumeration of the entity ids to analyze. No filter for platform_owner
// (blocked upstream by requireTenantUser) and inArray(accessibleCompanies) for tenant
// users — never a raw companyId scope that could span tenants. Business cards (scans)
// have no soft-delete column, so the deletedAt guard applies only to the CRM tables.
async function enumerateIds(user: AuthUser, entityType: EntityType): Promise<number[]> {
  if (entityType === "business_card") {
    const rows = await db
      .select({ id: scansTable.id })
      .from(scansTable)
      .where(tenantScope(user, scansTable.companyId))
      .limit(MAX_ENTITIES);
    return rows.map((r) => r.id);
  }
  const table = entityType === "lead" ? leadsTable : entityType === "contact" ? contactsTable : organizationsTable;
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(tenantScope(user, table.companyId), isNull(table.deletedAt)))
    .limit(MAX_ENTITIES);
  return rows.map((r) => r.id);
}

export async function startBatch(user: AuthUser, entityTypeRaw: string): Promise<BatchJob> {
  const entityType = assertEntityType(entityTypeRaw);
  if (user.companyId == null) {
    throw new AppError(400, "A company context is required for batch analysis");
  }
  const ids = await enumerateIds(user, entityType);

  const job: BatchJob = {
    id: randomUUID(),
    companyId: user.companyId,
    requestedById: user.id,
    entityType,
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

  // Enqueue one background job per entity on the shared queue. Clients poll
  // GET /ai/insights/batch/:jobId for progress; each handler updates this job's counters.
  const queue = getQueue();
  for (const id of ids) {
    void queue.enqueue<AiAnalyzeJobPayload>(
      AI_ANALYZE_ENTITY_JOB,
      { jobId: job.id, entityType, entityId: id, user },
      { maxAttempts: 1 },
    );
  }
  return snapshot(job);
}

// Handler body for one enqueued per-entity analysis. Registered on the shared queue at
// startup (lib/jobs/handlers.ts). It NEVER throws — analyzeEntity failures are recorded on
// the batch job as soft failures so the queue does not retry or dead-letter them.
export async function runAiAnalyzeEntityJob(payload: AiAnalyzeJobPayload): Promise<void> {
  const job = jobs.get(payload.jobId);
  if (!job) return; // job pruned/expired — nothing to update
  if (job.status === "queued") job.status = "running";
  try {
    await analyzeEntity(payload.user, payload.entityType, payload.entityId);
    job.succeeded += 1;
  } catch (err) {
    job.failed += 1;
    if (job.errors.length < MAX_ERRORS) {
      job.errors.push({ entityId: payload.entityId, message: err instanceof AppError ? err.message : "Analysis failed" });
    }
  } finally {
    job.processed += 1;
    if (job.processed >= job.total && job.status !== "completed") finalize(job);
  }
}

export function listBatches(user: AuthUser): BatchJob[] {
  return [...jobs.values()]
    .filter((j) => canAccessCompany(user, j.companyId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(snapshot);
}

export function getBatch(user: AuthUser, jobId: string): BatchJob {
  const job = jobs.get(jobId);
  // 404 (not 403) for another tenant's job — never leak that the id exists.
  if (!job || !canAccessCompany(user, job.companyId)) {
    throw new AppError(404, "Batch job not found");
  }
  return snapshot(job);
}
