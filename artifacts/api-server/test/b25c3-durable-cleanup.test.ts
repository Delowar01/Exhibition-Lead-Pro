// B25 Correction 3 — crash-DURABLE late-publication cleanup. A copy published
// after lease loss, tombstoning, company deletion or expired-lease cleanup must
// be found and removed by maintenance even when the writer process dies right
// after publishing and executes no catch / finally / rollback code.
//   • the writer can never publish after the row's HARD upload lifetime
//     (createdAt + OBJECT_STORAGE_UPLOAD_HARD_LIFETIME_MS): refused before the
//     first byte, refused by the driver right before publication, and no put
//     may outlive its timeout
//   • a tombstone is re-reconciled from its persisted locations once that
//     horizon has passed (reconciled_at), and only a reconciled tombstone can
//     ever be purged — never "because 24 hours passed"
// Deterministic: publish barriers, injected clocks (sweep `now`, row timestamps),
// simulated process death = the late copy is placed exactly as the driver would
// have published it and the writer never resumes.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
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

type MutableStorageConfig = { driver: string; bucketId: string; privateObjectDir: string; legacyFallback: boolean; mirror: boolean; legacyDelete: boolean; pendingTtlMs: number; stagedTtlMs: number; uploadLeaseMs: number; uploadHardLifetimeMs: number; putTimeoutMs: number };
const os = config.objectStorage as unknown as MutableStorageConfig;
const original = { ...os };
const H = 60 * 60 * 1000;
const PURGE_AGE = 25 * H;

let COMPANY = 0;
const companies: number[] = [];
let primary: MemoryStorageDriver;
let gcs: MemoryStorageDriver;
let user: AuthUser;

function gate(match: (key: string) => boolean) {
  let arrive!: () => void;
  let tripped = false;
  const arrived = new Promise<void>((r) => (arrive = r));
  const never = new Promise<void>(() => undefined); // the paused writer never resumes (process death)
  return {
    arrived,
    hook: async (key: string) => {
      if (tripped || !match(key)) return;
      tripped = true;
      arrive();
      await never;
    },
  };
}
async function newCompany(label: string): Promise<number> {
  const [c] = await db.insert(companiesTable).values({ name: `B25C3 ${label} ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  companies.push(c.id);
  return c.id;
}
async function deleteCompany(companyId: number) {
  await db.transaction(async (tx) => {
    await storage.tombstoneCompany(tx, companyId);
    await tx.delete(companiesTable).where(eq(companiesTable.id, companyId));
  });
  await storage.runPurgeCompanyJob({ companyId });
}
function useDrivers(opts: { primaryGate?: (k: string) => Promise<void>; mirrorGate?: (k: string) => Promise<void> } = {}) {
  primary = new MemoryStorageDriver({ beforePublish: opts.primaryGate });
  gcs = new MemoryStorageDriver({ looseKeys: true, kind: "gcs", beforePublish: opts.mirrorGate });
  __setDriversForTests({ primary, legacy: gcs });
}
async function reserve(companyId: number) {
  user.companyId = companyId;
  user.accessibleCompanies = [companyId];
  return storage.reserveUpload(null, { companyId, userId: user.id, kind: "document", contentType: "text/plain", declaredSize: 4096 });
}
function startUpload(r: { objectId: string; uploadToken: string }, bytes: Buffer) {
  const p = storage.receiveUpload(user, r.objectId, r.uploadToken, Readable.from([bytes]));
  p.catch(() => undefined);
  return p;
}
/** The dead writer's publication: exactly what the driver would have stored, with the ownership marker the service sets. */
async function latePublish(driver: MemoryStorageDriver, key: string, rowId: string, bytes: Buffer) {
  await driver.put(key, bytes, { contentType: "text/plain", maxBytes: 4096, owner: rowId });
}
async function rowsOf(companyId: number) {
  return db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, companyId));
}
async function assertNoUntracked(companyId: number) {
  const rows = await rowsOf(companyId);
  const live = rows.filter((r) => r.state === "staged" || r.state === "active");
  const allowedPrimary = new Set(live.map((r) => r.storageKey));
  const allowedMirror = new Set(live.filter((r) => r.mirrorState === "ok" && r.mirrorKey).map((r) => r.mirrorKey!));
  for (const key of primary.objects.keys()) expect(allowedPrimary.has(key), `untracked primary object ${key}`).toBe(true);
  for (const key of gcs.objects.keys()) expect(allowedMirror.has(key), `untracked mirror object ${key}`).toBe(true);
}

beforeAll(async () => {
  os.driver = "memory";
  os.bucketId = "fake-bucket";
  os.privateObjectDir = "/fake-bucket/.private";
  os.legacyFallback = false;
  os.mirror = true;
  os.legacyDelete = false;
  os.pendingTtlMs = 0;
  os.uploadHardLifetimeMs = H;
  COMPANY = await newCompany("durable");
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
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  useDrivers();
});

describe("A. late publication survives writer death only until the durable sweep", () => {
  it("1. paused before the PRIMARY publish → company deleted and purged → late primary → writer dies → reconciled after the horizon, purged only afterwards", async () => {
    const cid = await newCompany("A1");
    const r = await reserve(cid);
    const row = (await repo.findById(r.objectId))!;
    const g = gate((k) => k === row.storageKey);
    useDrivers({ primaryGate: g.hook });
    const bytes = randomBytes(700);
    startUpload(r, bytes);
    await g.arrived;
    await deleteCompany(cid);
    expect((await repo.findById(r.objectId))!.state).toBe("deleted");
    await latePublish(primary, row.storageKey, row.id, bytes); // the writer publishes … and dies
    expect(primary.objects.has(row.storageKey)).toBe(true);

    const now = new Date();
    await storage.sweepStorage(now); // inside the hard lifetime: nothing can be proven final yet
    expect((await repo.findById(r.objectId))!.state).toBe("deleted");
    expect((await repo.findById(r.objectId))!.reconciledAt).toBeNull();

    const later = await storage.sweepStorage(new Date(now.getTime() + 2 * H)); // past createdAt + hard lifetime + slack
    expect(later.lateCopiesReclaimed).toBeGreaterThanOrEqual(1);
    expect(primary.objects.has(row.storageKey)).toBe(false);
    const reconciled = (await repo.findById(r.objectId))!;
    expect(reconciled.state).toBe("deleted");
    expect(reconciled.reconciledAt).toBeInstanceOf(Date);

    await storage.sweepStorage(new Date(now.getTime() + PURGE_AGE));
    expect(await repo.findById(r.objectId)).toBeUndefined(); // purged only after reconciliation
    await assertNoUntracked(cid);
  });

  it("2. paused between PRIMARY and MIRROR → company deleted (purge removed the primary) → late mirror → writer dies → every late copy removed later", async () => {
    const cid = await newCompany("A2");
    const r = await reserve(cid);
    const row = (await repo.findById(r.objectId))!;
    const g = gate((k) => k === row.mirrorKey);
    useDrivers({ mirrorGate: g.hook });
    const bytes = randomBytes(650);
    startUpload(r, bytes);
    await g.arrived;
    expect(primary.objects.has(row.storageKey)).toBe(true);
    await deleteCompany(cid);
    expect(primary.objects.has(row.storageKey)).toBe(false); // the purge removed what was published so far
    await latePublish(gcs, row.mirrorKey!, row.id, bytes); // the dead writer's mirror lands afterwards
    await latePublish(primary, row.storageKey, row.id, bytes); // (and a crashed writer may even re-link its primary)

    const now = new Date();
    await storage.sweepStorage(new Date(now.getTime() + 2 * H));
    expect(gcs.objects.has(row.mirrorKey!)).toBe(false);
    expect(primary.objects.has(row.storageKey)).toBe(false);
    expect((await repo.findById(r.objectId))!.reconciledAt).toBeInstanceOf(Date);
    await storage.sweepStorage(new Date(now.getTime() + PURGE_AGE));
    expect(await repo.findById(r.objectId)).toBeUndefined();
    await assertNoUntracked(cid);
  });

  it("3. expired-lease sweep settles the row before publication → late primary → writer dies → a later sweep removes it (company still exists, tombstone kept)", async () => {
    const r = await reserve(COMPANY);
    const row = (await repo.findById(r.objectId))!;
    const g = gate((k) => k === row.storageKey);
    useDrivers({ primaryGate: g.hook });
    const bytes = randomBytes(500);
    startUpload(r, bytes);
    await g.arrived;
    await repo.update(r.objectId, { leaseExpiresAt: new Date(Date.now() - 1) });
    const now = new Date();
    const first = await storage.sweepStorage(now);
    expect(first.expiredLeases).toBe(1);
    expect((await repo.findById(r.objectId))!.state).toBe("deleted");
    await latePublish(primary, row.storageKey, row.id, bytes);
    await storage.sweepStorage(new Date(now.getTime() + 2 * H));
    expect(primary.objects.has(row.storageKey)).toBe(false);
    const after = (await repo.findById(r.objectId))!;
    expect(after.state).toBe("deleted");
    expect(after.reconciledAt).toBeInstanceOf(Date);
    await storage.sweepStorage(new Date(now.getTime() + PURGE_AGE));
    expect(await repo.findById(r.objectId)).toBeDefined(); // the company exists: tombstones of live tenants are never purged
    await assertNoUntracked(COMPANY);
  });

  it("4. both copies published, writer dies before the stage transition → the expired lease is settled and both copies removed (mirror by proven ownership)", async () => {
    const r = await reserve(COMPANY);
    const row = (await repo.findById(r.objectId))!;
    const bytes = randomBytes(400);
    expect(await repo.claimUpload(row.id, "dead-writer", os.uploadLeaseMs)).toBeDefined();
    await latePublish(primary, row.storageKey, row.id, bytes);
    await latePublish(gcs, row.mirrorKey!, row.id, bytes);
    const now = new Date();
    const s = await storage.sweepStorage(new Date(now.getTime() + os.uploadLeaseMs + 1000));
    expect(s.expiredLeases).toBe(1);
    expect(primary.objects.has(row.storageKey)).toBe(false);
    expect(gcs.objects.has(row.mirrorKey!)).toBe(false);
    expect(gcs.deleteCalls.filter((c) => c.key === row.mirrorKey).every((c) => c.ifGeneration !== undefined)).toBe(true); // never a bare-key delete on the bucket
    expect((await repo.findById(r.objectId))!.state).toBe("deleted");
    await assertNoUntracked(COMPANY);
  });

  it("5. beyond the purge threshold the inventory record cannot go before the final physical reconciliation succeeds", async () => {
    const cid = await newCompany("A5");
    const r = await reserve(cid);
    const row = (await repo.findById(r.objectId))!;
    const g = gate((k) => k === row.storageKey);
    useDrivers({ primaryGate: g.hook });
    const bytes = randomBytes(300);
    startUpload(r, bytes);
    await g.arrived;
    await deleteCompany(cid);
    await latePublish(primary, row.storageKey, row.id, bytes);

    primary.failNextDelete = true; // the final reconciliation's delete fails once
    const now = new Date();
    const blocked = await storage.sweepStorage(new Date(now.getTime() + PURGE_AGE));
    expect(blocked.purgedTombstones).toBe(0);
    const kept = (await repo.findById(r.objectId))!;
    expect(kept.state).toBe("deleted");
    expect(kept.reconciledAt).toBeNull();
    expect(kept.lastError).toBe("CLEANUP_PENDING");
    expect(primary.objects.has(row.storageKey)).toBe(true);

    const done = await storage.sweepStorage(new Date(now.getTime() + PURGE_AGE + 1000));
    expect(primary.objects.has(row.storageKey)).toBe(false);
    expect(done.purgedTombstones).toBe(1);
    expect(await repo.findById(r.objectId)).toBeUndefined();
    await assertNoUntracked(cid);
  });
});

describe("A'. the hard upload lifetime bounds every publication", () => {
  it("an upload whose row is older than the hard lifetime is refused before the first byte", async () => {
    const r = await reserve(COMPANY);
    await repo.update(r.objectId, { createdAt: new Date(Date.now() - 2 * H) });
    await expect(storage.receiveUpload(user, r.objectId, r.uploadToken, Readable.from([Buffer.from("late")]))).rejects.toMatchObject({ statusCode: 409, code: "STORAGE_UPLOAD_EXPIRED" });
    expect(primary.objects.size).toBe(0);
    expect((await repo.findById(r.objectId))!.state).toBe("pending");
  });

  it("drivers refuse to publish past the deadline and abort a put that outlives its timeout, leaving nothing behind", async () => {
    const key = `tenants/${COMPANY}/documents/00000000-0000-4000-8000-000000000001`;
    for (const d of [primary, gcs]) {
      await expect(d.put(key, Buffer.from("x"), { contentType: "text/plain", maxBytes: 10, publishDeadline: new Date(Date.now() - 1) })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", reason: "PUBLISH_DEADLINE" });
      expect(d.objects.has(key)).toBe(false);
    }
    const stuck = new Readable({ read() {} }); // a body that never ends
    await expect(primary.put(key, stuck, { contentType: "text/plain", maxBytes: 10, timeoutMs: 30 })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", reason: "PUT_TIMEOUT" });
    expect(primary.objects.has(key)).toBe(false);
  });
});
