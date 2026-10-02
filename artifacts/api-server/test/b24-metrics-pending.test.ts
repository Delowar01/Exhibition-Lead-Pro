// Batch 24 — GET /metrics reports the LIVE job-queue pending count.
//
// Live-API suite (needs the stack behind http://localhost:80). The durable
// proofs use a dedicated, never-started PostgresQueue against the same database
// the running API uses: rows are enqueued with a far-future available_at so no
// worker can claim them, then read back through liveStats() and compared with a
// direct count of the job_queue table. Every row this file creates carries a
// unique name prefix and is deleted in afterAll.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { db, jobQueueTable, type Db } from "@workspace/db";
import { PostgresQueue } from "../src/lib/jobs/postgres-queue.js";
import { InProcessQueue } from "../src/lib/jobs/in-process-queue.js";

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const PREFIX = `b24:${RUN}:`;
const FAR_FUTURE_MS = 6 * 60 * 60 * 1000; // never runnable during the test
const STATS_KEYS = ["pending", "active", "enqueued", "completed", "failed", "deadLettered"].sort();

async function login(creds: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (await res.json()).token as string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function directPendingTotal(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobQueueTable)
    .where(eq(jobQueueTable.status, "pending"));
  return row!.n;
}

async function mine(status: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobQueueTable)
    .where(and(like(jobQueueTable.name, `${PREFIX}%`), eq(jobQueueTable.status, status)));
  return row!.n;
}

function durableQueue(database?: Db): PostgresQueue {
  return new PostgresQueue(
    {
      concurrency: 1,
      maxAttempts: 3,
      backoffBaseMs: 50,
      backoffMaxMs: 500,
      pollIntervalMs: 60_000,
      leaseMs: 60_000,
      shutdownGraceMs: 500,
      payloadEncryptionKey: `b24-metrics-test-key-${RUN}`,
    },
    database,
  );
}

let platformToken: string;
let techcorpToken: string;
const durable = durableQueue(); // never started: it only inserts and reads rows
const memory = new InProcessQueue({ driver: "in-process", concurrency: 1, maxAttempts: 3, backoffBaseMs: 50, backoffMaxMs: 500 });

beforeAll(async () => {
  const health = await fetch(`${BASE}/healthz`).catch((err) => {
    throw new Error(`API not reachable at ${BASE} (${String(err)})`);
  });
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);
  platformToken = await login(PLATFORM);
  techcorpToken = await login(TECHCORP);
});

afterAll(async () => {
  await db.delete(jobQueueTable).where(like(jobQueueTable.name, `${PREFIX}%`));
  await memory.stop();
});

describe("GET /metrics — authorization is unchanged", () => {
  it("rejects unauthenticated callers", async () => {
    expect((await fetch(`${BASE}/metrics`)).status).toBe(401);
  });

  it("rejects tenant administrators", async () => {
    expect((await fetch(`${BASE}/metrics`, { headers: auth(techcorpToken) })).status).toBe(403);
  });

  it("answers the platform owner with a non-negative integer pending count and the six documented counters only", async () => {
    const res = await fetch(`${BASE}/metrics`, { headers: auth(platformToken) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.jobs).sort()).toEqual(STATS_KEYS);
    expect(Number.isInteger(body.jobs.pending)).toBe(true);
    expect(body.jobs.pending).toBeGreaterThanOrEqual(0);
    for (const k of ["active", "enqueued", "completed", "failed", "deadLettered"]) {
      expect(Number.isInteger(body.jobs[k])).toBe(true);
      expect(body.jobs[k]).toBeGreaterThanOrEqual(0);
    }
    // Operational internals only — no tenant data, no row contents.
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/payload|company|email|job_queue|postgres/i);
  });
});

describe("durable driver — pending is read live from job_queue", () => {
  it("a known pending durable job increases the live count; delayed and retry-scheduled rows are pending", async () => {
    const before = await durable.liveStats();
    expect(before.pending).toBeGreaterThanOrEqual(0);

    await durable.enqueue(`${PREFIX}delayed-1`, { k: 1 }, { delayMs: FAR_FUTURE_MS });
    await durable.enqueue(`${PREFIX}delayed-2`, { k: 2 }, { delayMs: FAR_FUTURE_MS });
    // A retry waiting for its backoff is persisted exactly like a delayed job:
    // status=pending with attempts > 0 and a future available_at.
    await durable.enqueue(`${PREFIX}retry-1`, { k: 3 }, { delayMs: FAR_FUTURE_MS });
    await db
      .update(jobQueueTable)
      .set({ attempts: 1, lastError: "simulated failure (test)" })
      .where(eq(jobQueueTable.name, `${PREFIX}retry-1`));
    expect(await mine("pending")).toBe(3);

    const lo = await directPendingTotal();
    const live = await durable.liveStats();
    const hi = await directPendingTotal();
    expect(live.pending).toBeGreaterThanOrEqual(3);
    expect(live.pending).toBeGreaterThanOrEqual(Math.min(lo, hi));
    expect(live.pending).toBeLessThanOrEqual(Math.max(lo, hi));
    expect(live.pending).toBeGreaterThanOrEqual(before.pending + 3 - 0); // nothing of ours could have been claimed
  });

  it("completed and dead rows are not counted as pending", async () => {
    await durable.enqueue(`${PREFIX}done-1`, { k: 4 }, { delayMs: FAR_FUTURE_MS });
    await durable.enqueue(`${PREFIX}dead-1`, { k: 5 }, { delayMs: FAR_FUTURE_MS });
    const now = new Date();
    await db.update(jobQueueTable).set({ status: "completed", completedAt: now }).where(eq(jobQueueTable.name, `${PREFIX}done-1`));
    await db.update(jobQueueTable).set({ status: "dead", deadAt: now, lastError: "exhausted (test)" }).where(eq(jobQueueTable.name, `${PREFIX}dead-1`));
    expect(await mine("completed")).toBe(1);
    expect(await mine("dead")).toBe(1);
    expect(await mine("pending")).toBe(3);

    const lo = await directPendingTotal();
    const live = await durable.liveStats();
    const hi = await directPendingTotal();
    expect(live.pending).toBeGreaterThanOrEqual(Math.min(lo, hi));
    expect(live.pending).toBeLessThanOrEqual(Math.max(lo, hi));
    expect(live.pending).toBeGreaterThanOrEqual(3);
  });

  it("the live view is never negative even though the synchronous process view cannot track durable rows", async () => {
    expect(durable.stats().pending).toBe(-1); // internal, synchronous, never served
    const live = await durable.liveStats();
    expect(Number.isInteger(live.pending)).toBe(true);
    expect(live.pending).toBeGreaterThanOrEqual(0);
    // Every other counter is carried through unchanged.
    const sync = durable.stats();
    expect({ ...live, pending: -1 }).toEqual(sync);
  });

  it("the running API reports the durable rows through GET /metrics (API started with JOBS_DRIVER=postgres)", async ({ skip }) => {
    if (process.env.JOBS_DRIVER !== "postgres") {
      skip("the API under test runs the in-process driver (JOBS_DRIVER is not 'postgres' in this shell)");
    }
    const lo = await directPendingTotal();
    const res = await fetch(`${BASE}/metrics`, { headers: auth(platformToken) });
    const hi = await directPendingTotal();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.pending).toBeGreaterThanOrEqual(3);
    expect(body.jobs.pending).toBeGreaterThanOrEqual(Math.min(lo, hi));
    expect(body.jobs.pending).toBeLessThanOrEqual(Math.max(lo, hi));
  });

  it("a failure to read durable state rejects — it is never converted into a false zero", async () => {
    const refusing = {
      select: () => {
        throw new Error("connection refused (test double)");
      },
    } as unknown as Db;
    await expect(durableQueue(refusing).liveStats()).rejects.toThrow(/connection refused/);

    const malformed = {
      select: () => ({ from: () => ({ where: async () => [{ n: null }] }) }),
    } as unknown as Db;
    await expect(durableQueue(malformed).liveStats()).rejects.toThrow(/pending count unavailable/);

    const empty = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
    } as unknown as Db;
    await expect(durableQueue(empty).liveStats()).rejects.toThrow(/pending count unavailable/);
  });
});

describe("in-process driver — live stats equal the in-memory calculation", () => {
  it("counts ready and delayed jobs and never goes negative", async () => {
    expect(memory.stats().pending).toBe(0);
    await memory.enqueue(`${PREFIX}mem-1`, { k: 1 }, { delayMs: FAR_FUTURE_MS });
    await memory.enqueue(`${PREFIX}mem-2`, { k: 2 }, { delayMs: FAR_FUTURE_MS });
    const sync = memory.stats();
    const live = await memory.liveStats();
    expect(sync.pending).toBe(2);
    expect(live).toEqual(sync);
    expect(live.pending).toBeGreaterThanOrEqual(0);
    expect(Object.keys(live).sort()).toEqual(STATS_KEYS);
  });
});
