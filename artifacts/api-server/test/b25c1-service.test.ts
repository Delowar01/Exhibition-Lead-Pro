// B25 Correction 1 — object manager with FAKE drivers (in-memory primary, in-memory
// stand-in for the legacy bucket reporting kind "gcs"). Real storage_objects table
// (DATABASE_URL), no server, no Google Cloud. Covers the corrected contracts:
//   1. pre-B25 references stay readable while GCS is the PRIMARY driver (no new
//      env), for every supported kind; unknown / cross-tenant keys stay inaccessible;
//      company deletion registers + tombstones legacy references before it commits
//   2. rollback to GCS: migrated and strictly mirrored objects remain readable after
//      switching the active driver back; failed mirrors fail closed; cross-tenant
//      copy resolution is impossible
//   5. one idempotent rollback helper removes BOTH primary and mirror copies on a
//      failed commit; partial cleanup failures stay discoverable and retryable
//   8. a reference shared by several live feature rows is never tombstoned by the
//      sweep while any of them still references it
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, storageObjectsTable, documentVersionsTable, documentsTable, companiesTable, scansTable, exportRunsTable, executiveReportsTable } from "@workspace/db";
import { config } from "../src/config.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import { __resetStorageCountersForTests, storageCounters } from "../src/storage/metrics.js";
import { readAll } from "../src/storage/contract.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as storage from "../src/services/storage.service.js";
import { runMigration } from "../src/storage/migration.js";
import { dbInventoryAdapter, discoverLegacyReferences } from "../src/storage/migration-db.js";

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

// Two REAL tenants (feature rows decide legacy ownership and orphan detection).
let COMPANY = 0;
let OTHER = 0;
const companies: number[] = [];

let primary: MemoryStorageDriver;
let gcs: MemoryStorageDriver; // fake legacy bucket

function uploadsRef(): { reference: string; legacyKey: string } {
  const id = randomUUID();
  return { reference: `/objects/uploads/${id}`, legacyKey: `gs://fake-bucket/.private/uploads/${id}` };
}
async function rows(companyId = COMPANY) {
  return db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, companyId));
}
async function seedLegacy(key: string, bytes: Buffer, contentType = "application/octet-stream") {
  await gcs.put(key, bytes, { contentType, maxBytes: 1 << 20 });
}
/** A document + one version carrying `reference` as its (pre-B25 or native) object path. */
async function seedDocumentVersion(companyId: number, reference: string, versionNumber = 1, documentId?: number): Promise<{ documentId: number; versionId: number }> {
  let docId = documentId;
  if (!docId) {
    const [doc] = await db.insert(documentsTable).values({ companyId, entityType: "company", entityId: companyId, name: `legacy ${versionNumber}`, category: "Company Profile" }).returning({ id: documentsTable.id });
    docId = doc.id;
  }
  const [v] = await db
    .insert(documentVersionsTable)
    .values({ companyId, documentId: docId, versionNumber, objectPath: reference, fileName: `v${versionNumber}.pdf`, fileSize: 3, mimeType: "application/pdf" })
    .returning({ id: documentVersionsTable.id });
  return { documentId: docId, versionId: v.id };
}
async function seedExportRun(companyId: number, reference: string): Promise<number> {
  const [r] = await db.insert(exportRunsTable).values({ companyId, entityType: "contact", format: "csv", status: "completed", objectPath: reference, fileName: "export.csv" }).returning({ id: exportRunsTable.id });
  return r.id;
}
async function seedExecutiveReport(companyId: number, reference: string): Promise<number> {
  const [r] = await db.insert(executiveReportsTable).values({ companyId, reportType: "executive_summary", periodKey: `2026-${randomUUID().slice(0, 8)}`, objectPath: reference }).returning({ id: executiveReportsTable.id });
  return r.id;
}
async function seedScan(companyId: number, imageUrl: string | null): Promise<number> {
  const [sc] = await db.insert(scansTable).values({ companyId, userId: null, status: "completed", imageUrl } as never).returning({ id: scansTable.id });
  return sc.id;
}
async function clearFeatureRows(companyId: number) {
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, companyId));
  await db.delete(scansTable).where(eq(scansTable.companyId, companyId));
  await db.delete(documentVersionsTable).where(eq(documentVersionsTable.companyId, companyId));
  await db.delete(documentsTable).where(eq(documentsTable.companyId, companyId));
  await db.delete(exportRunsTable).where(eq(exportRunsTable.companyId, companyId));
  await db.delete(executiveReportsTable).where(eq(executiveReportsTable.companyId, companyId));
  await db.update(companiesTable).set({ brandLogoKey: null, brandLogoContentType: null }).where(eq(companiesTable.id, companyId));
}
/** Simulate the hosted pre-B25 environment: bucket configured, GCS is the primary, no B25 switches. */
function useGcsPrimary() {
  os.driver = "gcs";
  os.legacyFallback = false;
  os.mirror = false;
  __setDriversForTests({ primary: gcs, legacy: gcs });
}
function useFsPrimary(opts: { fallback?: boolean; mirror?: boolean } = {}) {
  os.driver = "memory";
  os.legacyFallback = opts.fallback ?? false;
  os.mirror = opts.mirror ?? false;
  __setDriversForTests({ primary, legacy: gcs });
}

beforeAll(async () => {
  os.bucketId = "fake-bucket";
  os.privateObjectDir = "/fake-bucket/.private";
  os.legacyDelete = false;
  const stamp = Date.now();
  const [a] = await db.insert(companiesTable).values({ name: `B25C1 tenant A ${stamp}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  const [b] = await db.insert(companiesTable).values({ name: `B25C1 tenant B ${stamp}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  COMPANY = a.id;
  OTHER = b.id;
  companies.push(COMPANY, OTHER);
});

afterAll(async () => {
  Object.assign(os, original);
  __resetStorageRegistryForTests();
  for (const c of companies) await clearFeatureRows(c);
  if (companies.length) await db.delete(companiesTable).where(inArray(companiesTable.id, companies));
});

beforeEach(async () => {
  __resetStorageRegistryForTests();
  __resetStorageCountersForTests();
  primary = new MemoryStorageDriver();
  gcs = new MemoryStorageDriver({ looseKeys: true, kind: "gcs" });
  vi.mocked(repo.transition).mockReset();
  vi.mocked(repo.transition).mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof import("../src/repositories/storage-objects.repository.js")>("../src/repositories/storage-objects.repository.js");
    return actual.transition(...args);
  });
  for (const c of companies) await clearFeatureRows(c);
  useGcsPrimary();
});

describe("1. pre-B25 objects stay readable while GCS is the primary driver (no new environment)", () => {
  it("serves an existing document / old version / export / report / scan image / logo and registers each once", async () => {
    expect(storage.legacyReadMode()).toBe("primary");
    const doc = uploadsRef();
    const oldVersion = uploadsRef();
    const exp = uploadsRef();
    const rep = uploadsRef();
    await seedLegacy(doc.legacyKey, Buffer.from("document v2"), "application/pdf");
    await seedLegacy(oldVersion.legacyKey, Buffer.from("document v1"), "application/pdf");
    await seedLegacy(exp.legacyKey, Buffer.from("csv export"), "text/csv");
    await seedLegacy(rep.legacyKey, Buffer.from("report pdf"), "application/pdf");
    const scanRef = `scans/${COMPANY}/4242.jpg`;
    await seedLegacy(`gs://fake-bucket/${scanRef}`, Buffer.from("jpeg bytes"), "image/jpeg");
    const logoRef = `branding/${COMPANY}/${"a".repeat(32)}.png`;
    await seedLegacy(`gs://fake-bucket/${logoRef}`, Buffer.from("png bytes"), "image/png");
    // the feature rows that carry the pre-B25 references (exactly the hosted shape)
    const { documentId } = await seedDocumentVersion(COMPANY, oldVersion.reference, 1);
    await seedDocumentVersion(COMPANY, doc.reference, 2, documentId);
    await seedExportRun(COMPANY, exp.reference);
    await seedExecutiveReport(COMPANY, rep.reference);
    await seedScan(COMPANY, scanRef);
    await db.update(companiesTable).set({ brandLogoKey: logoRef, brandLogoContentType: "image/png" }).where(eq(companiesTable.id, COMPANY));

    const cases: Array<[storage.ObjectRef, string]> = [
      [{ companyId: COMPANY, kind: "document", reference: doc.reference }, "document v2"],
      [{ companyId: COMPANY, kind: "document", reference: oldVersion.reference }, "document v1"],
      [{ companyId: COMPANY, kind: "export", reference: exp.reference }, "csv export"],
      [{ companyId: COMPANY, kind: "report", reference: rep.reference }, "report pdf"],
      [{ companyId: COMPANY, kind: "scan_image", reference: scanRef }, "jpeg bytes"],
      [{ companyId: COMPANY, kind: "branding_logo", reference: logoRef }, "png bytes"],
    ];
    for (const [ref, expected] of cases) {
      const opened = await storage.openByReference(ref);
      expect(opened, `${ref.kind} ${ref.reference}`).not.toBeNull();
      expect((await readAll(opened!.stream, 1 << 20)).toString()).toBe(expected);
      expect(await storage.mintDownloadUrl("http://x", { ...ref, userId: null })).toMatch(/^http:\/\/x\/api\/files\/[0-9a-f-]{36}$/);
    }
    const all = await rows();
    expect(all).toHaveLength(6);
    for (const r of all) {
      expect(r.driver).toBe("gcs");
      expect(r.state).toBe("active");
      expect(r.legacyKey).toMatch(/^gs:\/\/fake-bucket\//);
    }
    // a second read reuses the registration
    await storage.openByReference(cases[0][0]);
    expect(await rows()).toHaveLength(6);
  });

  it("an unknown key, a cross-tenant scan / logo key and another tenant's document handle stay inaccessible", async () => {
    const theirs = uploadsRef();
    await seedLegacy(theirs.legacyKey, Buffer.from("theirs"));
    await seedLegacy(`gs://fake-bucket/scans/${OTHER}/1.jpg`, Buffer.from("jpg"), "image/jpeg");
    await seedLegacy(`gs://fake-bucket/branding/${OTHER}/${"b".repeat(32)}.png`, Buffer.from("png"), "image/png");
    await seedDocumentVersion(OTHER, theirs.reference);
    await seedScan(OTHER, `scans/${OTHER}/1.jpg`);
    await db.update(companiesTable).set({ brandLogoKey: `branding/${OTHER}/${"b".repeat(32)}.png`, brandLogoContentType: "image/png" }).where(eq(companiesTable.id, OTHER));
    // the OTHER tenant's document handle, resolved as OTHER, is fine …
    expect(await storage.openByReference({ companyId: OTHER, kind: "document", reference: theirs.reference })).not.toBeNull();
    // … but tenant COMPANY resolving the same handle gets its own (absent) namespace → null, and no row for COMPANY
    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference: theirs.reference })).toBeNull();
    expect(await storage.openByReference({ companyId: COMPANY, kind: "scan_image", reference: `scans/${OTHER}/1.jpg` })).toBeNull();
    expect(await storage.openByReference({ companyId: COMPANY, kind: "branding_logo", reference: `branding/${OTHER}/${"b".repeat(32)}.png` })).toBeNull();
    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference: "/objects/uploads/does-not-exist" })).toBeNull();
    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference: "../../etc/passwd" })).toBeNull();
    // a legacy-shaped handle that exists in the bucket but is referenced by NO feature row of the caller is never served
    const unowned = uploadsRef();
    await seedLegacy(unowned.legacyKey, Buffer.from("unowned"));
    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference: unowned.reference })).toBeNull();
    expect(await rows(COMPANY)).toHaveLength(0);
  });

  it("the diagnostics expose the compatibility state without any key", async () => {
    const m = await storage.storageMetrics();
    expect(m.driver).toBe("gcs");
    expect(m.legacyReads).toBe("primary");
    useFsPrimary({ fallback: false });
    expect((await storage.storageMetrics()).legacyReads).toBe("off");
    useFsPrimary({ fallback: true });
    expect((await storage.storageMetrics()).legacyReads).toBe("fallback");
    expect(JSON.stringify(m)).not.toMatch(/gs:\/\/|fake-bucket|tenants\//);
  });

  it("a tombstoned legacy reference is never served again even while GCS is the primary", async () => {
    const ref = uploadsRef();
    await seedLegacy(ref.legacyKey, Buffer.from("x"));
    await seedDocumentVersion(COMPANY, ref.reference);
    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference: ref.reference })).not.toBeNull();
    await storage.deleteByReference({ companyId: COMPANY, kind: "document", reference: ref.reference });
    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference: ref.reference })).toBeNull();
    expect(gcs.objects.has(ref.legacyKey)).toBe(true); // legacy bytes are never deleted in this phase
  });
});

describe("1b. company deletion registers and tombstones legacy references before it commits", () => {
  let companyId = 0;
  const refs: { doc: ReturnType<typeof uploadsRef>; v1: ReturnType<typeof uploadsRef> } = { doc: uploadsRef(), v1: uploadsRef() };
  let docId = 0;

  beforeEach(async () => {
    const [co] = await db.insert(companiesTable).values({ name: `B25C1 legacy ${Date.now()}`, plan: "professional", status: "active", brandLogoKey: `branding/0/${"c".repeat(32)}.png` } as never).returning({ id: companiesTable.id });
    companyId = co.id;
    await db.update(companiesTable).set({ brandLogoKey: `branding/${companyId}/${"c".repeat(32)}.png`, brandLogoContentType: "image/png" }).where(eq(companiesTable.id, companyId));
    const [doc] = await db.insert(documentsTable).values({ companyId, entityType: "company", entityId: companyId, name: "legacy", category: "Company Profile" }).returning({ id: documentsTable.id });
    docId = doc.id;
    const [v1] = await db.insert(documentVersionsTable).values({ companyId, documentId: docId, versionNumber: 1, objectPath: refs.v1.reference, fileName: "v1.pdf", fileSize: 3, mimeType: "application/pdf" }).returning({ id: documentVersionsTable.id });
    await db.insert(documentVersionsTable).values({ companyId, documentId: docId, versionNumber: 2, objectPath: refs.doc.reference, fileName: "v2.pdf", fileSize: 3, mimeType: "application/pdf" });
    await db.update(documentsTable).set({ currentVersionId: v1.id }).where(eq(documentsTable.id, docId));
    await db.insert(scansTable).values({ companyId, userId: null, status: "completed", imageUrl: `scans/${companyId}/77.jpg` } as never);
    await seedLegacy(refs.doc.legacyKey, Buffer.from("v2"));
    await seedLegacy(refs.v1.legacyKey, Buffer.from("v1"));
    await seedLegacy(`gs://fake-bucket/scans/${companyId}/77.jpg`, Buffer.from("jpg"));
    await seedLegacy(`gs://fake-bucket/branding/${companyId}/${"c".repeat(32)}.png`, Buffer.from("png"));
  });

  afterAll(async () => {
    if (companyId) {
      await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, companyId));
      await db.delete(scansTable).where(eq(scansTable.companyId, companyId));
      await db.delete(documentVersionsTable).where(eq(documentVersionsTable.companyId, companyId));
      await db.delete(documentsTable).where(eq(documentsTable.companyId, companyId));
      await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
    }
  });

  it("leaves no silent, untracked legacy GCS object behind", async () => {
    expect(await rows(companyId)).toHaveLength(0); // nothing was ever read → nothing registered yet
    const n = await db.transaction(async (tx) => {
      const marked = await storage.tombstoneCompany(tx, companyId);
      await tx.delete(scansTable).where(eq(scansTable.companyId, companyId));
      await tx.delete(documentVersionsTable).where(eq(documentVersionsTable.companyId, companyId));
      await tx.delete(documentsTable).where(eq(documentsTable.companyId, companyId));
      await tx.delete(companiesTable).where(eq(companiesTable.id, companyId));
      return marked;
    });
    expect(n).toBeGreaterThanOrEqual(4);
    const tombstones = await rows(companyId);
    const legacyKeys = tombstones.map((r) => r.legacyKey).sort();
    expect(legacyKeys).toEqual([
      `gs://fake-bucket/branding/${companyId}/${"c".repeat(32)}.png`,
      refs.doc.legacyKey,
      refs.v1.legacyKey,
      `gs://fake-bucket/scans/${companyId}/77.jpg`,
    ].sort());
    for (const r of tombstones) expect(["deleting", "deleted"]).toContain(r.state);
    // the purge keeps the legacy objects (OBJECT_STORAGE_LEGACY_DELETE is off) but every one stays discoverable
    await storage.runPurgeCompanyJob({ companyId });
    const after = await rows(companyId);
    expect(after.every((r) => r.state === "deleted" && r.lastError === "LEGACY_RETAINED" && r.legacyKey)).toBe(true);
    expect((await repo.listRetainedLegacyObjects(100)).filter((r) => r.companyId === companyId)).toHaveLength(4);
    expect(gcs.objects.size).toBeGreaterThanOrEqual(4);
    // day-old tombstone purge never drops a retained legacy record
    expect((await repo.listPurgeableTombstones(new Date(Date.now() + 10 * 24 * 3600 * 1000), 1000)).some((r) => r.companyId === companyId)).toBe(false);
  });
});

describe("2. rollback to GCS is real", () => {
  it("a legacy object migrated to the filesystem stays readable after switching the active driver back to GCS", async () => {
    useFsPrimary({ fallback: true });
    const ref = uploadsRef();
    const bytes = randomBytes(3000);
    await seedLegacy(ref.legacyKey, bytes, "application/pdf");
    await seedDocumentVersion(COMPANY, ref.reference);
    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference: ref.reference })).not.toBeNull(); // registers driver=gcs
    const s = await runMigration({
      mode: "copy",
      source: gcs,
      target: primary,
      inventory: dbInventoryAdapter(),
      discover: async () => ({ candidates: [], unattributable: 0 }),
      limits: { document: 1 << 20, export: 1 << 20, report: 1 << 20, scan_image: 1 << 20, branding_logo: 1 << 20 },
    });
    expect(s.counts.copied).toBe(1);
    const [row] = await rows();
    expect(row.driver).toBe("memory");
    expect(row.legacyKey).toBe(ref.legacyKey);

    useGcsPrimary(); // configuration rollback: GCS is primary again, the fs copy is unreachable
    const opened = await storage.openObject((await repo.findById(row.id))!);
    expect((await readAll(opened.stream, 1 << 20)).equals(bytes)).toBe(true);
    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference: ref.reference })).not.toBeNull();
  });

  it("a filesystem-primary object with a successful strict mirror stays readable after the switch (via its persisted mirror copy)", async () => {
    useFsPrimary({ mirror: true });
    const bytes = randomBytes(2048);
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "export", contentType: "text/csv", buffer: bytes });
    const row = (await repo.findById(stored.objectId))!;
    expect(row.mirrorState).toBe("ok");
    expect(row.mirrorKey).toMatch(/^gs:\/\/fake-bucket\/tenants\//);
    expect(gcs.objects.has(row.mirrorKey!)).toBe(true);

    useGcsPrimary();
    const opened = await storage.openObject((await repo.findById(stored.objectId))!);
    expect((await readAll(opened.stream, 1 << 20)).equals(bytes)).toBe(true);
    expect(storageCounters().legacyFallbackReads).toBe(1);
  });

  it("a failed or absent mirror fails closed with a sanitized reason after the switch", async () => {
    useFsPrimary({ mirror: false });
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "export", contentType: "text/csv", buffer: Buffer.from("no mirror") });
    useGcsPrimary();
    await expect(storage.openObject((await repo.findById(stored.objectId))!)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", reason: "NO_READABLE_COPY" });

    useFsPrimary({ mirror: true });
    gcs.failNextPut = true;
    await expect(storage.storeBuffer({ companyId: COMPANY, kind: "export", contentType: "text/csv", buffer: Buffer.from("x") })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    const failed = (await rows()).find((r) => r.state === "failed")!;
    // the mirror location is persisted for CLEANUP, but an unverified mirror is never a rollback copy
    expect(failed.mirrorState).not.toBe("ok");
    useGcsPrimary();
    expect(await storage.resolveReadable({ companyId: COMPANY, kind: "export", reference: failed.reference })).toBeNull();
    expect(await storage.locateCopies(failed)).toEqual([]);
  });

  it("cross-tenant copy resolution is impossible", async () => {
    useFsPrimary({ mirror: true });
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "export", contentType: "text/csv", buffer: Buffer.from("mine") });
    useGcsPrimary();
    expect(await storage.resolveReadable({ companyId: OTHER, kind: "export", reference: stored.reference })).toBeNull();
    expect(await storage.loadForDownload({ v: 1, op: "get", o: stored.objectId, c: OTHER, u: null, exp: 0 })).toBeNull();
    expect(await storage.authorizeObject(OTHER, stored.objectId)).toBeNull();
  });
});

describe("5. primary + mirror cleanup on failed commits", () => {
  it("primary ok, mirror ok, DB transition fails → neither copy remains", async () => {
    useFsPrimary({ mirror: true });
    vi.mocked(repo.transition).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("pdf") })).rejects.toThrow(/database unavailable/);
    expect(primary.objects.size).toBe(0);
    expect(gcs.objects.size).toBe(0);
  });

  it("primary ok, mirror fails under strict mode → primary removed, row failed", async () => {
    useFsPrimary({ mirror: true });
    gcs.failNextPut = true;
    await expect(storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("pdf") })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(primary.objects.size).toBe(0);
    expect(gcs.objects.size).toBe(0);
    const [row] = await rows();
    expect(row.state).toBe("failed");
    expect(storageCounters().mirrorFailures).toBe(1);
  });

  it("cleanup of one provider fails → the row stays discoverable and a retry removes it; other committed objects are untouched", async () => {
    useFsPrimary({ mirror: true });
    const committed = await storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("keep me") });
    await seedExecutiveReport(COMPANY, committed.reference); // a live feature row references the committed object
    vi.mocked(repo.transition).mockRejectedValueOnce(new Error("database unavailable"));
    gcs.failNextDelete = true; // the mirror copy cannot be removed during rollback
    await expect(storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("pdf") })).rejects.toThrow(/database unavailable/);
    expect(primary.objects.size).toBe(1); // only the committed object
    expect(gcs.objects.size).toBe(2); // committed mirror + the stuck mirror copy
    const stuck = (await rows()).find((r) => r.id !== committed.objectId)!;
    expect(["failed", "deleting"]).toContain(stuck.state);
    expect(stuck.lastError).toBe("CLEANUP_PENDING");
    expect(stuck.mirrorKey).toMatch(/^gs:\/\//);
    expect(storageCounters().deleteFailures).toBe(1);
    // the sweep retries and removes exactly the stuck mirror copy
    os.pendingTtlMs = 0;
    await storage.sweepStorage(new Date(Date.now() + 1000));
    expect(gcs.objects.size).toBe(1);
    expect(primary.objects.size).toBe(1);
    expect((await repo.findById(stuck.id))!.state).toBe("deleted");
    expect((await repo.findById(committed.objectId))!.state).toBe("active");
    expect((await readAll((await storage.openObject((await repo.findById(committed.objectId))!)).stream, 100)).toString()).toBe("keep me");
  });
});

describe("8. shared references are never tombstoned while another live row still references them", () => {
  let companyId = 0;
  afterAll(async () => {
    if (companyId) {
      await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, companyId));
      await db.delete(documentVersionsTable).where(eq(documentVersionsTable.companyId, companyId));
      await db.delete(documentsTable).where(eq(documentsTable.companyId, companyId));
      await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
    }
  });

  it("hard-deleting one of two versions sharing an object leaves the bytes untouched", async () => {
    useFsPrimary();
    const [co] = await db.insert(companiesTable).values({ name: `B25C1 dup ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
    companyId = co.id;
    const stored = await storage.storeBuffer({ companyId, kind: "document", contentType: "text/plain", buffer: Buffer.from("shared"), entityType: "document_version", entityId: 0 });
    const [doc] = await db.insert(documentsTable).values({ companyId, entityType: "company", entityId: companyId, name: "dup", category: "Company Profile" }).returning({ id: documentsTable.id });
    const [v1] = await db.insert(documentVersionsTable).values({ companyId, documentId: doc.id, versionNumber: 1, objectPath: stored.reference, fileName: "a.txt", fileSize: 6, mimeType: "text/plain" }).returning({ id: documentVersionsTable.id });
    const [v2] = await db.insert(documentVersionsTable).values({ companyId, documentId: doc.id, versionNumber: 2, objectPath: stored.reference, fileName: "a.txt", fileSize: 6, mimeType: "text/plain" }).returning({ id: documentVersionsTable.id });
    await storage.bindEntity(undefined, stored.objectId, "document_version", v1.id);
    await db.delete(documentVersionsTable).where(eq(documentVersionsTable.id, v1.id)); // the bound entity is gone, v2 still references the bytes
    os.pendingTtlMs = 0; // no grace window: the sweep judges the object immediately
    const summary = await storage.sweepStorage(new Date(Date.now() + 1000));
    expect(summary.entityOrphans).toBe(0);
    expect((await repo.findById(stored.objectId))!.state).toBe("active");
    expect(primary.objects.size).toBe(1);
    await db.delete(documentVersionsTable).where(eq(documentVersionsTable.id, v2.id));
    await storage.sweepStorage(new Date(Date.now() + 1000));
    expect((await repo.findById(stored.objectId))!.state).toBe("deleted");
    expect(primary.objects.size).toBe(0);
    void and;
  });
});

describe("discovery helper", () => {
  it("scopes legacy discovery to one company when asked", async () => {
    const out = await discoverLegacyReferences({ companyId: COMPANY });
    expect(out.candidates.every((c) => c.companyId === COMPANY)).toBe(true);
  });
});
