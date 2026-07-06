import { randomUUID } from "node:crypto";
import { db, contactsTable, leadsTable, organizationsTable } from "@workspace/db";
import { and, isNull } from "drizzle-orm";
import { AppError } from "../middlewares/errorHandler.js";
import { canAccessCompany, tenantScope, type AuthUser } from "../middlewares/requireAuth.js";
import { logger } from "../lib/logger.js";
import { analyzeEntity, assertEntityType } from "./ai-insights.service.js";
import type { EntityType } from "../repositories/ai_insights.repository.js";

// Self-contained batch runner for Stage 5A. It lets a tenant (re)analyze ALL of one
// entity type at once. Jobs live in this process's memory (like the email queue's
// CAVEAT) — intentionally NOT on the shared job queue, so a batch never floods the
// email dead-letter path and its progress is queryable directly. Each job is
// tenant-stamped and only visible to callers who can access its company. Processing
// runs OUT of band (not awaited by the request) and reuses analyzeEntity, which itself
// collects — never throws on — per-feature AI failures, so a batch degrades gracefully.

const MAX_ENTITIES = 500; // bound the work a single batch can enqueue
const MAX_ERRORS = 20; // cap retained per-entity error detail
const MAX_JOBS = 200; // bound total retained jobs across the process

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

function tableFor(entityType: EntityType) {
  return entityType === "lead" ? leadsTable : entityType === "contact" ? contactsTable : organizationsTable;
}

export async function startBatch(user: AuthUser, entityTypeRaw: string): Promise<BatchJob> {
  const entityType = assertEntityType(entityTypeRaw);
  if (user.companyId == null) {
    throw new AppError(400, "A company context is required for batch analysis");
  }
  const table = tableFor(entityType);
  // tenant-scoped enumeration: no filter for platform_owner (blocked upstream by
  // requireTenantUser) and inArray(accessibleCompanies) for tenant users — never a
  // raw companyId scope that could span tenants.
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(tenantScope(user, table.companyId), isNull(table.deletedAt)))
    .limit(MAX_ENTITIES);
  const ids = rows.map((r) => r.id);

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

  // Fire-and-forget; the request returns the queued snapshot immediately and clients
  // poll GET /ai/insights/batch/:jobId for progress.
  void processBatch(user, job, entityType, ids);
  return snapshot(job);
}

async function processBatch(user: AuthUser, job: BatchJob, entityType: EntityType, ids: number[]): Promise<void> {
  job.status = "running";
  for (const id of ids) {
    try {
      await analyzeEntity(user, entityType, id);
      job.succeeded += 1;
    } catch (err) {
      job.failed += 1;
      if (job.errors.length < MAX_ERRORS) {
        job.errors.push({ entityId: id, message: err instanceof AppError ? err.message : "Analysis failed" });
      }
    } finally {
      job.processed += 1;
    }
  }
  job.status = "completed";
  job.finishedAt = new Date().toISOString();
  logger.info(
    { jobId: job.id, companyId: job.companyId, entityType, total: job.total, succeeded: job.succeeded, failed: job.failed },
    "AI batch analysis completed",
  );
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
