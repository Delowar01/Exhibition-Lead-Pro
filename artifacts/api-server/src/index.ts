import app from "./app";
import { logger } from "./lib/logger";
import { startWorkers } from "./lib/jobs/handlers";
import { startScheduler } from "./lib/jobs/scheduler";
import { config } from "./config.js";

const port = config.port;

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  // Background job queue (async email/notification delivery) + recurring maintenance
  // scheduler (token/session cleanup, invitation expiry, retention, follow-ups).
  startWorkers();
  startScheduler();
});
