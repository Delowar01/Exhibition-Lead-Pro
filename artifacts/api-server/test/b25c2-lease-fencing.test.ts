// B25 Correction 2 — upload lease FENCING. One upload intent admits exactly one
// publication attempt; an expired or lost lease can never modify or delete
// another attempt's result, and company deletion fences in-flight writers.
//   • a second PUT on an intent whose lease expired is refused (409) — the
//     client reserves a fresh object; the same row/key is never reclaimed
//   • a stale writer that resumes (primary or mirror publish, mirror failure,
//     database release failure) removes ONLY its own copies and never touches
//     a staged / active row or another attempt's bytes
//   • company deletion while a writer is paused (before publication, between
//     primary and mirror) leaves no bytes behind once the writer resumes
//   • a stale rollback never regresses a staged / active / deleting / deleted row
//   • after every scenario: no untracked primary, mirror or temporary bytes
// Deterministic: explicit publish barriers in the fake drivers, injected lease
// expiry (no sleeps), fake in-memory GCS adapter, real storage_objects table.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { eq, inArray } from "drizzle-orm";
import { db, storageObjectsTable, companiesTable } from "@workspace/db";
import { config } from "../src/config.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import { __resetStorageCountersForTests } from "../src/storage/metrics.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as storage from "../src/services/storage.service.js";
import type { AuthUser } from "../src/middlewares/requireAuth.js";

vi.mock("../src/repositories/storage-objects.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/storage-objects.repository.js")>();
  return { ...actual, releaseUpload: vi.fn(actual.releaseUpload) };
});

type MutableStorageConfig = { driver: string; bucketId: string; privateObjectDir: string; legacyFallback: boolean; mirror: boolean; legacyDelete: boolean; pendingTtlMs: number; stagedTtlMs: number; uploadLeaseMs: number };
const os = config.objectStorage as unknown as MutableStorageConfig;
const original = { ...os };

let COMPANY = 0;
const companies: number[] = [];
let primary: MemoryStorageDriver;
let gcs: MemoryStorageDriver;
let user: AuthUser;

function sha(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}
async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}
/** One-shot publish barrier for a specific key: the FIRST publisher of `match` pauses until released; everyone else passes. */
function gate(match: (key: string) => boolean) {
  let arrive!: () => void;
  let release!: () => void;
  let tripped = false;
  const arrived = new Promise<void>((r) => (arrive = r));
  const released = new Promise<void>((r) => (release = r));
  return {
    arrived,
    release,
    hook: async (key: string) => {
      if (tripped || !match(key)) return;
      tripped = true;
      arrive();
      await released;
    },
  };
}
async function rowsOf(companyId: number) {
  return db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, companyId));
}
/** Every byte in both stores belongs to a staged/active row, and every staged/active row's copies carry its digest. */
async function assertNoUntracked(companyId: number) {
  const rows = await rowsOf(companyId);
  const live = rows.filter((r) => r.state === "staged" || r.state === "active");
  const allowedPrimary = new Set(live.map((r) => r.storageKey));
  const allowedMirror = new Set(live.filter((r) => r.mirrorState === "ok" && r.mirrorKey).map((r) => r.mirrorKey!));
  for (const key of primary.objects.keys()) expect(allowedPrimary.has(key), `untracked primary object ${key}`).toBe(true);
  for (const key of gcs.objects.keys()) expect(allowedMirror.has(key), `untracked mirror object ${key}`).toBe(true);
  for (const r of live) {
    expect(primary.objects.get(r.storageKey)?.sha256, `primary copy of ${r.id}`).toBe(r.sha256);
    if (r.mirrorState === "ok") expect(gcs.objects.get(r.mirrorKey!)?.sha256, `mirror copy of ${r.id}`).toBe(r.sha256);
  }
  for (const r of rows) expect(r.state === "uploading" && r.leaseExpiresAt !== null && r.leaseExpiresAt > new Date(), `live lease left on ${r.id}`).toBe(false);
}
async function expireLease(objectId: string) {
  await repo.update(objectId, { leaseExpiresAt: new Date(Date.now() - 1) });
}
async function reserve(companyId = COMPANY) {
  return storage.reserveUpload(null, { companyId, userId: user.id, kind: "document", contentType: "text/plain", declaredSize: 4096 });
}
function put(r: { objectId: string; uploadToken: string }, bytes: Buffer) {
  return settle(storage.receiveUpload(user, r.objectId, r.uploadToken, Readable.from([bytes])));
}
function useDrivers(opts: { primaryGate?: (k: string) => Promise<void>; mirrorGate?: (k: string) => Promise<void> } = {}) {
  primary = new MemoryStorageDriver({ beforePublish: opts.primaryGate });
  gcs = new MemoryStorageDriver({ looseKeys: true, kind: "gcs", beforePublish: opts.mirrorGate });
  __setDriversForTests({ primary, legacy: gcs });
}
async function newCompany(label: string): Promise<number> {
  const [c] = await db.insert(companiesTable).values({ name: `B25C2 ${label} ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  companies.push(c.id);
  return c.id;
}

beforeAll(async () => {
  os.driver = "memory";
  os.bucketId = "fake-bucket";
  os.privateObjectDir = "/fake-bucket/.private";
  os.legacyFallback = false;
  os.mirror = true;
  os.legacyDelete = false;
  os.pendingTtlMs = 0;
  COMPANY = await newCompany("fencing");
  user = { id: 1, email: "u@t", name: "U", role: "primary_admin", companyId: COMPANY, permissions: {}, contactVisibility: "all", companyVisibility: "all", selectedUserIds: [], isActive: true, companyStatus: "active", readOnly: false, accessibleCompanies: [COMPANY], sessionId: null };
});

afterAll(async () => {
  Object.assign(os, original);
  __resetStorageRegistryForTests();
  if (companies.length) {
    await db.delete(storageObjectsTable).where(inArray(storageObjectsTable.companyId, companies));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companies));
  }
});

beforeEach(async () => {
  __resetStorageRegistryForTests();
  __resetStorageCountersForTests();
  vi.mocked(repo.releaseUpload).mockReset();
  vi.mocked(repo.releaseUpload).mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof import("../src/repositories/storage-objects.repository.js")>("../src/repositories/storage-objects.repository.js");
    return actual.releaseUpload(...args);
  });
  user.accessibleCompanies = [COMPANY];
  user.companyId = COMPANY;
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  useDrivers();
});

describe("1. one publication attempt per upload intent", () => {
  it("a PUT on an intent whose lease expired is refused; the sweep settles it; a fresh reservation succeeds", async () => {
    const r = await reserve();
    const row = (await repo.findById(r.objectId))!;
    const g = gate((k) => k === row.storageKey);
    useDrivers({ primaryGate: g.hook });
    const a = randomBytes(1000);
    const pA = put(r, a);
    await g.arrived; // A holds the lease and is paused right before publishing its primary copy
    await expireLease(r.objectId);

    const rb = await put(r, randomBytes(1000)); // B: same intent, after expiry
    expect(rb.ok).toBe(false);
    expect((rb as { error: { statusCode?: number; code?: string } }).error).toMatchObject({ statusCode: 409, code: "STORAGE_UPLOAD_EXPIRED" });

    g.release();
    const ra = await pA; // A resumes: its late publication is rejected and its copies removed
    expect(ra.ok).toBe(false);
    expect((ra as { error: { statusCode?: number } }).error).toMatchObject({ statusCode: 409 });
    expect(["uploading", "failed"]).toContain((await repo.findById(r.objectId))!.state);
    await assertNoUntracked(COMPANY);

    const summary = await storage.sweepStorage(new Date());
    expect(summary.expiredLeases + (summary as { cleanupRetries?: number }).cleanupRetries!).toBeGreaterThanOrEqual(0);
    const settled = (await repo.findById(r.objectId))!;
    expect(["failed", "deleted"]).toContain(settled.state);
    expect(settled.leaseToken).toBeNull();
    await assertNoUntracked(COMPANY);

    const fresh = await reserve();
    const c = randomBytes(1200);
    const rc = await put(fresh, c);
    expect(rc.ok).toBe(true);
    const freshRow = (await repo.findById(fresh.objectId))!;
    expect(freshRow.state).toBe("staged");
    expect(freshRow.sha256).toBe(sha(c));
    expect(freshRow.mirrorState).toBe("ok");
    expect(primary.objects.size).toBe(1);
    expect(gcs.objects.size).toBe(1);
    await assertNoUntracked(COMPANY);
  });

  it("a PUT on a failed intent is refused with the same code (clients reserve a new object)", async () => {
    const r = await reserve();
    await repo.transition(r.objectId, ["pending"], "failed", { lastError: "LEASE_EXPIRED" });
    const rb = await put(r, Buffer.from("x"));
    expect(rb.ok).toBe(false);
    expect((rb as { error: { statusCode?: number; code?: string } }).error).toMatchObject({ statusCode: 409, code: "STORAGE_UPLOAD_EXPIRED" });
    expect((await repo.findById(r.objectId))!.state).toBe("failed");
    expect(primary.objects.size).toBe(0);
  });
});

describe("2. stale writers never touch another attempt's result", () => {
  it("stale writer resumes its MIRROR publish after the lease expired: the late mirror is removed, the fresh winner stays byte-for-byte intact", async () => {
    const r = await reserve();
    const row = (await repo.findById(r.objectId))!;
    const g = gate((k) => k === row.mirrorKey);
    useDrivers({ mirrorGate: g.hook });
    const a = randomBytes(900);
    const pA = put(r, a);
    await g.arrived; // A published its primary copy and is paused before publishing its mirror copy
    expect(primary.objects.has(row.storageKey)).toBe(true);
    await expireLease(r.objectId);

    const rb = await put(r, randomBytes(900));
    expect(rb.ok).toBe(false);
    expect((rb as { error: { code?: string } }).error).toMatchObject({ code: "STORAGE_UPLOAD_EXPIRED" });

    // the real winner is a FRESH reservation (never the same row / keys)
    const fresh = await reserve();
    const w = randomBytes(1100);
    const rw = await put(fresh, w);
    expect(rw.ok).toBe(true);
    const winner = (await repo.findById(fresh.objectId))!;
    expect(winner.mirrorState).toBe("ok");

    g.release();
    const ra = await pA; // the stale mirror completes AFTER the winning mirror
    expect(ra.ok).toBe(false);
    expect(gcs.objects.get(winner.mirrorKey!)!.sha256).toBe(sha(w));
    expect(primary.objects.get(winner.storageKey)!.sha256).toBe(sha(w));
    expect((await repo.findById(fresh.objectId))!.state).toBe("staged");
    expect(primary.objects.has(row.storageKey)).toBe(false);
    expect(gcs.objects.has(row.mirrorKey!)).toBe(false);
    await assertNoUntracked(COMPANY);
  });

  it("stale writer's mirror FAILS after the winner staged: only the stale attempt's own primary copy is removed", async () => {
    const r = await reserve();
    const row = (await repo.findById(r.objectId))!;
    const g = gate((k) => k === row.mirrorKey);
    useDrivers({ mirrorGate: g.hook });
    const pA = put(r, randomBytes(800));
    await g.arrived;
    await expireLease(r.objectId);
    expect((await put(r, Buffer.from("b"))).ok).toBe(false);

    const fresh = await reserve();
    const w = randomBytes(700);
    expect((await put(fresh, w)).ok).toBe(true);
    const winner = (await repo.findById(fresh.objectId))!;

    gcs.failNextPut = true; // A's mirror write fails when it resumes
    g.release();
    const ra = await pA;
    expect(ra.ok).toBe(false);
    expect((await repo.findById(fresh.objectId))!.state).toBe("staged");
    expect(primary.objects.get(winner.storageKey)!.sha256).toBe(sha(w));
    expect(gcs.objects.get(winner.mirrorKey!)!.sha256).toBe(sha(w));
    expect(primary.objects.has(row.storageKey)).toBe(false);
    const stale = (await repo.findById(r.objectId))!;
    expect(["failed", "uploading"]).toContain(stale.state);
    expect(stale.state === "uploading" ? stale.leaseExpiresAt! < new Date() : true).toBe(true);
    await assertNoUntracked(COMPANY);
  });

  it("stale writer's DATABASE release fails after the winner staged: nothing of the winner is touched; the stale copies are settled by the sweep", async () => {
    const r = await reserve();
    const row = (await repo.findById(r.objectId))!;
    const g = gate((k) => k === row.storageKey);
    useDrivers({ primaryGate: g.hook });
    const pA = put(r, randomBytes(600));
    await g.arrived;
    await expireLease(r.objectId);
    expect((await put(r, Buffer.from("b"))).ok).toBe(false);

    const fresh = await reserve();
    const w = randomBytes(650);
    expect((await put(fresh, w)).ok).toBe(true);
    const winner = (await repo.findById(fresh.objectId))!;

    // A's release (and its own rollback release) hit a database failure
    const dbErr = Object.assign(new Error("connection terminated; query: UPDATE storage_objects SET state=$1 WHERE id=$2 params=[\"staged\",\"secret-row\"]"), { code: "57P01", severity: "FATAL" });
    vi.mocked(repo.releaseUpload).mockRejectedValueOnce(dbErr).mockRejectedValueOnce(dbErr);
    g.release();
    const ra = await pA;
    expect(ra.ok).toBe(false);
    expect((await repo.findById(fresh.objectId))!.state).toBe("staged");
    expect(primary.objects.get(winner.storageKey)!.sha256).toBe(sha(w));
    expect(gcs.objects.get(winner.mirrorKey!)!.sha256).toBe(sha(w));
    // durable, bounded recovery: the expired lease is settled and its copies removed
    await storage.sweepStorage(new Date());
    expect(["failed", "deleted"]).toContain((await repo.findById(r.objectId))!.state);
    expect(primary.objects.has(row.storageKey)).toBe(false);
    expect(gcs.objects.has(row.mirrorKey!)).toBe(false);
    await assertNoUntracked(COMPANY);
  });

  it("a stale rollback never regresses a staged / active / deleting / deleted row and never deletes a live row's copies", async () => {
    for (const state of ["staged", "active", "deleting", "deleted"] as const) {
      const r = await reserve();
      const row = (await repo.findById(r.objectId))!;
      const winner = randomBytes(300);
      await primary.put(row.storageKey, winner, { contentType: "text/plain", maxBytes: 4096 });
      await repo.update(row.id, { state, sha256: sha(winner), sizeBytes: winner.length, leaseToken: null, leaseExpiresAt: null, mirrorState: null });
      const attempt: storage.WriteAttempt = { rowId: row.id, copies: [{ driver: primary, key: row.storageKey, role: "primary" }] };
      const outcome = await storage.rollbackLeasedAttempt(attempt, "stale-token", "MIRROR_FAILED");
      expect(outcome).toBe("lease_lost");
      const after = (await repo.findById(row.id))!;
      expect(after.state, `state ${state} regressed`).toBe(state);
      if (state === "staged" || state === "active") expect(primary.objects.get(row.storageKey)!.sha256).toBe(sha(winner)); // a live row's copy is never deleted
      else expect(primary.objects.has(row.storageKey)).toBe(false); // a tombstoned row's leftover is garbage of this attempt
      await db.delete(storageObjectsTable).where(eq(storageObjectsTable.id, row.id));
      primary.objects.clear();
    }
  });
});

describe("3. company deletion fences in-flight uploads", () => {
  async function deleteCompany(companyId: number) {
    await db.transaction(async (tx) => {
      await storage.tombstoneCompany(tx, companyId);
      await tx.delete(companiesTable).where(eq(companiesTable.id, companyId));
    });
    await storage.runPurgeCompanyJob({ companyId });
  }

  it("writer paused BEFORE publication: its late bytes are removed, the row stays deleted (never failed)", async () => {
    const cid = await newCompany("del-before");
    user.accessibleCompanies = [cid];
    user.companyId = cid;
    const r = await reserve(cid);
    const row = (await repo.findById(r.objectId))!;
    const g = gate((k) => k === row.storageKey);
    useDrivers({ primaryGate: g.hook });
    const pA = put(r, randomBytes(500));
    await g.arrived;
    await deleteCompany(cid);
    expect((await repo.findById(r.objectId))!.state).toBe("deleted");
    g.release();
    const ra = await pA;
    expect(ra.ok).toBe(false);
    const after = (await repo.findById(r.objectId))!;
    expect(after.state).toBe("deleted");
    expect(primary.objects.size).toBe(0);
    expect(gcs.objects.size).toBe(0);
    await assertNoUntracked(cid);
  });

  it("writer paused BETWEEN primary and mirror: both late copies are removed; a failed removal stays discoverable and is retried", async () => {
    const cid = await newCompany("del-between");
    user.accessibleCompanies = [cid];
    user.companyId = cid;
    const r = await reserve(cid);
    const row = (await repo.findById(r.objectId))!;
    const g = gate((k) => k === row.mirrorKey);
    useDrivers({ mirrorGate: g.hook });
    const pA = put(r, randomBytes(500));
    await g.arrived;
    expect(primary.objects.has(row.storageKey)).toBe(true);
    await deleteCompany(cid); // the purge removed the primary copy published so far
    expect((await repo.findById(r.objectId))!.state).toBe("deleted");
    expect(primary.objects.has(row.storageKey)).toBe(false);
    gcs.failNextDelete = true; // the writer's own cleanup of its late mirror copy fails once
    g.release();
    const ra = await pA;
    expect(ra.ok).toBe(false);
    const after = (await repo.findById(r.objectId))!;
    expect(after.state).toBe("deleted");
    expect(after.lastError).toBe("CLEANUP_PENDING"); // discoverable
    expect(gcs.objects.has(row.mirrorKey!)).toBe(true);
    const summary = await storage.sweepStorage(new Date());
    expect((summary as { cleanupRetries?: number }).cleanupRetries).toBeGreaterThanOrEqual(1);
    expect(gcs.objects.has(row.mirrorKey!)).toBe(false);
    expect((await repo.findById(r.objectId))!.state).toBe("deleted");
    expect((await repo.findById(r.objectId))!.lastError).not.toBe("CLEANUP_PENDING");
    await assertNoUntracked(cid);
  });
});
