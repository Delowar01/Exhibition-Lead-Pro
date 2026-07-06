import { randomUUID } from "node:crypto";
import { AppError } from "../middlewares/errorHandler.js";
import { canAccessCompany, type AuthUser } from "../middlewares/requireAuth.js";
import { logger } from "../lib/logger.js";
import { getQueue } from "../lib/jobs/queue.js";
import { analyzeCapture, type CaptureAnalysis } from "./capture-intelligence.service.js";
import type { CaptureFields } from "../lib/capture-validation.js";
import { extractCardData } from "../lib/ai.js";

// Batch runner for Stage 5E intelligent capture. It lets a tenant analyze MANY captured
// cards at once (e.g. a mobile batch-scan session) without holding the request open.
// startCaptureBatch enqueues one CAPTURE_ANALYZE_JOB per submitted item on the SHARED
// in-process queue; the request returns 202 immediately and clients poll
// GET /scans/batch/:jobId for progress + per-item results. Read-only: each item runs the
// same read-only analyzeCapture (no writes, no auto-link). A per-item failure is recorded
// as a soft failure and never dead-letters or retries. Jobs are tenant-stamped and only
// visible to callers who can access their company.

const MAX_ITEMS = 500; // bound the work a single batch can enqueue
const MAX_ERRORS = 20; // cap retained per-item error detail
const MAX_JOBS = 200; // bound total retained jobs across the process

export const CAPTURE_ANALYZE_JOB = "capture:analyze";

export interface CaptureAnalyzeJobPayload {
  jobId: string;
  key: string;
  fields: CaptureFields;
  imageData?: string | null;
  appLanguage?: string;
  user: AuthUser;
}

export type BatchStatus = "queued" | "running" | "completed" | "failed";

export interface CaptureBatchJob {
  id: string;
  companyId: number;
  requestedById: number;
  status: BatchStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  results: Array<{ key: string; analysis: CaptureAnalysis }>;
  errors: Array<{ key: string; message: string }>;
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, CaptureBatchJob>();

function snapshot(j: CaptureBatchJob): CaptureBatchJob {
  return { ...j, results: j.results.map((r) => ({ ...r })), errors: j.errors.map((e) => ({ ...e })) };
}

function prune(): void {
  if (jobs.size <= MAX_JOBS) return;
  const ordered = [...jobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const j of ordered) {
    if (jobs.size <= MAX_JOBS) break;
    if (j.status === "completed" || j.status === "failed") jobs.delete(j.id);
  }
}

function finalize(job: CaptureBatchJob): void {
  job.status = "completed";
  job.finishedAt = new Date().toISOString();
  logger.info(
    { jobId: job.id, companyId: job.companyId, total: job.total, succeeded: job.succeeded, failed: job.failed },
    "Capture batch analysis completed",
  );
}

export interface CaptureBatchItem {
  key: string;
  fields: CaptureFields;
  imageData?: string | null;
  appLanguage?: string;
}

export async function startCaptureBatch(user: AuthUser, items: CaptureBatchItem[]): Promise<CaptureBatchJob> {
  if (user.companyId == null) {
    throw new AppError(400, "A company context is required for batch analysis");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError(400, "At least one item is required");
  }
  if (items.length > MAX_ITEMS) {
    throw new AppError(400, `A batch can analyze at most ${MAX_ITEMS} items`);
  }

  const job: CaptureBatchJob = {
    id: randomUUID(),
    companyId: user.companyId,
    requestedById: user.id,
    status: "queued",
    total: items.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    results: [],
    errors: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  prune();

  const queue = getQueue();
  for (const item of items) {
    void queue.enqueue<CaptureAnalyzeJobPayload>(
      CAPTURE_ANALYZE_JOB,
      { jobId: job.id, key: item.key, fields: item.fields, imageData: item.imageData ?? null, appLanguage: item.appLanguage, user },
      { maxAttempts: 1 },
    );
  }
  return snapshot(job);
}

// Handler body for one enqueued per-item analysis. Registered on the shared queue at
// startup (lib/jobs/handlers.ts). It NEVER throws — analyzeCapture failures are recorded on
// the batch job as soft failures so the queue does not retry or dead-letter them.
export async function runCaptureAnalyzeJob(payload: CaptureAnalyzeJobPayload): Promise<void> {
  const job = jobs.get(payload.jobId);
  if (!job) return; // job pruned/expired — nothing to update
  if (job.status === "queued") job.status = "running";
  try {
    // When the item carries a raw image, run OCR first so a batch of scans goes through the
    // full OCR -> validation -> recognition pipeline. OCR-derived fields are the base; any
    // explicitly supplied fields override them (a reviewer's edits win over raw OCR).
    let fields = payload.fields;
    if (typeof payload.imageData === "string" && payload.imageData.length > 0) {
      const lang = payload.appLanguage === "ar" ? "ar" : "en";
      const ocr = await extractCardData(payload.imageData, lang, {
        companyId: payload.user.companyId ?? undefined,
        userId: payload.user.id,
      });
      const f = ocr.fields;
      const ocrFields: CaptureFields = {
        firstName: f.firstName,
        lastName: f.lastName,
        jobTitle: f.jobTitle,
        company: f.company,
        email: f.email,
        mobile: f.mobile,
        website: f.website,
        linkedin: f.linkedin,
        address: f.address,
      };
      fields = { ...ocrFields, ...payload.fields };
    }
    const analysis = await analyzeCapture(payload.user, fields);
    job.results.push({ key: payload.key, analysis });
    job.succeeded += 1;
  } catch (err) {
    job.failed += 1;
    if (job.errors.length < MAX_ERRORS) {
      job.errors.push({ key: payload.key, message: err instanceof AppError ? err.message : "Analysis failed" });
    }
  } finally {
    job.processed += 1;
    if (job.processed >= job.total && job.status !== "completed") finalize(job);
  }
}

export function getCaptureBatch(user: AuthUser, jobId: string): CaptureBatchJob {
  const job = jobs.get(jobId);
  // 404 (not 403) for another tenant's job — never leak that the id exists.
  if (!job || !canAccessCompany(user, job.companyId)) {
    throw new AppError(404, "Batch job not found");
  }
  return snapshot(job);
}
