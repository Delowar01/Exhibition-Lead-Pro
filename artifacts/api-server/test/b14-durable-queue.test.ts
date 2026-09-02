// Batch 14 — durable PostgreSQL job queue. Runs directly against the dev
// database (no HTTP involved): every PostgresQueue instance here is an
// independent "worker process" sharing the same job_queue table, which is
// exactly the multi-instance topology the driver must support.
//
// Contract under test: AT-LEAST-ONCE delivery. Accepted jobs survive queue
// destruction/restart, claims are atomic (FOR UPDATE SKIP LOCKED), retry state
// lives in the database (not in timers), exhausted jobs dead-letter and stay
// put, crashed workers are recovered via lease expiry, healthy workers are
// protected by heartbeat, dedupe keys are DB-enforced, and payloads are stored
// only as AES-256-GCM envelopes — never plaintext.
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { and, eq, gte, like, or, sql } from "drizzle-orm";
import { db, jobQueueTable } from "@workspace/db";
import { PostgresQueue, type PostgresQueueConfig } from "../src/lib/jobs/postgres-queue.js";
import { dispatchRecurring, RECURRING_SWEEP_JOB } from "../src/lib/jobs/scheduler.js";
import { registerEmailHandler } from "../src/lib/jobs/handlers.js";
import { EMAIL_SEND_JOB } from "../src/lib/email/index.js";
import { logger } from "../src/lib/logger.js";

const KEY_A = "b14-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "b14-test-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RUN = Date.now();
const jobName = (label: string) => `b14:${RUN}:${label}`;

const queues: PostgresQueue[] = [];
const testStart = new Date(Date.now() - 1000);

function makeQueue(overrides: Partial<PostgresQueueConfig> = {}): PostgresQueue {
  const q = new PostgresQueue({
    concurrency: 3,
    maxAttempts: 5,
    backoffBaseMs: 50,
    backoffMaxMs: 500,
    pollIntervalMs: 50,
    leaseMs: 5_000,
    shutdownGraceMs: 2_000,
    payloadEncryptionKey: KEY_A,
    ...overrides,
  });
  queues.push(q);
  return q;
}

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 8_000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function rowByName(name: string) {
  const [row] = await db.select().from(jobQueueTable).where(eq(jobQueueTable.name, name)).limit(1);
  return row;
}

afterEach(async () => {
  // Stop every worker between tests so a lingering poll can't touch the next
  // test's rows.
  await Promise.all(queues.splice(0).map((q) => q.stop()));
});

afterAll(async () => {
  await db
    .delete(jobQueueTable)
    .where(
      or(
        like(jobQueueTable.name, `b14:${RUN}:%`),
        like(jobQueueTable.dedupeKey, `b14:${RUN}:%`),
        and(eq(jobQueueTable.name, EMAIL_SEND_JOB), gte(jobQueueTable.enqueuedAt, testStart)),
        and(eq(jobQueueTable.name, RECURRING_SWEEP_JOB), gte(jobQueueTable.enqueuedAt, testStart)),
      ),
    );
});

describe("persistence across restart", () => {
  it("a job enqueued before a 'crash' is executed by a fresh worker", async () => {
    const name = jobName("persist");
    const producer = makeQueue();
    await producer.enqueue(name, { value: 42 });
    // Simulate the process dying before any worker ran: the producer is never
    // started and is discarded entirely.
    await producer.stop();

    const seen: unknown[] = [];
    const worker = makeQueue();
    worker.register<{ value: number }>(name, async (p) => {
      seen.push(p.value);
    });
    worker.start();
    await until(() => seen.length === 1, 8_000, "job executed after restart");
    expect(seen).toEqual([42]);
    await until(async () => (await rowByName(name))?.status === "completed", 8_000, "row completed");
  });
});

describe("atomic claiming", () => {
  it("two workers never double-execute one job", async () => {
    const name = jobName("claim");
    let executions = 0;
    const handler = async () => {
      executions++;
      await new Promise((r) => setTimeout(r, 300));
    };
    const w1 = makeQueue();
    const w2 = makeQueue();
    w1.register(name, handler);
    w2.register(name, handler);
    const producer = makeQueue();
    await producer.enqueue(name, {});
    w1.start();
    w2.start();
    await until(async () => (await rowByName(name))?.status === "completed", 8_000, "job completed");
    // Give the second worker every chance to (incorrectly) run it again.
    await new Promise((r) => setTimeout(r, 400));
    expect(executions).toBe(1);
  });
});

describe("retry persistence (database time is authoritative)", () => {
  it("a failed attempt's retry survives a worker restart", async () => {
    const name = jobName("retry");
    const attemptsSeen: number[] = [];
    const w1 = makeQueue();
    w1.register(name, async (_p, job) => {
      attemptsSeen.push(job.attempts);
      throw new Error("transient failure");
    });
    await w1.enqueue(name, {}, { maxAttempts: 3, backoffBaseMs: 400 });
    w1.start();
    await until(() => attemptsSeen.length === 1, 8_000, "first attempt failed");
    // "Process stops before the retry runs" — the retry state must be in the DB.
    await w1.stop();
    const row = await rowByName(name);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(row.lastError).toBe("Handler failed (Error)"); // raw handler text is never persisted

    // Fresh "process": the job becomes runnable when available_at arrives.
    const w2 = makeQueue();
    const succeeded: number[] = [];
    w2.register(name, async (_p, job) => {
      succeeded.push(job.attempts);
    });
    w2.start();
    await until(async () => (await rowByName(name))?.status === "completed", 8_000, "retry executed after restart");
    expect(succeeded).toEqual([2]);
  });
});

describe("dead-letter", () => {
  it("stops after max attempts, persists sanitized error, never runs again", async () => {
    const name = jobName("dead");
    let executions = 0;
    const w = makeQueue();
    w.register(name, async () => {
      executions++;
      throw new Error("permanent failure sentinel");
    });
    await w.enqueue(name, { secret: "not-in-error" }, { maxAttempts: 2, backoffBaseMs: 50 });
    w.start();
    await until(async () => (await rowByName(name))?.status === "dead", 8_000, "dead-lettered");
    const row = await rowByName(name);
    expect(row.attempts).toBe(2);
    expect(row.deadAt).not.toBeNull();
    expect(row.lastError).toBe("Handler failed (Error)"); // sanitized: class only, no handler text
    expect(row.lastError).not.toContain("not-in-error");
    // No further automatic executions — including across a worker restart.
    const before = executions;
    await new Promise((r) => setTimeout(r, 400));
    expect(executions).toBe(before);
    const w2 = makeQueue();
    w2.register(name, async () => {
      executions++;
    });
    w2.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(executions).toBe(before);
    // Deliberate service-level requeue IS possible (never automatic).
    expect(await w2.requeueDead(row.id)).toBe(true);
    await until(async () => (await rowByName(name))?.status === "completed", 8_000, "requeued dead job ran");
  });
});

describe("lease recovery", () => {
  it("a job claimed by a dead worker is recovered with correct attempt accounting", async () => {
    const name = jobName("lease");
    const producer = makeQueue();
    await producer.enqueue(name, {}, { maxAttempts: 3 });
    // Simulate a worker that claimed the job (attempt 1) and then died: the row
    // sits in `running` with an expired lease and no live heartbeat.
    await db
      .update(jobQueueTable)
      .set({
        status: "running",
        attempts: 1,
        workerId: "dead-worker",
        lockedAt: new Date(Date.now() - 60_000),
        leaseExpiresAt: new Date(Date.now() - 30_000),
        startedAt: new Date(Date.now() - 60_000),
      })
      .where(eq(jobQueueTable.name, name));

    const attemptsSeen: number[] = [];
    const w2 = makeQueue();
    w2.register(name, async (_p, job) => {
      attemptsSeen.push(job.attempts);
    });
    w2.start();
    await until(async () => (await rowByName(name))?.status === "completed", 8_000, "recovered and completed");
    // The crashed claim consumed attempt 1; the recovery run is attempt 2.
    expect(attemptsSeen).toEqual([2]);
    const row = await rowByName(name);
    expect(row.workerId).toBe(w2.workerId);
  });

  it("an expired lease with no attempts remaining dead-letters instead of looping", async () => {
    const name = jobName("lease-dead");
    const producer = makeQueue();
    await producer.enqueue(name, {}, { maxAttempts: 1 });
    await db
      .update(jobQueueTable)
      .set({ status: "running", attempts: 1, workerId: "dead-worker", leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(jobQueueTable.name, name));
    const w = makeQueue();
    w.register(name, async () => {});
    w.start();
    await until(async () => (await rowByName(name))?.status === "dead", 8_000, "dead-lettered on expiry");
    expect((await rowByName(name)).lastError).toContain("lease expired");
  });
});

describe("heartbeat", () => {
  it("a live long-running handler is not stolen by another worker", async () => {
    const name = jobName("heartbeat");
    let executions = 0;
    // Lease far shorter than the handler runtime: only the heartbeat keeps it.
    const w1 = makeQueue({ leaseMs: 1_500 });
    w1.register(name, async () => {
      executions++;
      await new Promise((r) => setTimeout(r, 2_500));
    });
    const w2 = makeQueue({ leaseMs: 1_500 });
    w2.register(name, async () => {
      executions++;
    });
    await w1.enqueue(name, {});
    w1.start();
    await until(() => executions >= 1, 8_000, "w1 started the job");
    w2.start();
    await until(async () => (await rowByName(name))?.status === "completed", 10_000, "long job completed");
    const row = await rowByName(name);
    expect(executions).toBe(1); // never stolen mid-heartbeat
    expect(row.workerId).toBe(w1.workerId);
    expect(row.attempts).toBe(1);
  });
});

describe("idempotent enqueue (DB-enforced dedupe)", () => {
  it("concurrent enqueues with one dedupe key produce exactly one logical job", async () => {
    const name = jobName("dedupe");
    const key = `b14:${RUN}:dedupe-key`;
    const q = makeQueue();
    await Promise.all(
      Array.from({ length: 10 }, () => q.enqueue(name, { n: 1 }, { dedupeKey: key })),
    );
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobQueueTable)
      .where(eq(jobQueueTable.name, name));
    expect(row.n).toBe(1);
    // Jobs without a dedupe key are unaffected.
    await q.enqueue(name, { n: 2 });
    await q.enqueue(name, { n: 3 });
    const [after] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobQueueTable)
      .where(eq(jobQueueTable.name, name));
    expect(after.n).toBe(3);
  });
});

describe("payload security", () => {
  const SENTINEL = `reset-token-${RUN}-SENTINEL`;

  it("plaintext never reaches the persisted row; the worker still decrypts it", async () => {
    const name = jobName("crypto");
    const w = makeQueue();
    const seen: string[] = [];
    w.register<{ link: string }>(name, async (p) => {
      seen.push(p.link);
    });
    await w.enqueue(name, { link: `https://example.test/reset?token=${SENTINEL}` });

    const row = await rowByName(name);
    expect(row.payload.startsWith("gcm1.")).toBe(true);
    expect(row.payload).not.toContain(SENTINEL);
    expect(row.payload).not.toContain("reset");
    // Whole-row sweep: the sentinel must not appear anywhere in the stored row.
    expect(JSON.stringify(row)).not.toContain(SENTINEL);

    w.start();
    await until(() => seen.length === 1, 8_000, "worker decrypted payload");
    expect(seen[0]).toContain(SENTINEL);
    expect((await rowByName(name)).lastError).toBeNull();
  });

  it("an undecryptable payload dead-letters safely without crashing the worker", async () => {
    const nameBad = jobName("wrong-key");
    const nameGood = jobName("after-bad");
    const producerA = makeQueue({ payloadEncryptionKey: KEY_A });
    await producerA.enqueue(nameBad, { link: `https://example.test/x?token=${SENTINEL}` });

    // Worker running with the WRONG key: authentication fails, the job is
    // dead-lettered with a sanitized error, and the loop keeps processing.
    const workerB = makeQueue({ payloadEncryptionKey: KEY_B });
    workerB.register(nameBad, async () => {});
    workerB.register(nameGood, async () => {});
    workerB.start();
    await until(async () => (await rowByName(nameBad))?.status === "dead", 8_000, "undecryptable job dead-lettered");
    const row = await rowByName(nameBad);
    expect(row.lastError).toContain("decryption failed");
    expect(row.lastError).not.toContain(SENTINEL);

    // The worker loop is still alive and processes the next (valid) job.
    await workerB.enqueue(nameGood, { ok: true });
    await until(async () => (await rowByName(nameGood))?.status === "completed", 8_000, "worker loop survived");
  });
});

describe("handler errors never leak payload material (final correction)", () => {
  it("a handler error interpolating the decrypted payload leaves no trace in row or logs", async () => {
    const SENTINEL = `leak-sentinel-${RUN}-TOKEN`;
    const name = jobName("error-leak");

    // Capture every queue-generated log line for the duration of the test.
    const captured: unknown[][] = [];
    const spies = (["info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        captured.push(args);
      }) as never),
    );
    try {
      const q = makeQueue();
      q.register<{ link: string }>(name, async (p) => {
        // Worst case: the handler throws with the decrypted payload in the message.
        throw new Error(`could not deliver ${p.link}`);
      });
      await q.enqueue(name, { link: `https://example.test/reset?token=${SENTINEL}` }, { maxAttempts: 2, backoffBaseMs: 50 });
      q.start();
      await until(async () => (await rowByName(name))?.status === "dead", 8_000, "retried then dead-lettered");

      const row = await rowByName(name);
      expect(row.attempts).toBe(2); // retry happened, then dead-letter
      expect(row.payload).not.toContain(SENTINEL); // encrypted at rest
      expect(row.lastError).toBe("Handler failed (Error)"); // sanitized
      expect(JSON.stringify(row)).not.toContain(SENTINEL); // whole-row sweep
      const logDump = JSON.stringify(captured);
      expect(logDump).not.toContain(SENTINEL); // queue logs never echo it
      expect(logDump).not.toContain("could not deliver");
    } finally {
      spies.forEach((sp) => sp.mockRestore());
    }
  });
});

describe("recurring dispatch dedupe", () => {
  it("a cadence bucket dispatches once — even after its sweep already completed", async () => {
    const q = makeQueue();
    const now = Date.now();
    const task = `b14task${RUN}`;
    const interval = 60 * 60 * 1000;
    await Promise.all([
      dispatchRecurring(q, task, interval, now),
      dispatchRecurring(q, task, interval, now + 10), // same bucket, concurrent dispatcher
    ]);
    const rows = async () =>
      db
        .select()
        .from(jobQueueTable)
        .where(and(eq(jobQueueTable.name, RECURRING_SWEEP_JOB), like(jobQueueTable.dedupeKey, `recurring:${task}:%`)));
    expect((await rows()).length).toBe(1);

    // Execute/complete the sweep, then dispatch the SAME bucket again: the
    // completed row still reserves the key — no duplicate sweep is created.
    let sweeps = 0;
    q.register(RECURRING_SWEEP_JOB, async () => {
      sweeps++;
    });
    q.start();
    await until(async () => (await rows())[0]?.status === "completed", 8_000, "sweep completed");
    expect(sweeps).toBe(1);
    await dispatchRecurring(q, task, interval, now + 20); // same bucket, post-completion
    await new Promise((r) => setTimeout(r, 300));
    expect((await rows()).length).toBe(1);
    expect(sweeps).toBe(1); // no re-execution

    // The NEXT cadence bucket still dispatches a fresh sweep.
    await dispatchRecurring(q, task, interval, now + interval);
    expect((await rows()).length).toBe(2);
    await q.stop();
    await db.delete(jobQueueTable).where(like(jobQueueTable.dedupeKey, `recurring:${task}:%`));
  });
});

describe("bounded concurrency under overlapping poll triggers (final correction)", () => {
  it("a single-slot worker never runs two handlers at once, even with rapid poll ticks", async () => {
    const name = jobName("poll-overlap");
    // Fastest allowed poll cadence + handlers much slower than the interval:
    // every handler execution spans many poll TRIGGERS, so without the
    // in-flight guard two overlapping polls could each see active.size = 0,
    // both compute free = 1, and together claim two rows for a concurrency-1
    // worker. FOR UPDATE SKIP LOCKED cannot prevent that (different rows).
    const q = makeQueue({ concurrency: 1, pollIntervalMs: 25 });
    let current = 0;
    let maxConcurrent = 0;
    let completed = 0;
    q.register(name, async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 150));
      current--;
      completed++;
    });
    for (let i = 0; i < 6; i++) await q.enqueue(name, { i });
    q.start();
    await until(() => completed === 6, 15_000, "all jobs processed");
    expect(maxConcurrent).toBe(1); // the configured ceiling held throughout

    // The ceiling scales with configuration, not with poll timing: a 2-slot
    // worker may run two at once but never three.
    const name2 = jobName("poll-overlap-2");
    const q2 = makeQueue({ concurrency: 2, pollIntervalMs: 25 });
    let current2 = 0;
    let max2 = 0;
    let done2 = 0;
    q2.register(name2, async () => {
      current2++;
      max2 = Math.max(max2, current2);
      await new Promise((r) => setTimeout(r, 120));
      current2--;
      done2++;
    });
    for (let i = 0; i < 6; i++) await q2.enqueue(name2, { i });
    q2.start();
    await until(() => done2 === 6, 15_000, "all jobs processed (2-slot)");
    expect(max2).toBeLessThanOrEqual(2);
    expect(max2).toBeGreaterThan(0);
  });
});

describe("stale-worker lease ownership (final correction)", () => {
  it("a worker that lost its lease cannot dead-letter a row reclaimed by another worker", async () => {
    const name = jobName("stale-dead");
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Worker A: single attempt, handler blocks until released, then fails —
    // driving A straight into its markDead path.
    const wA = makeQueue();
    wA.register(name, async () => {
      await gate;
      throw new Error("late terminal failure");
    });
    await wA.enqueue(name, {}, { maxAttempts: 1 });
    wA.start();
    await until(async () => (await rowByName(name))?.status === "running", 8_000, "A claimed the job");
    const claimed = await rowByName(name);
    expect(claimed.workerId).toBe(wA.workerId);

    // A's lease expires and the row is reclaimed by worker B (simulated
    // deterministically: ownership transferred, fresh lease).
    await db
      .update(jobQueueTable)
      .set({ workerId: "b14-worker-B", leaseExpiresAt: new Date(Date.now() + 60_000), attempts: 2, maxAttempts: 2 })
      .where(eq(jobQueueTable.name, name));

    // Stale A now reaches its terminal-failure write — it must be a no-op.
    release!();
    await new Promise((r) => setTimeout(r, 300));
    const after = await rowByName(name);
    expect(after.status).toBe("running"); // NOT dead
    expect(after.deadAt).toBeNull();
    expect(after.workerId).toBe("b14-worker-B"); // B remains authoritative
    await wA.stop();

    // …and the job can still be processed to completion by a live worker.
    await db
      .update(jobQueueTable)
      .set({ status: "pending", workerId: null, leaseExpiresAt: null, availableAt: new Date(), attempts: 0 })
      .where(eq(jobQueueTable.name, name));
    const wB = makeQueue();
    wB.register(name, async () => {});
    wB.start();
    await until(async () => (await rowByName(name))?.status === "completed", 8_000, "B completed the job");
  });
});

describe("dedupe persists across terminal states (final correction)", () => {
  it("a COMPLETED job's dedupe key still rejects a re-enqueue", async () => {
    const name = jobName("dedupe-completed");
    const key = `b14:${RUN}:dedupe-completed-X`;
    const q = makeQueue();
    q.register(name, async () => {});
    await q.enqueue(name, { n: 1 }, { dedupeKey: key });
    q.start();
    await until(async () => (await rowByName(name))?.status === "completed", 8_000, "first job completed");

    await q.enqueue(name, { n: 2 }, { dedupeKey: key });
    await new Promise((r) => setTimeout(r, 300));
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobQueueTable)
      .where(eq(jobQueueTable.name, name));
    expect(count.n).toBe(1); // no second row accepted
    expect((await rowByName(name)).status).toBe("completed"); // original untouched
  });

  it("a DEAD job's key rejects re-enqueue; requeueDead revives the ORIGINAL row", async () => {
    const name = jobName("dedupe-dead");
    const key = `b14:${RUN}:dedupe-dead-Y`;
    let failing = true;
    const q = makeQueue();
    q.register(name, async () => {
      if (failing) throw new Error("fail until requeued");
    });
    await q.enqueue(name, { n: 1 }, { dedupeKey: key, maxAttempts: 1 });
    q.start();
    await until(async () => (await rowByName(name))?.status === "dead", 8_000, "job dead-lettered");
    const dead = await rowByName(name);

    await q.enqueue(name, { n: 2 }, { dedupeKey: key });
    await new Promise((r) => setTimeout(r, 300));
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobQueueTable)
      .where(eq(jobQueueTable.name, name));
    expect(count.n).toBe(1); // dead row reserves the key

    // Deliberate requeue revives the SAME row and it runs to completion.
    failing = false;
    expect(await q.requeueDead(dead.id)).toBe(true);
    await until(async () => (await rowByName(name))?.status === "completed", 8_000, "requeued original ran");
    expect((await rowByName(name)).id).toBe(dead.id);
  });
});

describe("existing producers on the durable driver", () => {
  it("the email handler runs through PostgresQueue (soft-skip path, encrypted at rest)", async () => {
    // SMTP is not configured in this environment, so delivery soft-skips —
    // which is exactly the existing handler contract; the job completes.
    const q = makeQueue({ maxAttempts: 2, backoffBaseMs: 50 });
    registerEmailHandler(q);
    const marker = `b14-email-${RUN}`;
    await q.enqueue(EMAIL_SEND_JOB, {
      to: `${marker}@example.test`,
      subject: `${marker} subject`,
      text: `secret link https://example.test/invite?token=${marker}-TOKEN`,
      html: `<a href="https://example.test/invite?token=${marker}-TOKEN">join</a>`,
    });
    const [row] = await db
      .select()
      .from(jobQueueTable)
      .where(and(eq(jobQueueTable.name, EMAIL_SEND_JOB), gte(jobQueueTable.enqueuedAt, testStart)))
      .orderBy(sql`${jobQueueTable.id} desc`)
      .limit(1);
    expect(row.payload).not.toContain(marker);
    expect(row.payload).not.toContain("token");
    q.start();
    await until(async () => {
      const [r] = await db.select().from(jobQueueTable).where(eq(jobQueueTable.id, row.id)).limit(1);
      return r?.status === "completed";
    }, 8_000, "email job completed via durable driver");
  });
});
