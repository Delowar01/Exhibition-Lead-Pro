// B25 Correction 1 — scan-image lifecycle under injected database failures.
// Fake drivers + real tables, no server, no AI call (the OCR step is not part of
// the image binding).
//   1. initial upload: object written, scan-row update fails → object tombstoned,
//      scan keeps no reference, no bytes left behind
//   2. replacement: new object written, scan-row update fails → new object
//      tombstoned, the previous image stays active and readable
//   3. cleanup retry after a simulated deletion failure settles via the job
//   + the orphan sweep detects a crash-window object (active row the scan no
//     longer references) and never touches another tenant's objects
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { db, storageObjectsTable, scansTable, companiesTable } from "@workspace/db";
import { config } from "../src/config.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import { readAll } from "../src/storage/contract.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as scansRepo from "../src/repositories/scans.repository.js";
import * as storage from "../src/services/storage.service.js";
import { storeAndBindScanImage } from "../src/services/scans.service.js";

vi.mock("../src/repositories/scans.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/scans.repository.js")>();
  return { ...actual, bindImage: vi.fn(actual.bindImage) };
});

const os = config.objectStorage as unknown as { driver: string; legacyFallback: boolean; mirror: boolean; pendingTtlMs: number };
const original = { ...os };
let primary: MemoryStorageDriver;
let companyA = 0;
let companyB = 0;
let scanA = 0;
let scanB = 0;
let jpegDataUrl = "";
let pngDataUrl = "";

async function objectsFor(companyId: number) {
  return db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, companyId));
}
async function scanRef(id: number) {
  const [s] = await db.select({ imageUrl: scansTable.imageUrl }).from(scansTable).where(eq(scansTable.id, id));
  return s?.imageUrl ?? null;
}

beforeAll(async () => {
  os.driver = "memory";
  os.legacyFallback = false;
  os.mirror = false;
  const [a] = await db.insert(companiesTable).values({ name: `B25C1 scans A ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  const [b] = await db.insert(companiesTable).values({ name: `B25C1 scans B ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  companyA = a.id;
  companyB = b.id;
  jpegDataUrl = `data:image/jpeg;base64,${(await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer()).toString("base64")}`;
  pngDataUrl = `data:image/png;base64,${(await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 40, g: 200, b: 40 } } }).png().toBuffer()).toString("base64")}`;
});

afterAll(async () => {
  Object.assign(os, original);
  __resetStorageRegistryForTests();
  for (const cid of [companyA, companyB].filter(Boolean)) {
    await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, cid));
    await db.delete(scansTable).where(eq(scansTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
});

beforeEach(async () => {
  __resetStorageRegistryForTests();
  primary = new MemoryStorageDriver();
  __setDriversForTests({ primary, legacy: null });
  vi.mocked(scansRepo.bindImage).mockReset();
  vi.mocked(scansRepo.bindImage).mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof import("../src/repositories/scans.repository.js")>("../src/repositories/scans.repository.js");
    return actual.bindImage(...args);
  });
  await db.delete(storageObjectsTable).where(inArray(storageObjectsTable.companyId, [companyA, companyB]));
  await db.delete(scansTable).where(inArray(scansTable.companyId, [companyA, companyB]));
  const [sa] = await db.insert(scansTable).values({ companyId: companyA, userId: null, status: "completed", imageUrl: null } as never).returning({ id: scansTable.id });
  const [sb] = await db.insert(scansTable).values({ companyId: companyB, userId: null, status: "completed", imageUrl: null } as never).returning({ id: scansTable.id });
  scanA = sa.id;
  scanB = sb.id;
  // tenant B owns one healthy image throughout
  await storeAndBindScanImage({ scanId: scanB, companyId: companyB, imageData: jpegDataUrl });
});

describe("6. scan image lifecycle", () => {
  it("initial upload: the scan-row update fails after the object was written → object tombstoned, no reference, no bytes", async () => {
    vi.mocked(scansRepo.bindImage).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(storeAndBindScanImage({ scanId: scanA, companyId: companyA, imageData: jpegDataUrl })).rejects.toThrow(/database unavailable/);
    expect(await scanRef(scanA)).toBeNull();
    const objs = await objectsFor(companyA);
    expect(objs).toHaveLength(1);
    expect(["deleting", "deleted"]).toContain(objs[0].state);
    expect(primary.objects.has(objs[0].storageKey)).toBe(false);
    // tenant B untouched
    const [bRow] = await objectsFor(companyB);
    expect(bRow.state).toBe("active");
    expect(primary.objects.has(bRow.storageKey)).toBe(true);
  });

  it("replacement: the scan-row update fails after the new object was written → new object tombstoned, previous image still readable", async () => {
    const first = await storeAndBindScanImage({ scanId: scanA, companyId: companyA, imageData: jpegDataUrl });
    expect(await scanRef(scanA)).toBe(first.reference);
    vi.mocked(scansRepo.bindImage).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(storeAndBindScanImage({ scanId: scanA, companyId: companyA, imageData: pngDataUrl, previousReference: first.reference })).rejects.toThrow(/database unavailable/);
    expect(await scanRef(scanA)).toBe(first.reference);
    const objs = await objectsFor(companyA);
    const firstRow = objs.find((o) => o.reference === first.reference)!;
    const newRow = objs.find((o) => o.reference !== first.reference)!;
    expect(firstRow.state).toBe("active");
    expect(["deleting", "deleted"]).toContain(newRow.state);
    expect(primary.objects.has(firstRow.storageKey)).toBe(true);
    expect(primary.objects.has(newRow.storageKey)).toBe(false);
    const opened = await storage.openByReference({ companyId: companyA, kind: "scan_image", reference: first.reference });
    expect((await readAll(opened!.stream, 1 << 20)).length).toBeGreaterThan(0);

    // a successful replacement retires the previous image only after the new reference committed
    const second = await storeAndBindScanImage({ scanId: scanA, companyId: companyA, imageData: pngDataUrl, previousReference: first.reference });
    expect(await scanRef(scanA)).toBe(second.reference);
    expect((await repo.findById(firstRow.id))!.state).toBe("deleted");
    expect(await storage.openByReference({ companyId: companyA, kind: "scan_image", reference: first.reference })).toBeNull();
  });

  it("cleanup retry: a failed physical delete keeps a retryable tombstone that the job settles; the live image is untouched", async () => {
    const first = await storeAndBindScanImage({ scanId: scanA, companyId: companyA, imageData: jpegDataUrl });
    primary.failNextDelete = true;
    const second = await storeAndBindScanImage({ scanId: scanA, companyId: companyA, imageData: pngDataUrl, previousReference: first.reference });
    const old = (await objectsFor(companyA)).find((o) => o.reference === first.reference)!;
    expect(old.state).toBe("deleting");
    expect(primary.objects.has(old.storageKey)).toBe(true);
    expect(await storage.openByReference({ companyId: companyA, kind: "scan_image", reference: first.reference })).toBeNull();
    await storage.runDeleteObjectJob({ objectId: old.id });
    expect((await repo.findById(old.id))!.state).toBe("deleted");
    expect(primary.objects.has(old.storageKey)).toBe(false);
    const live = (await objectsFor(companyA)).find((o) => o.reference === second.reference)!;
    expect(live.state).toBe("active");
    expect(primary.objects.has(live.storageKey)).toBe(true);
  });

  it("orphan sweep: an active object the scan no longer references is detected; other tenants are never affected", async () => {
    const first = await storeAndBindScanImage({ scanId: scanA, companyId: companyA, imageData: jpegDataUrl });
    // crash window: a second object became active but the scan still points at the first
    const stray = await storage.storeBuffer({ companyId: companyA, kind: "scan_image", contentType: "image/jpeg", buffer: Buffer.from("stray"), entityType: "scan", entityId: scanA });
    // inside the grace window the crash-window object is left alone (the binding transaction may still follow) …
    expect((await storage.sweepStorage(new Date())).entityOrphans).toBe(0);
    expect((await repo.findById(stray.objectId))!.state).toBe("active");
    // … after it, the sweep retires it
    os.pendingTtlMs = 0;
    const summary = await storage.sweepStorage(new Date(Date.now() + 1000));
    expect(summary.entityOrphans).toBe(1);
    expect((await repo.findById(stray.objectId))!.state).toBe("deleted");
    expect(primary.objects.has((await repo.findById(stray.objectId))!.storageKey)).toBe(false);
    const firstRow = (await objectsFor(companyA)).find((o) => o.reference === first.reference)!;
    expect(firstRow.state).toBe("active");
    const [bRow] = await objectsFor(companyB);
    expect(bRow.state).toBe("active");
    expect(primary.objects.has(bRow.storageKey)).toBe(true);
  });
});
