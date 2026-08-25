import { pgTable, serial, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Durable background-job queue (Batch 14). PostgreSQL is the durable transport
// behind the provider-agnostic JobQueue abstraction: once a job row is inserted,
// an API restart/crash cannot silently lose it. The queue contract is
// AT-LEAST-ONCE — a job may run more than once (e.g. worker death after the
// handler finished but before completion was recorded), never zero times once
// accepted.
//
// State machine:
//   pending   → waiting; runnable when available_at <= now()
//   running   → claimed under a lease (worker_id + lease_expires_at); the
//               worker heartbeats the lease while its handler is active. An
//               expired lease is reclaimed: back to pending while attempts
//               remain, else dead.
//   completed → handler finished; kept until retention removes it
//   dead      → attempts exhausted (or payload undecryptable / no handler);
//               kept for diagnosis, retried only by an explicit operator call
//
// `payload` is an authenticated-encryption envelope (AES-256-GCM, key from
// JOBS_PAYLOAD_ENCRYPTION_KEY) — email jobs carry reset/invitation links, so
// durable persistence must never become a plaintext token store. `dedupe_key`
// is enforced by a partial unique index over ACTIVE (pending/running) rows so
// concurrent idempotent enqueues cannot race a check-then-insert.
export const jobQueueTable = pgTable(
  "job_queue",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    payload: text("payload").notNull(), // encrypted envelope, never plaintext
    status: text("status").notNull().default("pending"), // pending | running | completed | dead
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    backoffBaseMs: integer("backoff_base_ms").notNull().default(2000),
    availableAt: timestamp("available_at").notNull().defaultNow(), // delayed jobs + persisted retry time
    enqueuedAt: timestamp("enqueued_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    lockedAt: timestamp("locked_at"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    workerId: text("worker_id"),
    lastError: text("last_error"), // sanitized message only — never payload content
    deadAt: timestamp("dead_at"),
    dedupeKey: text("dedupe_key"),
  },
  (t) => [
    // Claim path: ready jobs by availability.
    index("job_queue_claim_idx").on(t.status, t.availableAt),
    // Lease-recovery sweep: running rows by lease expiry.
    index("job_queue_lease_idx").on(t.status, t.leaseExpiresAt),
    index("job_queue_name_idx").on(t.name),
    // DB-enforced idempotent enqueue: one ACTIVE row per dedupe key.
    uniqueIndex("job_queue_dedupe_active_ux")
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('pending', 'running')`),
  ],
);

export type JobQueueRow = typeof jobQueueTable.$inferSelect;
