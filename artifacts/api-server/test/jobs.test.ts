import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  invitationsTable,
  notificationsTable,
} from "@workspace/db";
import { InProcessQueue } from "../src/lib/jobs/in-process-queue.js";
import { expireStaleInvitations, cleanupOldNotifications } from "../src/lib/jobs/maintenance.js";
import { deliverEmailViaWorker } from "../src/lib/email/index.js";

// Phase 2.6 — Background jobs & queue. The queue tests are pure (no DB / no network):
// they exercise enqueue/consume, retry-with-backoff, dead-lettering, and stats with a
// tiny backoff so they run fast. The maintenance tests touch the live DB (like the
// other integration suites) under a throwaway tenant that is torn down afterwards.

function makeQueue(overrides?: Partial<{ concurrency: number; maxAttempts: number; backoffBaseMs: number; backoffMaxMs: number }>) {
  return new InProcessQueue({
    driver: "in-process",
    concurrency: overrides?.concurrency ?? 2,
    maxAttempts: overrides?.maxAttempts ?? 3,
    backoffBaseMs: overrides?.backoffBaseMs ?? 5,
    backoffMaxMs: overrides?.backoffMaxMs ?? 50,
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("InProcessQueue", () => {
  it("enqueues and consumes a job", async () => {
    const q = makeQueue();
    const seen: number[] = [];
    q.register<{ n: number }>("sum", async (p) => {
      seen.push(p.n);
    });
    q.start();
    await q.enqueue("sum", { n: 1 });
    await q.enqueue("sum", { n: 2 });
    await waitFor(() => seen.length === 2);
    expect(seen.sort()).toEqual([1, 2]);
    expect(q.stats().completed).toBe(2);
    await q.stop();
  });

  it("retries a transient failure and then succeeds", async () => {
    const q = makeQueue({ maxAttempts: 3, backoffBaseMs: 5 });
    let attempts = 0;
    q.register("flaky", async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
    });
    q.start();
    await q.enqueue("flaky", {});
    await waitFor(() => q.stats().completed === 1);
    expect(attempts).toBe(3);
    expect(q.stats().failed).toBe(2); // two failed attempts before success
    expect(q.stats().deadLettered).toBe(0);
    await q.stop();
  });

  it("dead-letters a job after exhausting all attempts", async () => {
    const q = makeQueue({ maxAttempts: 2, backoffBaseMs: 5 });
    let attempts = 0;
    q.register("always-fails", async () => {
      attempts++;
      throw new Error("permanent");
    });
    q.start();
    await q.enqueue("always-fails", {});
    await waitFor(() => q.stats().deadLettered === 1);
    expect(attempts).toBe(2);
    expect(q.stats().completed).toBe(0);
    expect(q.stats().failed).toBe(2);
    await q.stop();
  });

  it("dead-letters when no handler is registered", async () => {
    const q = makeQueue({ maxAttempts: 1 });
    q.start();
    await q.enqueue("unknown", {});
    await waitFor(() => q.stats().deadLettered === 1);
    expect(q.stats().completed).toBe(0);
    await q.stop();
  });

  it("respects the concurrency ceiling", async () => {
    const q = makeQueue({ concurrency: 2 });
    let active = 0;
    let maxActive = 0;
    let done = 0;
    q.register("slow", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      done++;
    });
    q.start();
    for (let i = 0; i < 6; i++) await q.enqueue("slow", {});
    await waitFor(() => done === 6, 3000);
    expect(maxActive).toBeLessThanOrEqual(2);
    await q.stop();
  });
});

describe("deliverEmailViaWorker (worker-side delivery)", () => {
  it("soft-skips (no throw) when no email provider is configured", async () => {
    // SMTP is unset in the test env, so the worker must report a skip rather than
    // throwing — which is what keeps an unconfigured environment from producing a
    // retry storm / dead-letter flood through the queue.
    const result = await deliverEmailViaWorker({
      to: "nobody@jobs.test",
      subject: "ignored",
      html: "<p>ignored</p>",
      text: "ignored",
    });
    expect(result.sent).toBe(false);
    expect(result.skippedReason).toBe("not_configured");
  });
});

// ---- Maintenance tasks (live DB, isolated fixtures) ----

const SUFFIX = Date.now();
let companyId = 0;
let userId = 0;

async function seedTenant() {
  const [company] = await db
    .insert(companiesTable)
    .values({ name: `QA Jobs ${SUFFIX}`, status: "active" })
    .returning();
  companyId = company.id;
  const [user] = await db
    .insert(usersTable)
    .values({
      companyId,
      email: `qa-jobs-${SUFFIX}@jobs.test`,
      name: "QA Jobs User",
      passwordHash: "x",
      role: "employee",
    })
    .returning();
  userId = user.id;
}

afterAll(async () => {
  if (companyId) {
    await db.delete(notificationsTable).where(eq(notificationsTable.companyId, companyId));
    await db.delete(invitationsTable).where(eq(invitationsTable.companyId, companyId));
    // users + anything FK'd cascade off the company.
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
});

describe("maintenance.expireStaleInvitations", () => {
  it("transitions only pending+expired invitations to expired", async () => {
    if (!companyId) await seedTenant();
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60 * 60_000);
    const [staleInv] = await db
      .insert(invitationsTable)
      .values({ companyId, email: `stale-${SUFFIX}@jobs.test`, tokenHash: `h1-${SUFFIX}`, status: "pending", expiresAt: past })
      .returning();
    const [freshInv] = await db
      .insert(invitationsTable)
      .values({ companyId, email: `fresh-${SUFFIX}@jobs.test`, tokenHash: `h2-${SUFFIX}`, status: "pending", expiresAt: future })
      .returning();
    const [acceptedInv] = await db
      .insert(invitationsTable)
      .values({ companyId, email: `acc-${SUFFIX}@jobs.test`, tokenHash: `h3-${SUFFIX}`, status: "accepted", expiresAt: past })
      .returning();

    const affected = await expireStaleInvitations();
    expect(affected).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select()
      .from(invitationsTable)
      .where(inArray(invitationsTable.id, [staleInv.id, freshInv.id, acceptedInv.id]));
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(staleInv.id)).toBe("expired"); // pending + past -> expired
    expect(byId.get(freshInv.id)).toBe("pending"); // future -> untouched
    expect(byId.get(acceptedInv.id)).toBe("accepted"); // terminal -> untouched

    // Idempotent: a second run does not re-touch the already-expired row.
    const before = (await db.select().from(invitationsTable).where(eq(invitationsTable.id, staleInv.id)))[0].updatedAt;
    await expireStaleInvitations();
    const after = (await db.select().from(invitationsTable).where(eq(invitationsTable.id, staleInv.id)))[0].updatedAt;
    expect(after).toEqual(before);
  });
});

describe("maintenance.cleanupOldNotifications", () => {
  it("deletes read notifications older than the retention window but keeps unread/recent", async () => {
    if (!companyId) await seedTenant();
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000); // 200 days ago
    const [oldRead] = await db
      .insert(notificationsTable)
      .values({ userId, companyId, category: "security", title: "old read", readAt: new Date(), createdAt: old })
      .returning();
    const [oldUnread] = await db
      .insert(notificationsTable)
      .values({ userId, companyId, category: "security", title: "old unread", createdAt: old })
      .returning();
    const [recentRead] = await db
      .insert(notificationsTable)
      .values({ userId, companyId, category: "security", title: "recent read", readAt: new Date() })
      .returning();

    const affected = await cleanupOldNotifications();
    expect(affected).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(inArray(notificationsTable.id, [oldRead.id, oldUnread.id, recentRead.id]));
    const ids = new Set(remaining.map((r) => r.id));
    expect(ids.has(oldRead.id)).toBe(false); // old + read -> deleted
    expect(ids.has(oldUnread.id)).toBe(true); // unread -> kept
    expect(ids.has(recentRead.id)).toBe(true); // recent -> kept
  });
});
