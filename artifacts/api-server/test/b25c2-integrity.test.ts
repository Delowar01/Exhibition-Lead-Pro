// B25 Correction 2 — rollback-copy integrity. Copies read from the legacy bucket
// (migrated legacy copy, strict mirror, native GCS object) are verified while
// streaming against the inventory's stored size and SHA-256:
//   • a tampered strict mirror after a configuration rollback fails closed
//   • a tampered migrated legacy rollback copy fails closed
//   • a correct mirror streams completely
//   • a size mismatch fails (early when the copy is longer)
//   • the verifier holds back at most ONE chunk (no unbounded buffering) and
//     never lets a digest mismatch complete the response
//   • a pre-B25 legacy row with no stored digest streams on provider-level
//     integrity only (documented limitation until it is copied + verified)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq } from "drizzle-orm";
import { db, storageObjectsTable } from "@workspace/db";
import { config } from "../src/config.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { StorageError, readAll } from "../src/storage/contract.js";
import { VerifyingStream } from "../src/storage/verify.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import { __resetStorageCountersForTests, storageCounters } from "../src/storage/metrics.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as storage from "../src/services/storage.service.js";
import { runMigration } from "../src/storage/migration.js";
import { dbInventoryAdapter } from "../src/storage/migration-db.js";

const COMPANY = 9_500_000 + Math.floor(Math.random() * 400_000);
const os = config.objectStorage as unknown as { driver: string; bucketId: string; privateObjectDir: string; legacyFallback: boolean; mirror: boolean; legacyDelete: boolean };
const original = { ...os };
let primary: MemoryStorageDriver;
let gcs: MemoryStorageDriver;

function sha(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}
function useFsPrimary(opts: { mirror?: boolean; fallback?: boolean } = {}) {
  os.driver = "memory";
  os.mirror = opts.mirror ?? false;
  os.legacyFallback = opts.fallback ?? false;
  __setDriversForTests({ primary, legacy: gcs });
}
function useGcsPrimary() {
  os.driver = "gcs";
  os.mirror = false;
  os.legacyFallback = false;
  __setDriversForTests({ primary: gcs, legacy: gcs });
}
/** Flip bytes in place without changing the length. */
function tamper(key: string) {
  const o = gcs.objects.get(key)!;
  const bytes = Buffer.from(o.bytes);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  gcs.objects.set(key, { ...o, bytes });
}
/** Flowing-mode consumer (like `pipeline(stream, res)` in the byte route): every released chunk is kept, then the end or the error. */
function collect(stream: Readable): Promise<{ bytes: Buffer; error: unknown }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.once("error", (error) => resolve({ bytes: Buffer.concat(chunks), error }));
    stream.once("end", () => resolve({ bytes: Buffer.concat(chunks), error: null }));
  });
}

beforeAll(() => {
  os.bucketId = "fake-bucket";
  os.privateObjectDir = "/fake-bucket/.private";
  os.legacyDelete = false;
});
afterAll(async () => {
  Object.assign(os, original);
  __resetStorageRegistryForTests();
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
});
beforeEach(async () => {
  __resetStorageRegistryForTests();
  __resetStorageCountersForTests();
  primary = new MemoryStorageDriver();
  gcs = new MemoryStorageDriver({ looseKeys: true, kind: "gcs" });
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  useFsPrimary();
});

describe("7. rollback-copy integrity while streaming", () => {
  it("a tampered strict mirror fails closed after the configuration rollback (sanitized integrity error, truncated body, counter)", async () => {
    useFsPrimary({ mirror: true });
    const bytes = randomBytes(4096);
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "export", contentType: "text/csv", buffer: bytes });
    const row = (await repo.findById(stored.objectId))!;
    expect(row.mirrorState).toBe("ok");
    tamper(row.mirrorKey!);

    useGcsPrimary();
    const opened = await storage.openObject(row);
    const out = await collect(opened.stream);
    expect(out.error).toBeInstanceOf(StorageError);
    expect((out.error as StorageError).code).toBe("STORAGE_INTEGRITY");
    expect((out.error as StorageError).reason).toBe("DIGEST_MISMATCH");
    expect(out.bytes.length).toBeLessThan(bytes.length); // never a complete body on a mismatch
    expect(storageCounters().integrityFailures).toBe(1);
    expect(JSON.stringify(out.error)).not.toMatch(/gs:\/\/|fake-bucket|tenants\//);
  });

  it("a tampered migrated legacy rollback copy fails closed", async () => {
    useFsPrimary({ fallback: true });
    const bytes = randomBytes(3000);
    const legacyKey = `gs://fake-bucket/.private/uploads/${randomUUID()}`;
    await gcs.put(legacyKey, bytes, { contentType: "application/pdf", maxBytes: 1 << 20 });
    const id = randomUUID();
    await repo.insert({ id, companyId: COMPANY, kind: "document", reference: `/objects/uploads/${legacyKey.split("/").pop()}`, storageKey: `tenants/${COMPANY}/documents/${id}`, driver: "gcs", legacyKey, contentType: "application/pdf", sizeBytes: bytes.length, sha256: null, state: "active" });
    const s = await runMigration({
      mode: "copy",
      source: gcs,
      target: primary,
      inventory: dbInventoryAdapter(),
      discover: async () => ({ candidates: [], unattributable: 0 }),
      limits: { document: 1 << 20, export: 1 << 20, report: 1 << 20, scan_image: 1 << 20, branding_logo: 1 << 20 },
    });
    expect(s.counts.copied).toBe(1);
    const row = (await repo.findById(id))!;
    expect(row.driver).toBe("memory");
    expect(row.sha256).toBe(sha(bytes));

    useGcsPrimary(); // rollback: the legacy copy is the only readable one
    const good = await collect((await storage.openObject(row)).stream);
    expect(good.error).toBeNull();
    expect(good.bytes.equals(bytes)).toBe(true);

    tamper(legacyKey);
    const bad = await collect((await storage.openObject(row)).stream);
    expect((bad.error as StorageError)?.code).toBe("STORAGE_INTEGRITY");
    expect(bad.bytes.length).toBeLessThan(bytes.length);
  });

  it("a correct GCS mirror streams completely and a size mismatch fails", async () => {
    useFsPrimary({ mirror: true });
    const bytes = randomBytes(2048);
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: bytes });
    const row = (await repo.findById(stored.objectId))!;
    useGcsPrimary();
    const ok = await collect((await storage.openObject(row)).stream);
    expect(ok.error).toBeNull();
    expect(ok.bytes.equals(bytes)).toBe(true);
    expect(storageCounters().integrityFailures).toBe(0);

    // longer copy: refused as soon as the expected size is exceeded
    const o = gcs.objects.get(row.mirrorKey!)!;
    gcs.objects.set(row.mirrorKey!, { ...o, bytes: Buffer.concat([o.bytes, Buffer.from("extra")]) });
    const longer = await collect((await storage.openObject(row)).stream);
    expect((longer.error as StorageError)?.code).toBe("STORAGE_INTEGRITY");
    expect((longer.error as StorageError)?.reason).toBe("SIZE_MISMATCH");
    // shorter copy
    gcs.objects.set(row.mirrorKey!, { ...o, bytes: o.bytes.subarray(0, 1000) });
    const shorter = await collect((await storage.openObject(row)).stream);
    expect((shorter.error as StorageError)?.code).toBe("STORAGE_INTEGRITY");
    expect((shorter.error as StorageError)?.reason).toBe("SIZE_MISMATCH");
  });

  it("the verifier holds back at most one chunk, passes a correct stream through unchanged and withholds the tail on a mismatch", async () => {
    const chunks = Array.from({ length: 64 }, () => randomBytes(1024));
    const all = Buffer.concat(chunks);
    const good = new VerifyingStream({ sizeBytes: all.length, sha256: sha(all) });
    const outGood: Buffer[] = [];
    await pipeline(Readable.from(chunks), good, async function (source) {
      for await (const c of source) outGood.push(c as Buffer);
    });
    expect(Buffer.concat(outGood).equals(all)).toBe(true);
    expect(good.maxHeld).toBeLessThanOrEqual(1024);

    const bad = new VerifyingStream({ sizeBytes: all.length, sha256: "00".repeat(32) });
    const outBad = await collect(Readable.from(chunks).pipe(bad));
    expect((outBad.error as StorageError)?.code).toBe("STORAGE_INTEGRITY");
    expect(outBad.bytes.length).toBe(all.length - 1024); // the last chunk is never released
    expect(bad.maxHeld).toBeLessThanOrEqual(1024);
  });

  it("a pre-B25 legacy row without a stored digest streams on provider-level integrity only (documented limitation)", async () => {
    useGcsPrimary();
    const bytes = randomBytes(512);
    const legacyKey = `gs://fake-bucket/scans/${COMPANY}/7.jpg`;
    await gcs.put(legacyKey, bytes, { contentType: "image/jpeg", maxBytes: 1 << 20 });
    const id = randomUUID();
    await repo.insert({ id, companyId: COMPANY, kind: "scan_image", reference: `scans/${COMPANY}/7.jpg`, storageKey: `tenants/${COMPANY}/scans/${id}`, driver: "gcs", legacyKey, contentType: "image/jpeg", sizeBytes: null, sha256: null, state: "active" });
    const out = await collect((await storage.openObject((await repo.findById(id))!)).stream);
    expect(out.error).toBeNull();
    expect(out.bytes.equals(bytes)).toBe(true);
    expect((await readAll((await storage.openObject((await repo.findById(id))!)).stream, 1024)).length).toBe(512);
  });
});
