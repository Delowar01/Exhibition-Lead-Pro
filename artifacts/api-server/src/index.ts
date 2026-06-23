import app from "./app";
import { logger } from "./lib/logger";
import { startFollowUpScheduler } from "./lib/followup-scheduler";
import { config } from "./config.js";

const port = config.port;

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startFollowUpScheduler();
});
