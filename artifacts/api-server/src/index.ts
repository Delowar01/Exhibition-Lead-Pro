import app from "./app";
import { logger } from "./lib/logger";
import { startWorkers } from "./lib/jobs/handlers";
import { getQueue } from "./lib/jobs/queue";
import { startScheduler, stopScheduler } from "./lib/jobs/scheduler";
import { backfillAiCopilotPermissions, backfillAiWorkflowPermissions, backfillAiExecutivePermissions, backfillAiAssistantPermissions, backfillWorkflowsPermissions } from "./lib/permission-backfill";
import { config } from "./config.js";
import { recoverOrphanedWorkflowRuns } from "./lib/workflows/recovery";

const port = config.port;

// Graceful shutdown (Batch 14): on container replacement (SIGTERM) or Ctrl-C,
// stop dispatching recurring work and stop claiming new jobs, then allow a
// short bounded drain of active handlers. Queued durable work is never
// deleted; any handler that cannot finish in time keeps its row in `running`
// and is recovered by lease expiry after restart.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down: draining background workers");
  stopScheduler();
  getQueue()
    .stop()
    .catch((err) => logger.error({ err }, "Queue drain failed"))
    .finally(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  // One-time idempotent RBAC backfill: ensure pre-existing admin/employee rows carry the
  // Stage 5B `ai_copilot` permission so shipping the gated copilot routes doesn't lock
  // them out. Never blocks startup — logs and continues on failure.
  backfillAiCopilotPermissions().catch((err) => {
    logger.error({ err }, "ai_copilot permission backfill failed");
  });
  // Stage 5F `ai_workflow` permission backfill — same no-lockout guarantee.
  backfillAiWorkflowPermissions().catch((err) => {
    logger.error({ err }, "ai_workflow permission backfill failed");
  });
  // Stage 5C `ai_executive` permission backfill — same no-lockout guarantee.
  backfillAiExecutivePermissions().catch((err) => {
    logger.error({ err }, "ai_executive permission backfill failed");
  });
  // Stage 5D `ai_assistant` permission backfill — same no-lockout guarantee.
  backfillAiAssistantPermissions().catch((err) => {
    logger.error({ err }, "ai_assistant permission backfill failed");
  });
  // Batch 15 `workflows` permission backfill (admins only) — same no-lockout guarantee.
  backfillWorkflowsPermissions().catch((err) => {
    logger.error({ err }, "workflows permission backfill failed");
  });
  // Background job queue (async email/notification delivery) + recurring maintenance
  // scheduler (token/session cleanup, invitation expiry, retention, follow-ups).
  startWorkers();
  startScheduler();
  // Batch 16: after a restart, re-enqueue workflow runs the previous process left
  // behind (persisted but never enqueued / abandoned mid-run). The recurring
  // scheduler repeats this sweep; both are idempotent (unique run rows, dedupe keys,
  // execution lease). Never blocks startup.
  recoverOrphanedWorkflowRuns().catch((err) => {
    logger.error({ err }, "workflow run recovery at startup failed");
  });
});
