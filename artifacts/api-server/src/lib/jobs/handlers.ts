import { logger } from "../logger.js";
import { EMAIL_SEND_JOB, deliverEmailViaWorker } from "../email/index.js";
import type { EmailMessage } from "../email/provider.js";
import { getQueue } from "./queue.js";

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

  queue.start();
}
