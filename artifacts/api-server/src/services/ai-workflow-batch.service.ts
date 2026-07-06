import { randomUUID } from "node:crypto";
import { db, contactsTable, leadsTable, organizationsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { AppError } from "../middlewares/errorHandler.js";
import { canAccessCompany, type AuthUser } from "../middlewares/requireAuth.js";
import { logger } from "../lib/logger.js";
import { getQueue } from "../lib/jobs/queue.js";
import { assertEntityType, analyzeForBatch } from "./ai-workflow.service.js";
import type { EntityType } from "../repositories/ai_workflow.repository.js";

// Batch runner for the Stage 5F AI Workflow engine. Lets a tenant (re)compute workflow
// recommendations across ALL records of one entity type at once. Mirrors the Stage 5B
// copilot batch: enumeration is scoped to the caller's SINGLE company (never their full
// accessible set — a batch never spans tenants), one queue job per entity (maxAttempts 1
// so failures never dead-letter or retry-storm), and a lightweight in-memory job store is
// kept only for UI polling. analyzeForBatch already soft-degrades AI failures, so per-entity
// errors here are genuine load/tenant failures, recorded as soft failures on the job.
// platform_owner is blocked upstream by the path-scoped tenant guard on /ai/workflow.

const MAX_ENTITIES = 500;
const MAX_ERRORS = 20;
const MAX_JOBS = 200;

export const AI_WORKFLOW_ANALYZE_JOB = "ai:workflow-analyze-entity";

export interface AiWorkflowJobPayload {
  jobId: string;
  entityType: EntityType;
  entityId: number;
  user: AuthUser;
}

export type BatchStatus = "queued" | "running" | "completed" | "failed";

export interface WorkflowBatchJob {
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

const jobs = new Map<string, WorkflowBatchJob>();

function snapshot(j: WorkflowBatchJob): WorkflowBatchJob {
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

function finalize(job: WorkflowBatchJob): void {
  const allFailed = job.total > 0 && job.succeeded === 0 && job.failed > 0;
  job.status = allFailed ? "failed" : "completed";
  job.finishedAt = new Date().toISOString();
  logger.info(
    { jobId: job.id, companyId: job.companyId, entityType: job.entityType, total: job.total, succeeded: job.succeeded, failed: job.failed, status: job.status },
    "AI workflow batch analysis finished",
  );
}

async function enumerateIds(companyId: number, entityType: EntityType): Promise<number[]> {
  const table = entityType === "lead" ? leadsTable : entityType === "contact" ? contactsTable : organizationsTable;
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, companyId), isNull(table.deletedAt)))
    .limit(MAX_ENTITIES);
  return rows.map((r) => r.id);
}

export async function startBatch(user: AuthUser, entityTypeRaw: string): Promise<WorkflowBatchJob> {
  const entityType = assertEntityType(entityTypeRaw);
  if (user.companyId == null) {
    throw new AppError(400, "A company context is required for batch analysis");
  }
  const ids = await enumerateIds(user.companyId, entityType);

  const job: WorkflowBatchJob = {
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

  const queue = getQueue();
  for (const id of ids) {
    void queue.enqueue<AiWorkflowJobPayload>(
      AI_WORKFLOW_ANALYZE_JOB,
      { jobId: job.id, entityType, entityId: id, user },
      { maxAttempts: 1 },
    );
  }
  return snapshot(job);
}

export async function runAiWorkflowAnalyzeJob(payload: AiWorkflowJobPayload): Promise<void> {
  const job = jobs.get(payload.jobId);
  if (!job) return;
  if (job.status === "queued") job.status = "running";
  try {
    await analyzeForBatch(payload.user, payload.entityType, payload.entityId);
    job.succeeded += 1;
  } catch (err) {
    job.failed += 1;
    if (job.errors.length < MAX_ERRORS) {
      job.errors.push({ entityId: payload.entityId, message: err instanceof AppError ? err.message : "Analysis failed" });
    }
  } finally {
    job.processed += 1;
    if (job.processed >= job.total && job.status !== "completed" && job.status !== "failed") finalize(job);
  }
}

export function listBatches(user: AuthUser): WorkflowBatchJob[] {
  return [...jobs.values()]
    .filter((j) => canAccessCompany(user, j.companyId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(snapshot);
}

export function getBatch(user: AuthUser, jobId: string): WorkflowBatchJob {
  const job = jobs.get(jobId);
  if (!job || !canAccessCompany(user, job.companyId)) {
    throw new AppError(404, "Batch job not found");
  }
  return snapshot(job);
}
