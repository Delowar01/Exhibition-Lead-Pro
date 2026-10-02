// B25 Correction 3 — DURABLE GCS ownership. Automated cleanup may delete a
// bucket object only with durable proof that the object belongs to the
// inventory row: the object carries the row id as custom metadata (set by the
// write itself) and the delete is conditioned on the generation observed by the
// HEAD that proved it — never a bare-key delete, never an in-memory-only proof.
//   • a pre-existing object at the reserved key survives a 412 rollback and
//     every later sweep (legacy deletion ENABLED), stays discoverable
//     (OWNERSHIP_UNPROVEN) and is never purged
//   • commit-then-lost-response: the object carries the marker → removed later,
//     conditioned on its generation; nothing unconditional
//   • successful write, then "restart" (database state only): cleanup uses the
//     observed generation; a newer unrelated generation at the same key survives
//   • mirror copies follow the same rule
//   • no cleanup ever falls back from a precondition failure to a bare-key delete
// The REAL GcsStorageDriver runs over the generation-aware fake SDK surface.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { eq, inArray } from "drizzle-orm";
import { db, storageObjectsTable, companiesTable } from "@workspace/db";
import { config } from "../src/config.js";
import { GcsStorageDriver } from "../src/storage/gcs-driver.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import { __resetStorageCountersForTests } from "../src/storage/metrics.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as storage from "../src/services/storage.service.js";
import { FakeBucketStore, fakeGcsClient } from "./helpers/fake-gcs-sdk.js";
import type { AuthUser } from "../src/middlewares/requireAuth.js";

vi.mock("../src/repositories/storage-objects.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/storage-objects.repository.js")>();
  return { ...actual, transition: vi.fn(actual.transition) };
});

type MutableStorageConfig = { driver: string; bucketId: string; privateObjectDir: string; legacyFallback: boolean; mirror: boolean; legacyDelete: boolean; pendingTtlMs: number; uploadLeaseMs: number; uploadHardLifetimeMs: number };
const os = config.objectStorage as unknown as MutableStorageConfig;
const original = { ...os };
const H = 60 * 60 * 1000;

let COMPANY = 0;
let store: FakeBucketStore;
let gcsDriver: GcsStorageDriver;
let memoryPrimary: MemoryStorageDriver;
let user: AuthUser;

const objectName = (key: string) => key.replace(/^gs:\/\/fake-bucket\//, "");
function unconditionalDeletes(name: string) {
  return store.deleteCalls.filter((c) => c.name === name && c.opts?.ifGenerationMatch === undefined);
}
function useGcsPrimary() {
  os.driver = "gcs";
  os.mirror = false;
  __setDriversForTests({ primary: gcsDriver, legacy: gcsDriver });
}
function useMemoryPrimaryWithGcsMirror() {
  os.driver = "memory";
  os.mirror = true;
  __setDriversForTests({ primary: memoryPrimary, legacy: gcsDriver });
}
async function reserve() {
  return storage.reserveUpload(null, { companyId: COMPANY, userId: user.id, kind: "document", contentType: "text/plain", declaredSize: 4096 });
}
async function sweeps(from: Date) {
  for (const dt of [0, H, 2 * H, 25 * H]) await storage.sweepStorage(new Date(from.getTime() + dt));
}

beforeAll(async () => {
  os.bucketId = "fake-bucket";
  os.privateObjectDir = "/fake-bucket/.private";
  os.legacyFallback = false;
  os.legacyDelete = true; // the dangerous configuration: legacy / native bucket deletes are allowed
  os.pendingTtlMs = 0;
  os.uploadHardLifetimeMs = H;
  const [c] = await db.insert(companiesTable).values({ name: `B25C3 ownership ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  COMPANY = c.id;
  user = { id: 1, email: "u@t", name: "U", role: "primary_admin", companyId: COMPANY, permissions: {}, contactVisibility: "all", companyVisibility: "all", selectedUserIds: [], isActive: true, companyStatus: "active", readOnly: false, accessibleCompanies: [COMPANY], sessionId: null };
});
afterAll(async () => {
  Object.assign(os, original);
  __resetStorageRegistryForTests();
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  await db.delete(companiesTable).where(inArray(companiesTable.id, [COMPANY]));
});
beforeEach(async () => {
  __resetStorageRegistryForTests();
  __resetStorageCountersForTests();
  store = new FakeBucketStore();
  gcsDriver = new GcsStorageDriver(fakeGcsClient(store), "fake-bucket");
  memoryPrimary = new MemoryStorageDriver();
  vi.mocked(repo.transition).mockReset();
  vi.mocked(repo.transition).mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof import("../src/repositories/storage-objects.repository.js")>("../src/repositories/storage-objects.repository.js");
    return actual.transition(...args);
  });
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  useGcsPrimary();
});

describe("B. GCS objects are deleted only with durable ownership proof", () => {
  it("1. a pre-existing object at the reserved key survives the 412 rollback and every sweep with legacy deletion enabled, and stays discoverable", async () => {
    const r = await reserve();
    const row = (await repo.findById(r.objectId))!;
    const name = objectName(row.storageKey);
    const foreign = randomBytes(300);
    const seeded = store.seed(name, foreign, "application/octet-stream"); // unrelated bytes, no ownership marker

    await expect(storage.receiveUpload(user, r.objectId, r.uploadToken, Readable.from([randomBytes(300)]))).rejects.toMatchObject({ statusCode: 409 });
    expect((await repo.findById(r.objectId))!.state).toBe("failed");
    expect(store.objects.get(name)!.bytes.equals(foreign)).toBe(true);

    await sweeps(new Date());
    const survivor = store.objects.get(name)!;
    expect(survivor.bytes.equals(foreign)).toBe(true);
    expect(survivor.generation).toBe(seeded.generation);
    expect(unconditionalDeletes(name)).toEqual([]);
    expect(store.deleteCalls.filter((c) => c.name === name)).toEqual([]); // never even attempted without proof
    const kept = (await repo.findById(r.objectId))!;
    expect(["deleting", "deleted"]).toContain(kept.state);
    expect(kept.lastError).toBe("OWNERSHIP_UNPROVEN");
    expect((await storage.storageMetrics()).ownershipUnproven).toBeGreaterThanOrEqual(1);
    // and it is never purged, however old it gets
    await db.delete(companiesTable).where(eq(companiesTable.id, COMPANY)).catch(() => undefined);
    await storage.sweepStorage(new Date(Date.now() + 10 * 24 * H));
    expect(await repo.findById(r.objectId)).toBeDefined();
    await db.insert(companiesTable).values({ id: COMPANY, name: `B25C3 ownership ${Date.now()}`, plan: "professional", status: "active" } as never).onConflictDoNothing();
  });

  it("2. commit-then-lost-response: the object carries the row's marker → removed later, conditioned on the observed generation, never unconditionally", async () => {
    const r = await reserve();
    const row = (await repo.findById(r.objectId))!;
    const name = objectName(row.storageKey);
    store.failWrite = (n) => (n === name ? "after-commit" : null);
    await expect(storage.receiveUpload(user, r.objectId, r.uploadToken, Readable.from([randomBytes(200)]))).rejects.toMatchObject({ statusCode: 503 });
    store.failWrite = () => null;
    const stored = store.objects.get(name)!;
    expect(stored).toBeDefined();
    expect(stored.metadata["lcp-object-id"]).toBe(row.id);
    expect((await repo.findById(r.objectId))!.state).toBe("failed"); // discoverable: the row keeps the key

    await storage.sweepStorage(new Date());
    expect(store.objects.has(name)).toBe(false);
    const dels = store.deleteCalls.filter((c) => c.name === name);
    expect(dels.length).toBeGreaterThanOrEqual(1);
    expect(dels.every((c) => Number(c.opts?.ifGenerationMatch) === stored.generation)).toBe(true);
    expect((await repo.findById(r.objectId))!.state).toBe("deleted");
  });

  it("3. successful write, then only database state remains: cleanup uses the observed generation; a newer unrelated generation at the same key survives", async () => {
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("ours") });
    const row = (await repo.findById(stored.objectId))!;
    const name = objectName(row.storageKey);
    const ours = store.objects.get(name)!;
    expect(ours.metadata["lcp-object-id"]).toBe(row.id);
    __resetStorageRegistryForTests(); // "restart": nothing in memory but the database
    useGcsPrimary();
    await storage.deleteByReference({ companyId: COMPANY, kind: "report", reference: stored.reference });
    expect(store.objects.has(name)).toBe(false);
    expect(store.deleteCalls.filter((c) => c.name === name).every((c) => Number(c.opts?.ifGenerationMatch) === ours.generation)).toBe(true);
    expect((await repo.findById(stored.objectId))!.state).toBe("deleted");

    const second = await storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("ours too") });
    const row2 = (await repo.findById(second.objectId))!;
    const name2 = objectName(row2.storageKey);
    const replaced = store.seed(name2, Buffer.from("someone else's newer generation")); // no marker, newer generation
    await storage.deleteByReference({ companyId: COMPANY, kind: "report", reference: second.reference });
    await sweeps(new Date());
    expect(store.objects.get(name2)!.generation).toBe(replaced.generation);
    expect(store.objects.get(name2)!.bytes.toString()).toBe("someone else's newer generation");
    expect(unconditionalDeletes(name2)).toEqual([]);
    expect((await repo.findById(second.objectId))!.lastError).toBe("OWNERSHIP_UNPROVEN");
  });

  it("4. mirror copies follow the same rule: removed by observed generation when ours; survive when replaced by an unrelated object", async () => {
    useMemoryPrimaryWithGcsMirror();
    const a = await storage.storeBuffer({ companyId: COMPANY, kind: "export", contentType: "text/csv", buffer: Buffer.from("a,b") });
    const rowA = (await repo.findById(a.objectId))!;
    expect(rowA.mirrorState).toBe("ok");
    const mirrorA = objectName(rowA.mirrorKey!);
    expect(store.objects.get(mirrorA)!.metadata["lcp-object-id"]).toBe(rowA.id);
    await storage.deleteByReference({ companyId: COMPANY, kind: "export", reference: a.reference });
    expect(store.objects.has(mirrorA)).toBe(false);
    expect(memoryPrimary.objects.has(rowA.storageKey)).toBe(false);
    expect(store.deleteCalls.filter((c) => c.name === mirrorA).every((c) => c.opts?.ifGenerationMatch !== undefined)).toBe(true);

    const b = await storage.storeBuffer({ companyId: COMPANY, kind: "export", contentType: "text/csv", buffer: Buffer.from("c,d") });
    const rowB = (await repo.findById(b.objectId))!;
    const mirrorB = objectName(rowB.mirrorKey!);
    const replaced = store.seed(mirrorB, Buffer.from("foreign mirror"));
    await storage.deleteByReference({ companyId: COMPANY, kind: "export", reference: b.reference });
    await sweeps(new Date());
    expect(store.objects.get(mirrorB)!.generation).toBe(replaced.generation);
    expect(unconditionalDeletes(mirrorB)).toEqual([]);
    expect(memoryPrimary.objects.has(rowB.storageKey)).toBe(false); // the primary (attempt-unique private key) is gone
    expect((await repo.findById(b.objectId))!.lastError).toBe("OWNERSHIP_UNPROVEN");
  });

  it("5. a successful write followed by a database failure deletes only the generation it wrote (in-memory proof), and nothing else", async () => {
    vi.mocked(repo.transition).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("x") })).rejects.toBeInstanceOf(Error);
    const names = store.deleteCalls.map((c) => c.name);
    expect(names.length).toBe(1);
    expect(store.deleteCalls[0].opts?.ifGenerationMatch).toBeDefined();
    expect(store.objects.has(names[0])).toBe(false);
    expect(unconditionalDeletes(names[0])).toEqual([]);
  });
});
