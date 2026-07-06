import app from "./app";
import { logger } from "./lib/logger";
import { startWorkers } from "./lib/jobs/handlers";
import { startScheduler } from "./lib/jobs/scheduler";
import { backfillAiCopilotPermissions, backfillAiWorkflowPermissions } from "./lib/permission-backfill";
import { config } from "./config.js";

const port = config.port;

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
  // Background job queue (async email/notification delivery) + recurring maintenance
  // scheduler (token/session cleanup, invitation expiry, retention, follow-ups).
  startWorkers();
  startScheduler();
});
