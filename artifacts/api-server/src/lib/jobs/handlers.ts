import { logger } from "../logger.js";
import * as invitationsRepo from "../../repositories/invitations.repository.js";
import { EMAIL_SEND_JOB, deliverEmailViaWorker } from "../email/index.js";
import type { EmailMessage } from "../email/provider.js";
import { getQueue } from "./queue.js";
import { AI_ANALYZE_ENTITY_JOB, runAiAnalyzeEntityJob, type AiAnalyzeJobPayload } from "../../services/ai-batch.service.js";
import { AI_LEDGER_RETRY_JOB, runLedgerRetryJob } from "../../services/ai.service.js";
import { AI_COPILOT_GENERATE_JOB, runAiCopilotGenerateJob, type AiCopilotJobPayload } from "../../services/ai-copilot-batch.service.js";
import { CAPTURE_ANALYZE_JOB, runCaptureAnalyzeJob, type CaptureAnalyzeJobPayload } from "../../services/capture-batch.service.js";
import { AI_WORKFLOW_ANALYZE_JOB, runAiWorkflowAnalyzeJob, type AiWorkflowJobPayload } from "../../services/ai-workflow-batch.service.js";
import { EXECUTIVE_REPORT_JOB, runExecutiveReportJob, type ExecutiveReportJobPayload } from "../../services/executive-intelligence.service.js";
import { registerRecurringHandler } from "./scheduler.js";

// Registers the email delivery handler on a queue. Split out from startWorkers so
// tests can exercise the delivery/retry/outcome-recording path on an isolated queue
// with fast backoff instead of the process-global one.
export function registerEmailHandler(queue: ReturnType<typeof getQueue>): void {
  queue.register<EmailMessage>(EMAIL_SEND_JOB, async (message, job) => {
    const invitationId = message.meta?.invitationId;
    const record = async (status: "sent" | "failed" | "skipped", error?: string | null) => {
      if (invitationId == null) return;
      // Outcome recording must never break delivery or the retry loop.
      await invitationsRepo.recordEmailOutcome(invitationId, status, error ?? null).catch((err) => {
        logger.error({ err, invitationId }, "Failed to record invitation email outcome");
      });
    };
    try {
      const result = await deliverEmailViaWorker(message);
      if (!result.sent && result.skippedReason === "not_configured") {
        // No provider configured — a soft skip, not a failure (no retry). WARN (not
        // debug) so a misconfigured environment cannot silently drop required
        // invitation/reset emails without an operational trace.
        // Safe metadata only — recipient/subject derive from the (decrypted)
        // payload and never belong in durable-worker logs.
        logger.warn(
          { jobId: job.id, invitationId: invitationId ?? null },
          "Email skipped: provider not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS)",
        );
        await record("skipped", "Email provider is not configured");
        return;
      }
      if (!result.sent) {
        // Provider reported non-delivery without throwing (soft failure). Treat it
        // like a transport error so the queue retries and the final outcome is
        // recorded as failed — never misreport an undelivered email as sent.
        throw new Error(result.skippedReason ? `Email not delivered: ${result.skippedReason}` : "Email not delivered");
      }
      logger.info(
        { jobId: job.id, messageId: result.messageId, attempt: job.attempts, invitationId: invitationId ?? null },
        "Email delivered",
      );
      await record("sent", null);
    } catch (err) {
      // Transport error: rethrow so the queue retries with backoff. On the FINAL
      // attempt, persist the failure so it is visible to administrators instead of
      // dying silently in a dead-letter counter. Only a fixed message plus the
      // error CLASS is persisted — raw transport error text can embed recipient
      // addresses, server banners or other message-derived material, and the
      // invitation row must never become a secondary leak channel.
      if (job.attempts >= job.maxAttempts) {
        const cls = err instanceof Error ? err.constructor.name : "Error";
        await record("failed", `Email delivery failed (${cls})`);
      }
      throw err;
    }
  });
}

// Registers all job handlers on the process queue and starts the workers. Called once
// at startup (index.ts). Producers (e.g. lib/email) only enqueue; the actual work runs
// here so a transient failure is retried with backoff instead of breaking a request.
export function startWorkers(): void {
  const queue = getQueue();

  registerEmailHandler(queue);

  // Stage 5A batch AI analysis: one job per entity. The handler records per-entity
  // failures on the batch job as soft failures and never throws, so a failing entity
  // does not retry or dead-letter (maxAttempts is 1 at enqueue time regardless).
  queue.register<AiAnalyzeJobPayload>(AI_ANALYZE_ENTITY_JOB, async (payload) => {
    await runAiAnalyzeEntityJob(payload);
  });

  // Stage 5B copilot batch generation: one job per entity for a single output type. Same
  // soft-failure contract as the insights batch — the handler never throws.
  queue.register<AiCopilotJobPayload>(AI_COPILOT_GENERATE_JOB, async (payload) => {
    await runAiCopilotGenerateJob(payload);
  });

  // Stage 5E capture batch analysis: one job per submitted card. Same soft-failure
  // contract — the handler records per-item failures on the batch job and never throws.
  queue.register<CaptureAnalyzeJobPayload>(CAPTURE_ANALYZE_JOB, async (payload) => {
    await runCaptureAnalyzeJob(payload);
  });

  // Stage 5F workflow batch analysis: one job per entity. Same soft-failure contract —
  // the handler records per-entity failures on the batch job and never throws.
  queue.register<AiWorkflowJobPayload>(AI_WORKFLOW_ANALYZE_JOB, async (payload) => {
    await runAiWorkflowAnalyzeJob(payload);
  });

  // Stage 5C executive report export: one job per report. The handler composes real
  // dashboard data into a PDF/Excel file, uploads it, and flips the row to ready/failed.
  // It never throws (marks the row failed internally) — maxAttempts is 1 at enqueue.
  queue.register<ExecutiveReportJobPayload>(EXECUTIVE_REPORT_JOB, async (payload) => {
    await runExecutiveReportJob(payload);
  });

  // Batch 6 AI ledger retry: re-inserts an ai_invocations row whose inline write
  // failed. THROWS on failure so the queue's backoff/dead-letter machinery applies;
  // the insert is idempotent by requestId, so a retry can never duplicate a row.
  queue.register<Record<string, unknown>>(AI_LEDGER_RETRY_JOB, async (payload) => {
    await runLedgerRetryJob(payload);
  });

  // Batch 14: recurring sweeps dispatched by the scheduler run as durable jobs
  // on this worker pool instead of inside the timer callback.
  registerRecurringHandler(queue);

  queue.start();
}
