// B25 Correction 4 — PERSISTED provider uncertainty. A GCS request the client
// gave up on (timeout, transport failure, process death) may still be committed
// by the provider later; a client-side abort proves nothing. Therefore:
//   • before any GCS PUT (primary or strict mirror) the row is durably marked
//     publication-uncertain; if that mark cannot be persisted the provider is
//     never called
//   • the mark is cleared ONLY by the durable commit of the complete write
//     (staged / active, after every required PUT returned successfully)
//   • a failed / expired / deleting / deleted row with provider uncertainty is
//     never reconciled "once and for all" and never purged: bounded sweeps keep
//     re-checking its persisted locations and generation-delete an object that
//     carries the row's marker; a foreign object stays OWNERSHIP_UNPROVEN
//   • filesystem-only rows keep the automatic reconcile-and-purge behaviour
//   • startup rejects timeout / lease / lifetime relationships that make a
//     bounded upload impossible (fixed, value-free messages)
// Real GcsStorageDriver over the generation-aware fake SDK with decoupled
// provider commits; injected clocks; no sleeps.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { eq, inArray } from "drizzle-orm";
import { db, storageObjectsTable, companiesTable } from "@workspace/db";
import { config } from "../src/config.js";
import { GcsStorageDriver } from "../src/storage/gcs-driver.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { StorageConfigError } from "../src/storage/contract.js";
import { __resetStorageRegistryForTests, __setDriversForTests, validateStorageTiming } from "../src/storage/registry.js";
import { __resetStorageCountersForTests } from "../src/storage/metrics.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as storage from "../src/services/storage.service.js";
import { FakeBucketStore, fakeGcsClient } from "./helpers/fake-gcs-sdk.js";
import type { AuthUser } from "../src/middlewares/requireAuth.js";

vi.mock("../src/repositories/storage-objects.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/storage-objects.repository.js")>();
  return { ...actual, markPublicationUncertain: vi.fn(actual.markPublicationUncertain) };
});

type MutableStorageConfig = { driver: string; bucketId: string; privateObjectDir: string; legacyFallback: boolean; mirror: boolean; legacyDelete: boolean; pendingTtlMs: number; uploadLeaseMs: number; uploadHardLifetimeMs: number; putTimeoutMs: number };
const os = config.objectStorage as unknown as MutableStorageConfig;
const original = { ...os };
const H = 60 * 60 * 1000;

const companies: number[] = [];
let COMPANY = 0;
let store: FakeBucketStore;
let gcsDriver: GcsStorageDriver;
let memoryPrimary: MemoryStorageDriver;
let user: AuthUser;

const objectName = (key: string) => key.replace(/^gs:\/\/fake-bucket\//, "");
const unconditionalDeletes = (name: string) => store.deleteCalls.filter((c) => c.name === name && c.opts?.ifGenerationMatch === undefined);
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
function useMemoryOnly() {
  os.driver = "memory";
  os.mirror = false;
  __setDriversForTests({ primary: memoryPrimary, legacy: gcsDriver });
}
async function newCompany(label: string): Promise<number> {
  const [c] = await db.insert(companiesTable).values({ name: `B25C4 ${label} ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
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
async function row(id: string) {
  return (await repo.findById(id))!;
}

beforeAll(async () => {
  os.bucketId = "fake-bucket";
  os.privateObjectDir = "/fake-bucket/.private";
  os.legacyFallback = false;
  os.legacyDelete = true; // automated bucket deletes are allowed — the dangerous configuration
  os.pendingTtlMs = 0;
  os.uploadHardLifetimeMs = H;
  COMPANY = await newCompany("uncertainty");
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
  store = new FakeBucketStore();
  gcsDriver = new GcsStorageDriver(fakeGcsClient(store), "fake-bucket");
  memoryPrimary = new MemoryStorageDriver();
  vi.mocked(repo.markPublicationUncertain).mockReset();
  vi.mocked(repo.markPublicationUncertain).mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof import("../src/repositories/storage-objects.repository.js")>("../src/repositories/storage-objects.repository.js");
    return actual.markPublicationUncertain(...args);
  });
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  useGcsPrimary();
});

describe("0. Defect A reproduction (independent of the new column): bytes carrying this row's ownership marker must never become untracked", () => {
  it("client transport failure → one clean sweep → delayed provider commit → purge-age sweep: the row may not disappear while the owned object exists", async () => {
    const cid = await newCompany("A-defect");
    const r = await reserve(cid);
    const name = objectName((await row(r.objectId)).storageKey);
    store.failWrite = (n) => (n === name ? "late-commit" : null);
    await expect(startUpload(r, randomBytes(500))).rejects.toMatchObject({ statusCode: 503 });
    store.failWrite = () => null;
    expect(store.pending.has(name)).toBe(true); // the provider still holds the request the client gave up on
    expect((await row(r.objectId)).state).toBe("failed");
    await deleteCompany(cid); // tombstoned + purged by the company job: HEAD finds nothing yet
    const t0 = new Date();
    await storage.sweepStorage(new Date(t0.getTime() + 2 * H)); // first sweep past the quiescence horizon sees no object
    const committed = store.commitPending(name); // the provider commits later, with this row's marker
    expect(committed.metadata["lcp-object-id"]).toBe(r.objectId);
    await storage.sweepStorage(new Date(t0.getTime() + 25 * H)); // purge age reached
    const inventoryRow = await repo.findById(r.objectId);
    const bucketObject = store.objects.get(name);
    expect(
      { inventoryRowPurged: inventoryRow === undefined, ownedObjectInBucket: bucketObject?.metadata["lcp-object-id"] === r.objectId },
      "untracked bytes: the inventory row was purged while the object it owns exists in the bucket",
    ).not.toEqual({ inventoryRowPurged: true, ownedObjectInBucket: true });
    expect(unconditionalDeletes(name)).toEqual([]);
  });
});

describe("A. a delayed provider commit after the client gave up can never become untracked", () => {
  it("7/8/9. transport failure → clean sweeps → provider commits late → the row is never reconciled or purged and the owned object is generation-deleted", async () => {
    const cid = await newCompany("A-late");
    const r = await reserve(cid);
    const name = objectName((await row(r.objectId)).storageKey);
    store.failWrite = (n) => (n === name ? "late-commit" : null);
    await expect(startUpload(r, randomBytes(500))).rejects.toMatchObject({ statusCode: 503 });
    store.failWrite = () => null;
    expect(store.pending.has(name)).toBe(true); // the provider is still holding our request
    const failed = await row(r.objectId);
    expect(failed.state).toBe("failed");
    expect(failed.publicationUncertainAt).toBeInstanceOf(Date);

    await deleteCompany(cid); // company gone; the failed row is settled by the sweep (deleting → HEAD finds nothing → deleted)
    const t0 = new Date();
    await storage.sweepStorage(new Date(t0.getTime() + 2 * H)); // past the quiescence horizon: an absent HEAD proves nothing for an uncertain row
    const afterClean = await row(r.objectId);
    expect(afterClean.state).toBe("deleted");
    expect(afterClean.reconciledAt).toBeNull();
    expect(afterClean.publicationUncertainAt).toBeInstanceOf(Date);
    expect((await storage.storageMetrics()).publicationUncertain).toBeGreaterThanOrEqual(1);

    const committed = store.commitPending(name); // the provider finally commits, with our marker and a generation
    expect(committed.metadata["lcp-object-id"]).toBe(r.objectId);

    await storage.sweepStorage(new Date(t0.getTime() + 25 * H)); // purge age reached
    expect(await repo.findById(r.objectId)).toBeDefined(); // never purged while uncertain
    expect(store.objects.has(name)).toBe(false); // the delayed owned object was found and removed …
    const dels = store.deleteCalls.filter((c) => c.name === name);
    expect(dels.length).toBeGreaterThanOrEqual(1);
    expect(dels.every((c) => Number(c.opts?.ifGenerationMatch) === committed.generation)).toBe(true); // … only at the observed generation
    expect(unconditionalDeletes(name)).toEqual([]);

    for (const dt of [26 * H, 48 * H, 10 * 24 * H]) await storage.sweepStorage(new Date(t0.getTime() + dt));
    const kept = await row(r.objectId);
    expect(kept.state).toBe("deleted");
    expect(kept.publicationUncertainAt).toBeInstanceOf(Date); // operator resolution only
    expect(kept.reconciledAt).toBeNull();
  });

  it("7b. the same for a strict MIRROR whose provider commits after the mirror failure", async () => {
    useMemoryPrimaryWithGcsMirror();
    const cid = await newCompany("A-mirror-late");
    user.companyId = cid;
    user.accessibleCompanies = [cid];
    store.failWrite = () => "late-commit";
    await expect(storage.storeBuffer({ companyId: cid, kind: "report", contentType: "application/pdf", buffer: Buffer.from("pdf") })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    store.failWrite = () => null;
    const [failed] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, cid));
    expect(failed.state).toBe("failed");
    expect(failed.publicationUncertainAt).toBeInstanceOf(Date);
    expect(memoryPrimary.objects.has(failed.storageKey)).toBe(false); // the primary copy was rolled back
    const name = objectName(failed.mirrorKey!);
    expect(store.pending.has(name)).toBe(true);

    await deleteCompany(cid);
    const t0 = new Date();
    await storage.sweepStorage(new Date(t0.getTime() + 2 * H));
    expect((await row(failed.id)).reconciledAt).toBeNull();
    const committed = store.commitPending(name);
    await storage.sweepStorage(new Date(t0.getTime() + 25 * H));
    expect(await repo.findById(failed.id)).toBeDefined();
    expect(store.objects.has(name)).toBe(false);
    expect(store.deleteCalls.filter((c) => c.name === name).every((c) => Number(c.opts?.ifGenerationMatch) === committed.generation)).toBe(true);
  });

  it("10. a FOREIGN object appearing at an uncertain row's key becomes OWNERSHIP_UNPROVEN and is never deleted", async () => {
    const cid = await newCompany("A-foreign");
    const r = await reserve(cid);
    const name = objectName((await row(r.objectId)).storageKey);
    store.failWrite = (n) => (n === name ? "late-commit" : null);
    await expect(startUpload(r, randomBytes(300))).rejects.toMatchObject({ statusCode: 503 });
    store.failWrite = () => null;
    store.pending.delete(name); // our request is lost for good …
    const foreign = store.seed(name, Buffer.from("someone else's object")); // … and someone else wrote the key
    await deleteCompany(cid);
    const t0 = new Date();
    for (const dt of [2 * H, 25 * H, 48 * H]) await storage.sweepStorage(new Date(t0.getTime() + dt));
    expect(store.objects.get(name)!.generation).toBe(foreign.generation);
    expect(store.deleteCalls.filter((c) => c.name === name)).toEqual([]);
    const kept = await row(r.objectId);
    expect(kept.lastError).toBe("OWNERSHIP_UNPROVEN");
    expect(kept.publicationUncertainAt).toBeInstanceOf(Date);
    expect(kept.reconciledAt).toBeNull();
  });
});

describe("B. the uncertainty mark brackets every GCS request", () => {
  it("1/3. GCS primary: the row is marked BEFORE the provider request starts and the mark is cleared only by the staged commit", async () => {
    const r = await reserve(COMPANY);
    const seq: string[] = [];
    vi.mocked(repo.markPublicationUncertain).mockImplementation(async (...args) => {
      const actual = await vi.importActual<typeof import("../src/repositories/storage-objects.repository.js")>("../src/repositories/storage-objects.repository.js");
      seq.push("mark");
      return actual.markPublicationUncertain(...args);
    });
    store.onWriteStart = () => seq.push("write");
    const seen: boolean[] = [];
    store.interceptFinal = async () => {
      seen.push((await row(r.objectId)).publicationUncertainAt !== null);
    };
    const ok = await storage.receiveUpload(user, r.objectId, r.uploadToken, Readable.from([randomBytes(200)]));
    expect(ok.sizeBytes).toBe(200);
    expect(seq.slice(0, 2)).toEqual(["mark", "write"]);
    expect(seen).toEqual([true]); // still uncertain while the provider decides
    const staged = await row(r.objectId);
    expect(staged.state).toBe("staged");
    expect(staged.publicationUncertainAt).toBeNull(); // cleared by the same durable transition that staged the row
  });

  it("2. when the mark cannot be persisted the provider is never called", async () => {
    const r = await reserve(COMPANY);
    vi.mocked(repo.markPublicationUncertain).mockRejectedValueOnce(Object.assign(new Error("connection terminated"), { code: "57P01", severity: "FATAL" }));
    await expect(startUpload(r, randomBytes(100))).rejects.toMatchObject({ statusCode: 503 });
    expect(store.writeStarts).toEqual([]);
    expect(store.objects.size).toBe(0);
    expect((await row(r.objectId)).state).toBe("failed");
  });

  it("4. strict mirror: marked before the mirror request; cleared only after BOTH writes succeeded (activation)", async () => {
    useMemoryPrimaryWithGcsMirror();
    const seen: Array<{ state: string; uncertain: boolean }> = [];
    store.interceptFinal = async (name) => {
      const [r] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.mirrorKey, `gs://fake-bucket/${name}`));
      seen.push({ state: r.state, uncertain: r.publicationUncertainAt !== null });
    };
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "export", contentType: "text/csv", buffer: Buffer.from("a,b") });
    expect(seen).toEqual([{ state: "pending", uncertain: true }]);
    const active = await row(stored.objectId);
    expect(active.state).toBe("active");
    expect(active.mirrorState).toBe("ok");
    expect(active.publicationUncertainAt).toBeNull();
  });

  it("5. process death DURING the GCS primary PUT leaves the mark durable; the eventual provider commit is still found and generation-deleted", async () => {
    const cid = await newCompany("B-death-primary");
    const r = await reserve(cid);
    const name = objectName((await row(r.objectId)).storageKey);
    store.failWrite = (n) => (n === name ? "hold" : null);
    const dead = startUpload(r, randomBytes(400)); // never answers; the writer is considered dead
    void dead;
    await vi.waitFor(() => expect(store.pending.has(name)).toBe(true));
    const held = await row(r.objectId);
    expect(held.state).toBe("uploading");
    expect(held.publicationUncertainAt).toBeInstanceOf(Date);

    const t0 = new Date();
    const s1 = await storage.sweepStorage(new Date(t0.getTime() + os.uploadLeaseMs + 1000));
    expect(s1.expiredLeases).toBe(1);
    expect((await row(r.objectId)).publicationUncertainAt).toBeInstanceOf(Date);
    await deleteCompany(cid);
    await storage.sweepStorage(new Date(t0.getTime() + 2 * H));
    await storage.sweepStorage(new Date(t0.getTime() + 25 * H));
    expect(await repo.findById(r.objectId)).toBeDefined(); // absent HEAD, still uncertain → not purged
    const committed = store.commitPending(name);
    await storage.sweepStorage(new Date(t0.getTime() + 26 * H));
    expect(store.objects.has(name)).toBe(false);
    expect(store.deleteCalls.filter((c) => c.name === name).every((c) => Number(c.opts?.ifGenerationMatch) === committed.generation)).toBe(true);
    expect(await repo.findById(r.objectId)).toBeDefined();
  });

  it("6. process death DURING the strict-mirror PUT leaves the mark durable as well", async () => {
    useMemoryPrimaryWithGcsMirror();
    const cid = await newCompany("B-death-mirror");
    user.companyId = cid;
    user.accessibleCompanies = [cid];
    const r = await reserve(cid);
    const name = objectName((await row(r.objectId)).mirrorKey!);
    store.failWrite = (n) => (n === name ? "hold" : null);
    void startUpload(r, randomBytes(400));
    await vi.waitFor(() => expect(store.pending.has(name)).toBe(true));
    const held = await row(r.objectId);
    expect(held.state).toBe("uploading");
    expect(held.publicationUncertainAt).toBeInstanceOf(Date);
    expect(memoryPrimary.objects.has(held.storageKey)).toBe(true);
    const t0 = new Date();
    await storage.sweepStorage(new Date(t0.getTime() + os.uploadLeaseMs + 1000)); // fenced out + primary copy removed
    expect(memoryPrimary.objects.has(held.storageKey)).toBe(false);
    expect((await row(r.objectId)).publicationUncertainAt).toBeInstanceOf(Date);
    const committed = store.commitPending(name);
    await storage.sweepStorage(new Date(t0.getTime() + 2 * H));
    expect(store.objects.has(name)).toBe(false);
    expect(store.deleteCalls.filter((c) => c.name === name).every((c) => Number(c.opts?.ifGenerationMatch) === committed.generation)).toBe(true);
  });

  it("11. filesystem-only rows carry no provider uncertainty and still reconcile and purge normally", async () => {
    useMemoryOnly();
    const cid = await newCompany("B-fs-only");
    const stored = await storage.storeBuffer({ companyId: cid, kind: "report", contentType: "application/pdf", buffer: Buffer.from("pdf") });
    expect((await row(stored.objectId)).publicationUncertainAt).toBeNull();
    await deleteCompany(cid);
    const t0 = new Date();
    await storage.sweepStorage(new Date(t0.getTime() + 2 * H));
    expect((await row(stored.objectId)).reconciledAt).toBeInstanceOf(Date);
    await storage.sweepStorage(new Date(t0.getTime() + 25 * H));
    expect(await repo.findById(stored.objectId)).toBeUndefined();
    expect(memoryPrimary.objects.size).toBe(0);
  });
});

describe("C. startup rejects timing relationships that make a bounded upload impossible", () => {
  it("13. fixed, value-free StorageConfigError messages; the production defaults pass", () => {
    expect(() => validateStorageTiming({ uploadLeaseMs: 15 * 60_000, putTimeoutMs: 15 * 60_000, uploadHardLifetimeMs: 60 * 60_000 })).not.toThrow();
    const cases: Array<[Parameters<typeof validateStorageTiming>[0], RegExp]> = [
      [{ uploadLeaseMs: 15 * 60_000, putTimeoutMs: 60 * 60_000, uploadHardLifetimeMs: 60 * 60_000 }, /OBJECT_STORAGE_PUT_TIMEOUT_MS must be smaller than OBJECT_STORAGE_UPLOAD_HARD_LIFETIME_MS/],
      [{ uploadLeaseMs: 15 * 60_000, putTimeoutMs: 90 * 60_000, uploadHardLifetimeMs: 60 * 60_000 }, /OBJECT_STORAGE_PUT_TIMEOUT_MS must be smaller than OBJECT_STORAGE_UPLOAD_HARD_LIFETIME_MS/],
      [{ uploadLeaseMs: 10 * 60_000, putTimeoutMs: 15 * 60_000, uploadHardLifetimeMs: 60 * 60_000 }, /OBJECT_STORAGE_PUT_TIMEOUT_MS must not exceed OBJECT_STORAGE_UPLOAD_LEASE_MS/],
      [{ uploadLeaseMs: 2 * 60 * 60_000, putTimeoutMs: 15 * 60_000, uploadHardLifetimeMs: 60 * 60_000 }, /OBJECT_STORAGE_UPLOAD_LEASE_MS must not exceed OBJECT_STORAGE_UPLOAD_HARD_LIFETIME_MS/],
    ];
    for (const [cfg, pattern] of cases) {
      let thrown: unknown;
      try {
        validateStorageTiming(cfg);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(StorageConfigError);
      expect((thrown as Error).message).toMatch(pattern);
      expect((thrown as Error).message).not.toMatch(/\d{4,}/); // no configured values
      expect((thrown as Error).message).not.toMatch(/\//); // no paths
    }
  });
});
