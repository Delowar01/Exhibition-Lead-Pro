import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import type { Job, JobHandler, JobOptions, JobQueue, QueueStats } from "./types.js";

interface InProcessQueueConfig {
  driver: string;
  concurrency: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

// In-process job queue (Phase 2.6 default). A single-process, in-memory queue with
// bounded concurrency, exponential backoff retries, and dead-lettering on attempt
// exhaustion. It is intentionally simple and dependency-free.
//
// CAVEAT (documented): jobs live only in this process's memory, so a restart or crash
// loses queued/in-flight work, and in a multi-instance deployment each instance runs
// its own queue. This is acceptable for transactional email/notification delivery and
// idempotent maintenance; swap in a shared broker (Redis/BullMQ) behind `JobQueue`
// when durability or cross-instance coordination is required.
export class InProcessQueue implements JobQueue {
  readonly driver: string;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly ready: Job[] = []; // jobs ready to run now
  private scheduled = 0; // jobs waiting on a backoff timer
  private active = 0;
  private running = false;
  private readonly cfg: InProcessQueueConfig;
  private readonly counters = { enqueued: 0, completed: 0, failed: 0, deadLettered: 0 };

  constructor(cfg: InProcessQueueConfig) {
    this.cfg = cfg;
    this.driver = cfg.driver;
  }

  register<T>(jobName: string, handler: JobHandler<T>): void {
    this.handlers.set(jobName, handler as JobHandler);
  }

  enqueue<T>(jobName: string, payload: T, opts?: JobOptions): Promise<void> {
    const job: Job<T> = {
      id: randomUUID(),
      name: jobName,
      payload,
      attempts: 0,
      maxAttempts: Math.max(1, opts?.maxAttempts ?? this.cfg.maxAttempts),
      backoffBaseMs: Math.max(0, opts?.backoffBaseMs ?? this.cfg.backoffBaseMs),
      enqueuedAt: Date.now(),
    };
    this.counters.enqueued++;
    this.ready.push(job as Job);
    if (this.running) this.pump();
    return Promise.resolve();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pump();
    logger.info(
      { driver: this.driver, concurrency: this.cfg.concurrency },
      "Background job queue started",
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    // Best-effort drain of in-flight handlers; ready/scheduled jobs are dropped.
    const start = Date.now();
    while (this.active > 0 && Date.now() - start < 5_000) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  stats(): QueueStats {
    return {
      pending: this.ready.length + this.scheduled,
      active: this.active,
      enqueued: this.counters.enqueued,
      completed: this.counters.completed,
      failed: this.counters.failed,
      deadLettered: this.counters.deadLettered,
    };
  }

  // Pulls ready jobs onto free worker slots until the concurrency ceiling is reached.
  private pump(): void {
    if (!this.running) return;
    while (this.active < this.cfg.concurrency && this.ready.length > 0) {
      const job = this.ready.shift()!;
      void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers.get(job.name);
    this.active++;
    job.attempts++;
    try {
      if (!handler) {
        // No handler registered — a programming error; dead-letter immediately so it
        // surfaces in logs/counters rather than spinning.
        throw new Error(`No handler registered for job "${job.name}"`);
      }
      await handler(job.payload, job);
      this.counters.completed++;
    } catch (err) {
      this.counters.failed++;
      if (job.attempts < job.maxAttempts) {
        const delay = this.backoffFor(job);
        logger.warn(
          { err, job: job.name, id: job.id, attempt: job.attempts, maxAttempts: job.maxAttempts, retryInMs: delay },
          "Job attempt failed; scheduling retry",
        );
        this.scheduleRetry(job, delay);
      } else {
        this.counters.deadLettered++;
        logger.error(
          { err, job: job.name, id: job.id, attempts: job.attempts },
          "Job dead-lettered after exhausting all attempts",
        );
      }
    } finally {
      this.active--;
      this.pump();
    }
  }

  // Exponential backoff: base * 2^(attempt-1), capped at backoffMaxMs.
  private backoffFor(job: Job): number {
    const exp = job.backoffBaseMs * Math.pow(2, job.attempts - 1);
    return Math.min(exp, this.cfg.backoffMaxMs);
  }

  private scheduleRetry(job: Job, delay: number): void {
    this.scheduled++;
    const timer = setTimeout(() => {
      this.scheduled--;
      if (!this.running) return;
      this.ready.push(job);
      this.pump();
    }, delay);
    // Don't keep the event loop alive solely for a pending retry.
    if (typeof timer.unref === "function") timer.unref();
  }
}
