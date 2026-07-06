import { logger } from "../logger.js";
import { EMAIL_SEND_JOB, deliverEmailViaWorker } from "../email/index.js";
import type { EmailMessage } from "../email/provider.js";
import { getQueue } from "./queue.js";
import { AI_ANALYZE_ENTITY_JOB, runAiAnalyzeEntityJob, type AiAnalyzeJobPayload } from "../../services/ai-batch.service.js";
import { AI_COPILOT_GENERATE_JOB, runAiCopilotGenerateJob, type AiCopilotJobPayload } from "../../services/ai-copilot-batch.service.js";
import { CAPTURE_ANALYZE_JOB, runCaptureAnalyzeJob, type CaptureAnalyzeJobPayload } from "../../services/capture-batch.service.js";
import { AI_WORKFLOW_ANALYZE_JOB, runAiWorkflowAnalyzeJob, type AiWorkflowJobPayload } from "../../services/ai-workflow-batch.service.js";

// Registers all job handlers on the process queue and starts the workers. Called once
// at startup (index.ts). Producers (e.g. lib/email) only enqueue; the actual work runs
// here so a transient failure is retried with backoff instead of breaking a request.
export function startWorkers(): void {
  const queue = getQueue();

  queue.register<EmailMessage>(EMAIL_SEND_JOB, async (message, job) => {
    const result = await deliverEmailViaWorker(message);
    if (!result.sent && result.skippedReason === "not_configured") {
      // No provider configured — a soft skip, not a failure (no retry).
      logger.debug({ to: message.to, subject: message.subject }, "Email skipped: provider not configured");
      return;
    }
    logger.info(
      { to: message.to, subject: message.subject, messageId: result.messageId, attempt: job.attempts },
      "Email delivered",
    );
    // Any thrown transport error propagates to the queue for retry/backoff.
  });

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

  queue.start();
}
