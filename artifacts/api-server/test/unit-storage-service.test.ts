// Batch 25 — object manager (services/storage.service.ts) with FAKE drivers:
// an in-memory primary and an in-memory stand-in for the legacy bucket. Uses
// the real storage_objects table (DATABASE_URL) but no running server and no
// live Google Cloud. Covers the transition semantics that cannot be exercised
// through the HTTP suite on a single driver:
//   • legacy fallback reads (only without an inventory row, only when enabled)
//     register the object; a tombstone is NEVER resurrected by the fallback
//   • fs-first reads with legacy fallback for a migrated row whose primary copy
//     is missing
//   • strict mirrored writes: a mirror failure fails the write and rolls the
//     primary object back
//   • primary failure / database failure after the write: no committed
//     reference, no untracked bytes, failed rows are swept
//   • delete retries are idempotent; company purge removes every object
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, storageObjectsTable, companiesTable, documentsTable, documentVersionsTable } from "@workspace/db";
import { config } from "../src/config.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import { __resetStorageCountersForTests, storageCounters } from "../src/storage/metrics.js";
import { readAll } from "../src/storage/contract.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as storage from "../src/services/storage.service.js";

vi.mock("../src/repositories/storage-objects.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/storage-objects.repository.js")>();
  return { ...actual, transition: vi.fn(actual.transition) };
});

type MutableStorageConfig = {
  driver: string;
  bucketId: string;
  privateObjectDir: string;
  legacyFallback: boolean;
  mirror: boolean;
  legacyDelete: boolean;
  pendingTtlMs: number;
  stagedTtlMs: number;
};
const os = config.objectStorage as unknown as MutableStorageConfig;
const original = { ...os };

// Two REAL tenants: pre-B25 document handles are served only to the tenant
// whose feature row carries them (B25 Correction 1).
let COMPANY = 0;
let OTHER = 0;
const companies: number[] = [];

let primary: MemoryStorageDriver;
let legacy: MemoryStorageDriver;

function uploadsRef(): { reference: string; legacyKey: string } {
  const id = randomUUID();
  return { reference: `/objects/uploads/${id}`, legacyKey: `gs://fake-bucket/.private/uploads/${id}` };
}

async function rows(companyId = COMPANY) {
  return db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, companyId));
}
/** A document version of `companyId` carrying `reference` as its object path (what makes a legacy handle "owned"). */
async function seedDocumentVersion(companyId: number, reference: string): Promise<void> {
  const [doc] = await db.insert(documentsTable).values({ companyId, entityType: "company", entityId: companyId, name: "legacy", category: "Company Profile" }).returning({ id: documentsTable.id });
  await db.insert(documentVersionsTable).values({ companyId, documentId: doc.id, versionNumber: 1, objectPath: reference, fileName: "legacy.pdf", fileSize: 1, mimeType: "application/pdf" });
}
async function clearTenant(companyId: number): Promise<void> {
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, companyId));
  await db.delete(documentVersionsTable).where(eq(documentVersionsTable.companyId, companyId));
  await db.delete(documentsTable).where(eq(documentsTable.companyId, companyId));
}

beforeAll(async () => {
  os.driver = "memory";
  os.bucketId = "fake-bucket";
  os.privateObjectDir = "/fake-bucket/.private";
  os.legacyDelete = false;
  const stamp = Date.now();
  const [a] = await db.insert(companiesTable).values({ name: `B25 unit tenant A ${stamp}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  const [b] = await db.insert(companiesTable).values({ name: `B25 unit tenant B ${stamp}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  COMPANY = a.id;
  OTHER = b.id;
  companies.push(COMPANY, OTHER);
});

afterAll(async () => {
  Object.assign(os, original);
  __resetStorageRegistryForTests();
  for (const c of companies) await clearTenant(c);
  if (companies.length) await db.delete(companiesTable).where(inArray(companiesTable.id, companies));
});

beforeEach(async () => {
  __resetStorageRegistryForTests();
  __resetStorageCountersForTests();
  primary = new MemoryStorageDriver();
  legacy = new MemoryStorageDriver({ looseKeys: true, kind: "gcs" });
  __setDriversForTests({ primary, legacy });
  os.legacyFallback = false;
  os.mirror = false;
  vi.mocked(repo.transition).mockReset();
  vi.mocked(repo.transition).mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof import("../src/repositories/storage-objects.repository.js")>("../src/repositories/storage-objects.repository.js");
    return actual.transition(...args);
  });
  for (const c of companies) await clearTenant(c);
});

describe("legacy fallback", () => {
  it("serves a pre-B25 reference from the legacy bucket only while enabled, and registers it once", async () => {
    const { reference, legacyKey } = uploadsRef();
    const bytes = Buffer.from("legacy document bytes");
    await legacy.put(legacyKey, bytes, { contentType: "application/pdf", maxBytes: 1 << 20 });
    await seedDocumentVersion(COMPANY, reference);

    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference })).toBeNull();
    expect(await rows()).toHaveLength(0);

    os.legacyFallback = true;
    const opened = await storage.openByReference({ companyId: COMPANY, kind: "document", reference });
    expect(opened).not.toBeNull();
    expect((await readAll(opened!.stream, 1 << 20)).equals(bytes)).toBe(true);
    expect(opened!.contentType).toBe("application/pdf");
    const [row] = await rows();
    expect(row.driver).toBe("gcs");
    expect(row.legacyKey).toBe(legacyKey);
    expect(row.state).toBe("active");
    expect(row.storageKey).toMatch(new RegExp(`^tenants/${COMPANY}/documents/`));
    // one registration (fallback read) + one serve from the legacy copy
    expect(storageCounters().legacyFallbackReads).toBe(2);
    expect(storageCounters().legacyRegistrations).toBe(1);

    await storage.openByReference({ companyId: COMPANY, kind: "document", reference });
    expect(await rows()).toHaveLength(1);
  });

  it("never serves another tenant's legacy scan / logo key and never serves a missing object", async () => {
    os.legacyFallback = true;
    await legacy.put(`gs://fake-bucket/scans/${OTHER}/1.jpg`, Buffer.from("jpg"), { contentType: "image/jpeg", maxBytes: 1 << 20 });
    expect(await storage.openByReference({ companyId: COMPANY, kind: "scan_image", reference: `scans/${OTHER}/1.jpg` })).toBeNull();
    expect(await storage.openByReference({ companyId: COMPANY, kind: "branding_logo", reference: `branding/${OTHER}/${"a".repeat(32)}.png` })).toBeNull();
    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference: uploadsRef().reference })).toBeNull();
    expect(await rows()).toHaveLength(0);
  });

  it("a tombstone is never resurrected by the fallback even though the legacy object still exists", async () => {
    os.legacyFallback = true;
    const { reference, legacyKey } = uploadsRef();
    await legacy.put(legacyKey, Buffer.from("x"), { contentType: "text/plain", maxBytes: 1 << 20 });
    await seedDocumentVersion(COMPANY, reference);
    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference })).not.toBeNull();
    await storage.deleteByReference({ companyId: COMPANY, kind: "document", reference });
    const [row] = await rows();
    expect(row.state).toBe("deleted");
    expect(legacy.objects.has(legacyKey)).toBe(true); // OBJECT_STORAGE_LEGACY_DELETE is off: the bucket is never touched
    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference })).toBeNull();
    expect(await storage.mintDownloadUrl("http://x", { companyId: COMPANY, kind: "document", reference, userId: null })).toBeNull();
    expect(await rows()).toHaveLength(1);
  });

  it("deleting an unknown legacy reference writes a tombstone first, so a later fallback read cannot bring it back", async () => {
    os.legacyFallback = true;
    const { reference, legacyKey } = uploadsRef();
    await legacy.put(legacyKey, Buffer.from("x"), { contentType: "text/plain", maxBytes: 1 << 20 });
    await storage.deleteByReference({ companyId: COMPANY, kind: "document", reference });
    const [row] = await rows();
    expect(row.state).toBe("deleted");
    expect(row.driver).toBe("gcs");
    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference })).toBeNull();
  });

  it("fs-first read with legacy fallback: a migrated row whose primary copy is missing is served from its legacy location", async () => {
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "document", contentType: "text/plain", buffer: Buffer.from("migrated"), entityType: "document_version", entityId: 1 });
    const legacyKey = `gs://fake-bucket/.private/uploads/${randomUUID()}`;
    await legacy.put(legacyKey, Buffer.from("migrated"), { contentType: "text/plain", maxBytes: 1 << 20 });
    await repo.update(stored.objectId, { legacyKey });
    const row = (await repo.findById(stored.objectId))!;
    await primary.delete(row.storageKey);

    await expect(storage.openObject(row)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND" });
    os.legacyFallback = true;
    const opened = await storage.openObject(row);
    expect((await readAll(opened.stream, 1 << 20)).toString()).toBe("migrated");
    expect(storageCounters().legacyFallbackReads).toBe(1);
  });
});

describe("strict mirrored writes", () => {
  it("copies every write to the mirror and records the mirror state", async () => {
    os.mirror = true;
    const bytes = randomBytes(5000);
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "export", contentType: "text/csv", buffer: bytes });
    const row = (await repo.findById(stored.objectId))!;
    expect(row.state).toBe("active");
    expect(row.mirrorState).toBe("ok");
    expect(row.mirrorKey).toBe(`gs://fake-bucket/${row.storageKey}`);
    expect(primary.objects.get(row.storageKey)!.bytes.equals(bytes)).toBe(true);
    expect(legacy.objects.get(row.mirrorKey!)!.bytes.equals(bytes)).toBe(true);
    await storage.deleteByReference({ companyId: COMPANY, kind: "export", reference: stored.reference });
    expect(primary.objects.has(row.storageKey)).toBe(false);
    expect(legacy.objects.has(row.mirrorKey!)).toBe(false); // the mirror copy is ours, not a legacy object
  });

  it("a mirror failure fails the write and rolls the primary object back (no committed reference)", async () => {
    os.mirror = true;
    legacy.failNextPut = true;
    await expect(storage.storeBuffer({ companyId: COMPANY, kind: "export", contentType: "text/csv", buffer: Buffer.from("csv") })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(primary.objects.size).toBe(0);
    expect(legacy.objects.size).toBe(0);
    const [row] = await rows();
    expect(row.state).toBe("failed");
    expect(storageCounters().mirrorFailures).toBe(1);
    expect(await storage.resolveReadable({ companyId: COMPANY, kind: "export", reference: row.reference })).toBeNull();
  });
});

describe("write-ahead inventory and failure rollback", () => {
  it("a primary failure leaves a failed row and no bytes", async () => {
    storage.armPrimaryFailureForTests();
    await expect(storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("pdf") })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    const [row] = await rows();
    expect(row.state).toBe("failed");
    expect(row.lastError).toBe("STORAGE_UNAVAILABLE");
    expect(primary.objects.size).toBe(0);
    expect(storageCounters().primaryFailures).toBe(1);
  });

  it("a database failure AFTER the bytes were written removes the bytes and leaves the row for the sweep", async () => {
    vi.mocked(repo.transition).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("pdf") })).rejects.toThrow(/database unavailable/);
    expect(primary.objects.size).toBe(0); // never leaves untracked bytes behind
    const [row] = await rows();
    // B25 Correction 1: the rollback helper settles the row itself (failed, sanitized reason)
    expect(row.state).toBe("failed");
    expect(row.lastError).toBe("DB_FAILURE");
    os.pendingTtlMs = 0;
    await storage.sweepStorage(new Date(Date.now() + 1000));
    expect((await rows())[0].state).toBe("deleted");
  });

  it("an over-limit buffer is refused before any row is written", async () => {
    await expect(storage.storeBuffer({ companyId: COMPANY, kind: "branding_logo", contentType: "image/png", buffer: Buffer.alloc(3 * 1024 * 1024), extension: "png" })).rejects.toMatchObject({ code: "STORAGE_TOO_LARGE" });
    expect(await rows()).toHaveLength(0);
  });
});

describe("deletion, retries and company purge", () => {
  it("a failed physical delete keeps the tombstone (unservable) and the retry job settles it idempotently", async () => {
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "document", contentType: "text/plain", buffer: Buffer.from("doc"), entityType: "document_version", entityId: 1 });
    primary.failNextDelete = true;
    await storage.deleteByReference({ companyId: COMPANY, kind: "document", reference: stored.reference });
    let row = (await repo.findById(stored.objectId))!;
    expect(row.state).toBe("deleting");
    expect(row.lastError).toBe("DELETE_RETRY");
    expect(storageCounters().deleteFailures).toBe(1);
    expect(await storage.resolveReadable({ companyId: COMPANY, kind: "document", reference: stored.reference })).toBeNull();
    expect(primary.objects.has(row.storageKey)).toBe(true);

    primary.failNextDelete = true;
    await expect(storage.runDeleteObjectJob({ objectId: stored.objectId })).rejects.toThrow(/retrying/);
    await storage.runDeleteObjectJob({ objectId: stored.objectId });
    row = (await repo.findById(stored.objectId))!;
    expect(row.state).toBe("deleted");
    expect(primary.objects.has(row.storageKey)).toBe(false);
    await storage.runDeleteObjectJob({ objectId: stored.objectId }); // settled: no-op
    await storage.runDeleteObjectJob({ objectId: "not-a-uuid" }); // malformed: ignored
    await storage.deleteByReference({ companyId: COMPANY, kind: "document", reference: stored.reference }); // idempotent
  });

  it("company deletion tombstones every live object in the transaction and the purge job removes the bytes", async () => {
    const a = await storage.storeBuffer({ companyId: COMPANY, kind: "document", contentType: "text/plain", buffer: Buffer.from("a") });
    const b = await storage.storeBuffer({ companyId: COMPANY, kind: "scan_image", contentType: "image/jpeg", buffer: Buffer.from("b") });
    const other = await storage.storeBuffer({ companyId: OTHER, kind: "document", contentType: "text/plain", buffer: Buffer.from("o") });
    const marked = await db.transaction((tx) => storage.tombstoneCompany(tx, COMPANY));
    expect(marked).toBe(2);
    for (const r of await rows()) expect(r.state).toBe("deleting");
    expect(await storage.resolveReadable({ companyId: COMPANY, kind: "document", reference: a.reference })).toBeNull();
    expect(primary.objects.size).toBe(3);

    await storage.runPurgeCompanyJob({ companyId: COMPANY });
    for (const r of await rows()) expect(r.state).toBe("deleted");
    expect(primary.objects.size).toBe(1);
    const [otherRow] = await rows(OTHER);
    expect(otherRow.state).toBe("active");
    expect((await readAll((await storage.openByReference({ companyId: OTHER, kind: "document", reference: other.reference }))!.stream, 100)).toString()).toBe("o");
    void b;
  });

  it("the sweep settles stale staged uploads and objects orphaned by hard-deleted rows", async () => {
    const stale = await storage.storeBuffer({ companyId: COMPANY, kind: "document", contentType: "text/plain", buffer: Buffer.from("staged") });
    await repo.update(stale.objectId, { state: "staged", entityType: null, entityId: null });
    const orphan = await storage.storeBuffer({ companyId: COMPANY, kind: "document", contentType: "text/plain", buffer: Buffer.from("orphan"), entityType: "document_version", entityId: 2_147_483_000 });
    os.stagedTtlMs = 0;
    os.pendingTtlMs = 0; // no grace window for the orphan pass
    // entity-orphan detection sees the row no feature row references any more ...
    expect((await repo.listEntityOrphans(new Date(Date.now() + 1000), 1000)).map((r) => r.id)).toContain(orphan.objectId);
    const summary = await storage.sweepStorage(new Date(Date.now() + 1000));
    expect(summary.staleStaged).toBe(1);
    // ... and the sweep settles it
    expect(summary.entityOrphans).toBeGreaterThanOrEqual(1);
    expect((await repo.findById(stale.objectId))!.state).toBe("deleted");
    expect((await repo.findById(orphan.objectId))!.state).toBe("deleted");
    expect(primary.objects.size).toBe(0);
  });
});

describe("metrics", () => {
  it("reports the driver, switches, counters and inventory backlog without any key or path", async () => {
    os.legacyFallback = true;
    os.mirror = true;
    const m = await storage.storageMetrics();
    expect(m.driver).toBe("memory");
    expect(m.legacyFallback).toBe(true);
    expect(m.mirror).toBe(true);
    expect(typeof m.pendingUploads).toBe("number");
    expect(typeof m.pendingDeletes).toBe("number");
    expect(JSON.stringify(m)).not.toMatch(/tenants\/|gs:\/\/|fake-bucket/);
  });
});
