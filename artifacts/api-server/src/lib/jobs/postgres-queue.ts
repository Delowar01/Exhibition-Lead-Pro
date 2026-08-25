import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db as defaultDb, jobQueueTable } from "@workspace/db";
import { logger } from "../logger.js";
import { decryptPayload, deriveKey, encryptPayload, PayloadDecryptError } from "./payload-crypto.js";
import type { Job, JobHandler, JobOptions, JobQueue, QueueStats } from "./types.js";

export interface PostgresQueueConfig {
  concurrency: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  // Worker poll cadence for ready jobs (ms).
  pollIntervalMs: number;
  // Lease duration granted per claim/heartbeat (ms). A worker heartbeats at
  // leaseMs/3, so a healthy handler is never reclaimed; a dead process stops
  // heartbeating and its jobs recover after at most leaseMs.
  leaseMs: number;
  // Bounded drain window for stop() (ms).
  shutdownGraceMs: number;
  // Dedicated payload-encryption secret (JOBS_PAYLOAD_ENCRYPTION_KEY).
  payloadEncryptionKey: string;
}

type Db = typeof defaultDb;

// Handler errors may interpolate DECRYPTED payload values (links, tokens, email
// bodies) into their message. Persisting or logging raw handler error text
// would leak that material, so only a fixed message plus the error CLASS is
// ever stored — queue-internal conditions (decryption failure, lease expiry,
// missing handler) use their own fixed strings.
function safeHandlerError(err: unknown): string {
  const cls = err instanceof Error ? err.constructor.name : typeof err;
  return `Handler failed (${cls})`;
}

// PostgreSQL-backed durable job queue (Batch 14). Same JobQueue contract as the
// in-process driver, but rows survive restarts: enqueue INSERTs, workers claim
// atomically with FOR UPDATE SKIP LOCKED (attempt incremented in the same
// statement), retries persist as status=pending with a future available_at
// (database time is authoritative — no setTimeout state), exhausted jobs
// dead-letter, and crashed workers are recovered through lease expiry.
//
// Delivery contract: AT-LEAST-ONCE. Completion is recorded only by the worker
// holding the lease; a worker that dies after the handler's side effects but
// before recording completion yields a re-run. Handlers must tolerate that.
// Payloads are stored ONLY as AES-256-GCM envelopes and are never logged.
export class PostgresQueue implements JobQueue {
  readonly driver = "postgres";
  readonly workerId: string;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly cfg: PostgresQueueConfig;
  private readonly db: Db;
  private readonly key: Buffer;
  private readonly active = new Set<number>(); // row ids currently held by this worker
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly counters = { enqueued: 0, completed: 0, failed: 0, deadLettered: 0 };

  constructor(cfg: PostgresQueueConfig, database: Db = defaultDb) {
    this.cfg = cfg;
    this.db = database;
    this.key = deriveKey(cfg.payloadEncryptionKey);
    this.workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  register<T>(jobName: string, handler: JobHandler<T>): void {
    this.handlers.set(jobName, handler as JobHandler);
  }

  async enqueue<T>(jobName: string, payload: T, opts?: JobOptions): Promise<void> {
    const availableAt = new Date(Date.now() + Math.max(0, opts?.delayMs ?? 0));
    const values = {
      name: jobName,
      payload: encryptPayload(this.key, payload),
      status: "pending" as const,
      attempts: 0,
      maxAttempts: Math.max(1, opts?.maxAttempts ?? this.cfg.maxAttempts),
      backoffBaseMs: Math.max(0, opts?.backoffBaseMs ?? this.cfg.backoffBaseMs),
      availableAt,
      dedupeKey: opts?.dedupeKey ?? null,
    };
    // Idempotent enqueue: the unique index on dedupe_key (standard PostgreSQL
    // NULL semantics — keyless jobs are unconstrained) makes the insert itself
    // the race-free dedupe check. A retained row reserves its key in EVERY
    // state — pending, running, completed and dead — so the same logical job is
    // never accepted twice; retention eventually frees keys of historical
    // terminal rows per the configured windows.
    const inserted = await this.db
      .insert(jobQueueTable)
      .values(values)
      .onConflictDoNothing({ target: jobQueueTable.dedupeKey })
      .returning({ id: jobQueueTable.id });
    if (inserted.length > 0) this.counters.enqueued++;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      void this.poll();
    };
    this.pollTimer = setInterval(tick, this.cfg.pollIntervalMs);
    if (typeof this.pollTimer.unref === "function") this.pollTimer.unref();
    // One shared heartbeat extends the lease for every job this worker holds —
    // individual handlers never manage their own lease.
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, Math.max(250, Math.floor(this.cfg.leaseMs / 3)));
    if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
    tick();
    logger.info(
      { driver: this.driver, workerId: this.workerId, concurrency: this.cfg.concurrency, leaseMs: this.cfg.leaseMs },
      "Durable job queue started",
    );
  }

  async stop(): Promise<void> {
    // Stop claiming new work; queued rows stay in the database untouched. Any
    // handler that cannot finish within the grace window keeps its row in
    // `running` and is recovered by lease expiry — work is never deleted.
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = null;
    this.heartbeatTimer = null;
    const start = Date.now();
    while (this.active.size > 0 && Date.now() - start < this.cfg.shutdownGraceMs) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  stats(): QueueStats {
    return {
      pending: -1, // live counts come from pendingCount() (async); -1 = not tracked synchronously
      active: this.active.size,
      enqueued: this.counters.enqueued,
      completed: this.counters.completed,
      failed: this.counters.failed,
      deadLettered: this.counters.deadLettered,
    };
  }

  async pendingCount(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobQueueTable)
      .where(eq(jobQueueTable.status, "pending"));
    return row?.n ?? 0;
  }

  // Deliberate operator/service-level requeue of a dead-lettered job. Never
  // called automatically (no auto-restart of dead letters on boot).
  async requeueDead(id: number): Promise<boolean> {
    const rows = await this.db
      .update(jobQueueTable)
      .set({
        status: "pending",
        attempts: 0,
        availableAt: new Date(),
        deadAt: null,
        lastError: null,
        workerId: null,
        lockedAt: null,
        leaseExpiresAt: null,
      })
      .where(and(eq(jobQueueTable.id, id), eq(jobQueueTable.status, "dead")))
      .returning({ id: jobQueueTable.id });
    return rows.length > 0;
  }

  // ── Worker internals ───────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      await this.recoverExpiredLeases();
      // Re-check after the async sweep: a stop() during recovery must not lead
      // to a claim this worker will never process.
      if (!this.running) return;
      const free = this.cfg.concurrency - this.active.size;
      if (free <= 0) return;
      const rows = await this.claim(free);
      for (const row of rows) void this.run(row);
    } catch (err) {
      logger.error({ err, workerId: this.workerId }, "Job queue poll failed");
    }
  }

  // Atomic claim: a single UPDATE over a SKIP LOCKED selection. The row
  // transition (pending→running), attempt increment, and lease grant happen in
  // one statement — no transaction is held while the handler runs, and two
  // workers can never claim the same row. A worker claims ONLY job names it has
  // handlers registered for — a fleet member missing a handler (e.g. during a
  // rolling upgrade) must leave those jobs for workers that can run them
  // instead of dead-lettering work it merely doesn't understand.
  private async claim(limit: number): Promise<Array<typeof jobQueueTable.$inferSelect>> {
    const names = [...this.handlers.keys()];
    if (names.length === 0) return [];
    const nameList = sql.join(names.map((n) => sql`${n}`), sql`, `);
    const leaseInterval = sql.raw(`interval '${Math.floor(this.cfg.leaseMs)} milliseconds'`);
    const result = await this.db.execute(sql`
      UPDATE ${jobQueueTable} SET
        status = 'running',
        attempts = ${jobQueueTable.attempts} + 1,
        started_at = now(),
        locked_at = now(),
        lease_expires_at = now() + ${leaseInterval},
        worker_id = ${this.workerId}
      WHERE id IN (
        SELECT id FROM ${jobQueueTable}
        WHERE status = 'pending' AND available_at <= now()
          AND name IN (${nameList})
        ORDER BY available_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *;
    `);
    const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows ?? [];
    return rows.map((r) => this.mapRow(r));
  }

  // node-postgres returns snake_case columns from raw SQL; normalize to the
  // drizzle row shape used by the rest of the worker.
  private mapRow(r: Record<string, unknown>): typeof jobQueueTable.$inferSelect {
    return {
      id: Number(r.id),
      name: String(r.name),
      payload: String(r.payload),
      status: String(r.status),
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      backoffBaseMs: Number(r.backoff_base_ms),
      availableAt: new Date(r.available_at as string),
      enqueuedAt: new Date(r.enqueued_at as string),
      startedAt: r.started_at ? new Date(r.started_at as string) : null,
      completedAt: r.completed_at ? new Date(r.completed_at as string) : null,
      lockedAt: r.locked_at ? new Date(r.locked_at as string) : null,
      leaseExpiresAt: r.lease_expires_at ? new Date(r.lease_expires_at as string) : null,
      workerId: r.worker_id ? String(r.worker_id) : null,
      lastError: r.last_error ? String(r.last_error) : null,
      deadAt: r.dead_at ? new Date(r.dead_at as string) : null,
      dedupeKey: r.dedupe_key ? String(r.dedupe_key) : null,
    };
  }

  // Recover rows whose worker died: an expired lease returns the job to
  // pending while attempts remain, else dead-letters it. The claim-time
  // attempt increment means the crashed attempt is already accounted for.
  private async recoverExpiredLeases(): Promise<void> {
    const now = new Date();
    await this.db
      .update(jobQueueTable)
      .set({ status: "pending", workerId: null, lockedAt: null, leaseExpiresAt: null, availableAt: now })
      .where(
        and(
          eq(jobQueueTable.status, "running"),
          lt(jobQueueTable.leaseExpiresAt, now),
          sql`${jobQueueTable.attempts} < ${jobQueueTable.maxAttempts}`,
        ),
      );
    const dead = await this.db
      .update(jobQueueTable)
      .set({ status: "dead", deadAt: now, lastError: "Worker lease expired with no attempts remaining", workerId: null })
      .where(
        and(
          eq(jobQueueTable.status, "running"),
          lt(jobQueueTable.leaseExpiresAt, now),
          sql`${jobQueueTable.attempts} >= ${jobQueueTable.maxAttempts}`,
        ),
      )
      .returning({ id: jobQueueTable.id });
    if (dead.length > 0) {
      this.counters.deadLettered += dead.length;
      logger.error({ ids: dead.map((d) => d.id), workerId: this.workerId }, "Jobs dead-lettered after lease expiry");
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.active.size === 0) return;
    const leaseInterval = sql.raw(`interval '${Math.floor(this.cfg.leaseMs)} milliseconds'`);
    try {
      await this.db
        .update(jobQueueTable)
        .set({ leaseExpiresAt: sql`now() + ${leaseInterval}` })
        .where(
          and(
            inArray(jobQueueTable.id, [...this.active]),
            eq(jobQueueTable.workerId, this.workerId),
            eq(jobQueueTable.status, "running"),
          ),
        );
    } catch (err) {
      logger.error({ err, workerId: this.workerId }, "Job lease heartbeat failed");
    }
  }

  private async run(row: typeof jobQueueTable.$inferSelect): Promise<void> {
    this.active.add(row.id);
    try {
      let payload: unknown;
      try {
        payload = decryptPayload(this.key, row.payload);
      } catch (err) {
        // Undecryptable payload can never succeed — dead-letter immediately,
        // never crash the worker loop, never echo payload material.
        const reason = err instanceof PayloadDecryptError ? err.message : "Payload decode failed";
        await this.markDead(row.id, reason);
        return;
      }
      const handler = this.handlers.get(row.name);
      if (!handler) {
        await this.markDead(row.id, `No handler registered for job "${row.name}"`);
        return;
      }
      const job: Job = {
        id: String(row.id),
        name: row.name,
        payload,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        backoffBaseMs: row.backoffBaseMs,
        enqueuedAt: row.enqueuedAt.getTime(),
      };
      try {
        await handler(payload, job);
        await this.markCompleted(row.id);
      } catch (err) {
        this.counters.failed++;
        const msg = safeHandlerError(err);
        if (row.attempts < row.maxAttempts) {
          const delay = Math.min(row.backoffBaseMs * Math.pow(2, row.attempts - 1), this.cfg.backoffMaxMs);
          logger.warn(
            { job: row.name, id: row.id, attempt: row.attempts, maxAttempts: row.maxAttempts, retryInMs: delay, workerId: this.workerId },
            "Job attempt failed; retry persisted",
          );
          await this.markRetry(row.id, delay, msg);
        } else {
          logger.error(
            { job: row.name, id: row.id, attempts: row.attempts, workerId: this.workerId },
            "Job dead-lettered after exhausting all attempts",
          );
          await this.markDead(row.id, msg);
        }
      }
    } catch (err) {
      // State-recording failure (e.g. DB hiccup). The lease will expire and the
      // job recovers — never crash the loop.
      logger.error({ err, id: row.id, workerId: this.workerId }, "Job state update failed");
    } finally {
      this.active.delete(row.id);
    }
  }

  // Completion/retry/dead-letter belong ONLY to the lease holder: every write
  // is guarded on worker_id so a reclaimed job cannot be finalized by a stale
  // worker.
  private async markCompleted(id: number): Promise<void> {
    const rows = await this.db
      .update(jobQueueTable)
      .set({ status: "completed", completedAt: new Date(), leaseExpiresAt: null })
      .where(and(eq(jobQueueTable.id, id), eq(jobQueueTable.workerId, this.workerId), eq(jobQueueTable.status, "running")))
      .returning({ id: jobQueueTable.id });
    if (rows.length > 0) this.counters.completed++;
    else logger.warn({ id, workerId: this.workerId }, "Completion skipped: lease no longer held (at-least-once re-run)");
  }

  private async markRetry(id: number, delayMs: number, lastError: string): Promise<void> {
    await this.db
      .update(jobQueueTable)
      .set({
        status: "pending",
        availableAt: new Date(Date.now() + delayMs),
        workerId: null,
        lockedAt: null,
        leaseExpiresAt: null,
        lastError,
      })
      .where(and(eq(jobQueueTable.id, id), eq(jobQueueTable.workerId, this.workerId), eq(jobQueueTable.status, "running")));
  }

  private async markDead(id: number, lastError: string): Promise<void> {
    const rows = await this.db
      .update(jobQueueTable)
      .set({ status: "dead", deadAt: new Date(), lastError, leaseExpiresAt: null })
      .where(and(eq(jobQueueTable.id, id), eq(jobQueueTable.workerId, this.workerId), eq(jobQueueTable.status, "running")))
      .returning({ id: jobQueueTable.id });
    if (rows.length > 0) this.counters.deadLettered++;
    else logger.warn({ id, workerId: this.workerId }, "Dead-letter skipped: lease no longer held");
  }
}
