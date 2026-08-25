import { config } from "../../config.js";
import { logger } from "../logger.js";
import { InProcessQueue } from "./in-process-queue.js";
import { PostgresQueue } from "./postgres-queue.js";
import type { JobQueue } from "./types.js";

// Singleton accessor for the process-wide job queue. The driver is selected from
// config; producers and handlers depend only on the JobQueue contract.
//
// Drivers (Batch 14):
//   in-process — single-process, in-memory (development/test default; rollback
//                option). Restart loses queued work — documented in the class.
//   postgres   — durable: rows survive restart/crash, at-least-once delivery,
//                lease-based crash recovery, encrypted payloads.
//
// An UNKNOWN driver is a hard configuration error — production must never
// silently degrade to the non-durable queue.
let queue: JobQueue | null = null;

export function getQueue(): JobQueue {
  if (queue) return queue;
  switch (config.jobs.driver) {
    case "in-process":
      queue = new InProcessQueue({
        driver: "in-process",
        concurrency: config.jobs.concurrency,
        maxAttempts: config.jobs.maxAttempts,
        backoffBaseMs: config.jobs.backoffBaseMs,
        backoffMaxMs: config.jobs.backoffMaxMs,
      });
      break;
    case "postgres": {
      const key = config.jobs.payloadEncryptionKey;
      if (!key) {
        throw new Error(
          "JOBS_DRIVER=postgres requires JOBS_PAYLOAD_ENCRYPTION_KEY (durable job payloads are encrypted at rest)",
        );
      }
      queue = new PostgresQueue({
        concurrency: config.jobs.concurrency,
        maxAttempts: config.jobs.maxAttempts,
        backoffBaseMs: config.jobs.backoffBaseMs,
        backoffMaxMs: config.jobs.backoffMaxMs,
        pollIntervalMs: config.jobs.pollIntervalMs,
        leaseMs: config.jobs.leaseMs,
        shutdownGraceMs: config.jobs.shutdownGraceMs,
        payloadEncryptionKey: key,
      });
      logger.info({ driver: "postgres" }, "Durable job queue selected");
      break;
    }
    default:
      throw new Error(
        `Unknown JOBS_DRIVER "${config.jobs.driver}" — valid drivers are "in-process" and "postgres"`,
      );
  }
  return queue;
}

export type { Job, JobHandler, JobOptions, JobQueue, QueueStats } from "./types.js";
