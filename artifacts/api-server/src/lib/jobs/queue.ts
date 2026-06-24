import { config } from "../../config.js";
import { logger } from "../logger.js";
import { InProcessQueue } from "./in-process-queue.js";
import type { JobQueue } from "./types.js";

// Singleton accessor for the process-wide job queue. The driver is selected from
// config so a shared broker (Redis/BullMQ, etc.) can replace the in-process default
// without touching any producer or handler. Selection is lazy + memoized so importing
// this module never starts a worker on its own.
let queue: JobQueue | null = null;

export function getQueue(): JobQueue {
  if (queue) return queue;
  switch (config.jobs.driver) {
    case "in-process":
    default:
      if (config.jobs.driver !== "in-process") {
        logger.warn(
          { requested: config.jobs.driver },
          "Unknown jobs driver; falling back to in-process queue",
        );
      }
      queue = new InProcessQueue({
        driver: "in-process",
        concurrency: config.jobs.concurrency,
        maxAttempts: config.jobs.maxAttempts,
        backoffBaseMs: config.jobs.backoffBaseMs,
        backoffMaxMs: config.jobs.backoffMaxMs,
      });
      break;
  }
  return queue;
}

export type { Job, JobHandler, JobOptions, JobQueue, QueueStats } from "./types.js";
