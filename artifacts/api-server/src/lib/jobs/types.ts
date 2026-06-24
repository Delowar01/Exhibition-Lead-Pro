// Provider-agnostic background job/queue contract (Phase 2.6). Producers depend ONLY
// on this interface; the concrete transport (an in-process queue today; Redis/BullMQ
// or another broker later) implements it without any change to business logic. Swap
// the implementation via config (`config.jobs.driver`) — producers never change.

export interface JobOptions {
  // Total attempts before the job is dead-lettered (>= 1). Defaults to the queue's
  // configured maxAttempts.
  maxAttempts?: number;
  // Base backoff in ms for the first retry; subsequent retries grow exponentially up
  // to the queue's backoffMaxMs. Defaults to the queue's backoffBaseMs.
  backoffBaseMs?: number;
}

export interface Job<T = unknown> {
  id: string;
  name: string;
  payload: T;
  // 1-based attempt counter (incremented before each handler invocation).
  attempts: number;
  maxAttempts: number;
  backoffBaseMs: number;
  enqueuedAt: number;
}

export type JobHandler<T = unknown> = (payload: T, job: Job<T>) => Promise<void>;

export interface QueueStats {
  // Jobs currently waiting (including those scheduled for a future retry).
  pending: number;
  // Jobs currently being processed by a worker.
  active: number;
  // Cumulative counters since process start.
  enqueued: number;
  completed: number;
  failed: number; // individual attempt failures (retries included)
  deadLettered: number; // jobs that exhausted all attempts
}

export interface JobQueue {
  readonly driver: string;
  // Register the handler for a job name. One handler per name; last registration wins.
  register<T>(jobName: string, handler: JobHandler<T>): void;
  // Enqueue a job for asynchronous processing. Resolves once the job is accepted
  // (NOT when it completes). Never throws for transport reasons in the in-process
  // implementation.
  enqueue<T>(jobName: string, payload: T, opts?: JobOptions): Promise<void>;
  // Begin processing. Idempotent — calling twice is a no-op.
  start(): void;
  // Stop accepting/pumping work. Resolves when in-flight handlers settle (best effort).
  stop(): Promise<void>;
  stats(): QueueStats;
}
