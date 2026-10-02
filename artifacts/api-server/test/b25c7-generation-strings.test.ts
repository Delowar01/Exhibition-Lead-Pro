// B25 Correction 7 — EXACT GCS GENERATION STRINGS. A Google Cloud Storage
// object generation is a 64-bit integer that the JSON API reports as a DECIMAL
// STRING. Before this correction `GcsStorageDriver.delete` converted the
// caller's generation with `Number(opts.ifGeneration)` right before the SDK
// call: every generation above Number.MAX_SAFE_INTEGER (2^53 − 1 =
// 9007199254740991) was silently rounded, so the precondition the provider
// received was NOT the generation the caller proved — the delete either failed
// (412, our own object retained) or, worse, matched a NEIGHBOURING generation.
// After this correction the generation travels as the exact string from
// `FileMetadata.generation` through `ObjectHead` / `PutResult` /
// `WriteAttempt.copies` to `ifGenerationMatch` and is never parsed, coerced or
// rounded anywhere; a value that is not a canonical decimal string fails closed
// BEFORE the SDK is contacted.
//
// The REAL GcsStorageDriver and the REAL storage service run over the fake SDK
// whose generations are exact strings (bigint counter), so values beyond the
// safe-integer range are represented without any rounding. Every provider
// delete recorded during this suite must carry a STRING `ifGenerationMatch`
// that is a canonical decimal (suite-wide afterEach).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, storageObjectsTable, companiesTable, type InsertStorageObject, type StorageObjectRow } from "@workspace/db";
import { config } from "../src/config.js";
import { GcsStorageDriver } from "../src/storage/gcs-driver.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { StorageError } from "../src/storage/contract.js";
import { runMigration, type InventoryAdapter, type MigrationCandidate } from "../src/storage/migration.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import type { StorageKind } from "../src/storage/keys.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as storage from "../src/services/storage.service.js";
import { FakeBucketStore, fakeGcsClient } from "./helpers/fake-gcs-sdk.js";

vi.mock("../src/repositories/storage-objects.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/storage-objects.repository.js")>();
  return { ...actual, transition: vi.fn(actual.transition) };
});
type Repo = typeof import("../src/repositories/storage-objects.repository.js");
const actualRepo = await vi.importActual<Repo>("../src/repositories/storage-objects.repository.js");

/** A valid GCS generation one above the largest integer JavaScript represents exactly: Number(BIG) === 9007199254740992. */
const BIG = "9007199254740993";
/** Its neighbours — distinct generations that a rounded number can no longer tell apart. */
const BIG_PREV = "9007199254740992";
const BIG_NEXT = "9007199254740994";
/** Counter position from which the fake provider's NEXT generation is BIG. */
const BEFORE_BIG = 9007199254740992n;
const CANONICAL = /^[1-9]\d*$/;

type MutableStorageConfig = { driver: string; bucketId: string; privateObjectDir: string; legacyFallback: boolean; mirror: boolean; legacyDelete: boolean; pendingTtlMs: number };
const os = config.objectStorage as unknown as MutableStorageConfig;
const original = { ...os };
const H = 60 * 60 * 1000;
const OPTS = { contentType: "application/octet-stream", maxBytes: 4096 } as const;

const companies: number[] = [];
let store: FakeBucketStore;
let gcsDriver: GcsStorageDriver;
let memoryPrimary: MemoryStorageDriver;
const objectName = (key: string) => key.replace(/^gs:\/\/fake-bucket\//, "");
const received = (name?: string) => store.deleteCalls.filter((c) => name === undefined || c.name === name).map((c) => c.opts?.ifGenerationMatch);

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
/** The activation statement rejects BEFORE committing: the attempt is rolled back (fence first, then discardCopies). */
function rejectActivationOnce() {
  vi.mocked(repo.transition).mockImplementationOnce(async () => {
    throw Object.assign(new Error("connection terminated unexpectedly"), { code: "08006" });
  });
}
async function newCompany(label: string): Promise<number> {
  const [c] = await db.insert(companiesTable).values({ name: `B25C7 ${label} ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  companies.push(c.id);
  return c.id;
}
async function rowsOf(companyId: number) {
  return db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, companyId));
}

beforeAll(async () => {
  os.bucketId = "fake-bucket";
  os.privateObjectDir = "/fake-bucket/.private";
  os.legacyFallback = false;
  os.legacyDelete = true; // automated bucket deletes are allowed — the dangerous configuration
  os.pendingTtlMs = 0;
});
afterAll(async () => {
  Object.assign(os, original);
  __resetStorageRegistryForTests();
  if (companies.length) {
    await db.delete(storageObjectsTable).where(inArray(storageObjectsTable.companyId, companies));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companies));
  }
});
beforeEach(() => {
  __resetStorageRegistryForTests();
  store = new FakeBucketStore();
  gcsDriver = new GcsStorageDriver(fakeGcsClient(store), "fake-bucket");
  memoryPrimary = new MemoryStorageDriver();
  vi.mocked(repo.transition).mockReset().mockImplementation(actualRepo.transition);
  useGcsPrimary();
});
afterEach(() => {
  // suite-wide invariant: every provider delete carries the generation as an exact canonical decimal STRING
  for (const c of store.deleteCalls) {
    const g = c.opts?.ifGenerationMatch;
    expect(typeof g, `provider delete of ${c.name} received a ${typeof g} generation (${String(g)}) instead of the exact string`).toBe("string");
    expect(g as string).toMatch(CANONICAL);
  }
});

describe("0. premise", () => {
  it("the generation used here is a valid decimal that JavaScript cannot represent as a number", () => {
    expect(BIG).toMatch(CANONICAL);
    expect(Number.isSafeInteger(Number(BIG))).toBe(false);
    expect(String(Number(BIG))).toBe(BIG_PREV); // rounded to the even neighbour
    expect(String(Number(BIG))).not.toBe(BIG);
    expect(BigInt(BIG) - BigInt(BIG_PREV)).toBe(1n);
    expect(BigInt(BIG_NEXT) - BigInt(BIG)).toBe(1n);
  });
});

describe("A. GcsStorageDriver.delete passes the exact generation string to the SDK", () => {
  const key = () => `tenants/7/documents/${randomUUID()}`;

  it("1. an object at generation 9007199254740993 is deleted with EXACTLY that string (not the rounded number)", async () => {
    const k = key();
    store.seed(k, Buffer.from("ours"), "application/octet-stream", {}, BIG);
    expect(store.objects.get(k)!.generation).toBe(BIG);
    const outcome = await gcsDriver.delete(k, { ifGeneration: BIG }).catch((e) => e);
    expect(store.deleteCalls).toHaveLength(1);
    const sent = store.deleteCalls[0].opts?.ifGenerationMatch;
    const evidence = `SDK received ${typeof sent} ${String(sent)}; driver outcome=${outcome instanceof StorageError ? `${outcome.code}/${outcome.reason}` : outcome === undefined ? "deleted" : String(outcome)}; object still present=${store.objects.has(k)}`;
    expect(sent, evidence).toBe(BIG);
    expect(typeof sent, evidence).toBe("string");
    expect(outcome, evidence).toBeUndefined();
    expect(store.objects.has(k), evidence).toBe(false);
  });

  it("2. adjacent generations are distinct: a delete fenced at …993 never removes …992 or …994, and each neighbour is removed only by its own exact string", async () => {
    const prev = key();
    const ours = key();
    const next = key();
    store.seed(prev, Buffer.from("older neighbour"), "application/octet-stream", {}, BIG_PREV);
    store.seed(ours, Buffer.from("ours"), "application/octet-stream", {}, BIG);
    store.seed(next, Buffer.from("newer neighbour"), "application/octet-stream", {}, BIG_NEXT);

    // the precondition proven for …993 must not match the object at …992 (a rounded number would)
    const atPrev = await gcsDriver.delete(prev, { ifGeneration: BIG }).catch((e) => e);
    expect(store.objects.has(prev), `a delete fenced at ${BIG} removed the object at generation ${BIG_PREV} (SDK received ${String(received(prev)[0])})`).toBe(true);
    expect(atPrev).toBeInstanceOf(StorageError);
    expect((atPrev as StorageError).reason).toBe("GENERATION_MISMATCH");
    expect(received(prev)).toEqual([BIG]);
    // nor the object at …994
    await expect(gcsDriver.delete(next, { ifGeneration: BIG })).rejects.toMatchObject({ code: "STORAGE_CONFLICT", reason: "GENERATION_MISMATCH" });
    expect(store.objects.has(next)).toBe(true);
    // and the neighbours' generations do not remove ours
    await expect(gcsDriver.delete(ours, { ifGeneration: BIG_PREV })).rejects.toMatchObject({ reason: "GENERATION_MISMATCH" });
    await expect(gcsDriver.delete(ours, { ifGeneration: BIG_NEXT })).rejects.toMatchObject({ reason: "GENERATION_MISMATCH" });
    expect(store.objects.get(ours)!.generation).toBe(BIG);
    // each object goes only with its own exact string
    await gcsDriver.delete(prev, { ifGeneration: BIG_PREV });
    await gcsDriver.delete(ours, { ifGeneration: BIG });
    await gcsDriver.delete(next, { ifGeneration: BIG_NEXT });
    expect(store.objects.size).toBe(0);
    expect(received()).toEqual([BIG, BIG, BIG_PREV, BIG_NEXT, BIG_PREV, BIG, BIG_NEXT]);
  });

  it("3. a delete without a generation fails GENERATION_REQUIRED before the SDK is contacted", async () => {
    const k = key();
    store.seed(k, Buffer.from("x"), "application/octet-stream", {}, BIG);
    await expect(gcsDriver.delete(k)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", reason: "GENERATION_REQUIRED" });
    await expect(gcsDriver.delete(k, {})).rejects.toMatchObject({ reason: "GENERATION_REQUIRED" });
    await expect(gcsDriver.delete(`gs://fake-bucket/${k}`, { ifGeneration: undefined })).rejects.toMatchObject({ reason: "GENERATION_REQUIRED" });
    expect(store.deleteCalls).toEqual([]);
    expect(store.objects.has(k)).toBe(true);
  });

  it("4. a wrong generation is a provider precondition failure (412) reported as GENERATION_MISMATCH; the object survives", async () => {
    const k = key();
    store.seed(k, Buffer.from("x"), "application/octet-stream", {}, "41");
    await expect(gcsDriver.delete(k, { ifGeneration: "40" })).rejects.toMatchObject({ code: "STORAGE_CONFLICT", reason: "GENERATION_MISMATCH" });
    await expect(gcsDriver.delete(k, { ifGeneration: "410" })).rejects.toMatchObject({ reason: "GENERATION_MISMATCH" });
    expect(store.objects.get(k)!.generation).toBe("41");
    expect(received(k)).toEqual(["40", "410"]);
    await gcsDriver.delete(k, { ifGeneration: "41" });
    expect(store.objects.has(k)).toBe(false);
  });

  it("5. a generation that is not a canonical decimal string fails closed (GENERATION_INVALID, fixed message) before the SDK; a number is refused too", async () => {
    const k = key();
    store.seed(k, Buffer.from("x"), "application/octet-stream", {}, BIG);
    const invalid = ["", " ", "0", "007", "-1", "1.0", "1e3", "12abc", " 1", "1 ", `${BIG}\n`, "0x10", "9007199254740993.0", "NaN", "Infinity"];
    for (const g of invalid) {
      const thrown = await gcsDriver.delete(k, { ifGeneration: g }).catch((e) => e);
      expect(thrown, JSON.stringify(g)).toBeInstanceOf(StorageError);
      expect((thrown as StorageError).reason, JSON.stringify(g)).toBe("GENERATION_INVALID");
      expect((thrown as StorageError).message).toBe("a GCS delete requires a canonical decimal generation string");
    }
    for (const notAString of [9007199254740993, 1, 0, 1n, null, {}, [], true]) {
      const thrown = await gcsDriver.delete(k, { ifGeneration: notAString as unknown as string }).catch((e) => e);
      expect(thrown, String(notAString)).toBeInstanceOf(StorageError);
      expect((thrown as StorageError).reason, String(notAString)).toBe("GENERATION_INVALID");
    }
    expect(store.deleteCalls, "an invalid generation reached the SDK").toEqual([]);
    expect(store.objects.get(k)!.generation).toBe(BIG);
  });

  it("6. an absent object is a no-op at the provider (ignoreNotFound) and still carries the exact string", async () => {
    const k = key();
    await gcsDriver.delete(k, { ifGeneration: BIG });
    expect(store.deleteCalls).toEqual([{ name: k, opts: { ignoreNotFound: true, ifGenerationMatch: BIG } }]);
  });
});

describe("B. the generation stays an exact string from the provider's metadata to every driver-level cleanup", () => {
  const key = () => `tenants/7/reports/${randomUUID()}`;

  it("7. a normal put reports the stream's generation verbatim; head() reports the same string; an integrity failure removes exactly that generation", async () => {
    store.gen = BEFORE_BIG;
    const k = key();
    const put = await gcsDriver.put(k, randomBytes(300), OPTS);
    expect(put.generation).toBe(BIG);
    expect(typeof put.generation).toBe("string");
    expect(store.objects.get(k)!.generation).toBe(BIG);
    const head = await gcsDriver.head(k);
    expect(head?.generation).toBe(BIG);
    expect(store.deleteCalls).toEqual([]);

    const k2 = key();
    await expect(gcsDriver.put(k2, randomBytes(300), { ...OPTS, expectedSha256: "00".repeat(32) })).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    expect(received(k2)).toEqual([BIG_NEXT]);
    expect(store.objects.has(k2)).toBe(false);
  });

  it("8. a generation recovered through the ownership-proving HEAD is the exact string the provider reports", async () => {
    store.gen = BEFORE_BIG;
    store.failWrite = () => "no-generation";
    const k = key();
    const put = await gcsDriver.put(k, randomBytes(200), { ...OPTS, owner: "row-7" });
    expect(put.generation).toBe(BIG);
    expect(store.objects.get(k)!.metadata["lcp-object-id"]).toBe("row-7");
    await gcsDriver.delete(k, { ifGeneration: put.generation! });
    expect(received(k)).toEqual([BIG]);
    expect(store.objects.has(k)).toBe(false);
  });

  it("9. the health round-trip deletes its probe object at the exact generation its put returned", async () => {
    store.gen = BEFORE_BIG;
    await gcsDriver.roundTripProbe();
    expect(store.deleteCalls).toHaveLength(1);
    expect(store.deleteCalls[0].name).toMatch(/^health\//);
    expect(store.deleteCalls[0].opts?.ifGenerationMatch).toBe(BIG);
    expect([...store.objects.keys()].filter((k) => k.startsWith("health/"))).toEqual([]);
    // recovered through HEAD as well
    store.failWrite = () => "no-generation";
    await gcsDriver.roundTripProbe();
    expect(store.deleteCalls[1].opts?.ifGenerationMatch).toBe(BIG_NEXT);
    expect([...store.objects.keys()].filter((k) => k.startsWith("health/"))).toEqual([]);
  });

  it("10. a provider that reports an unsafe generation as a NUMBER is not trusted: the put recovers the exact string by HEAD instead of rounding", async () => {
    // the SDK types FileMetadata.generation as string | number; a numeric value above the safe range has already lost
    // information, so the driver must never stringify it — it recovers the exact value from the provider's HEAD
    store.gen = BEFORE_BIG;
    const k = key();
    const client = fakeGcsClient(store);
    const bucket = client.bucket("fake-bucket");
    const numeric = new GcsStorageDriver(
      {
        bucket: () => ({
          ...bucket,
          file: (name: string) => {
            const f = bucket.file(name);
            const original = f.createWriteStream.bind(f);
            f.createWriteStream = ((opts: Parameters<typeof original>[0]) => {
              const ws = original(opts);
              ws.on("finish", () => {
                (f as unknown as { metadata: Record<string, unknown> }).metadata.generation = Number(BIG); // 9007199254740992
              });
              return ws;
            }) as typeof original;
            return f;
          },
        }),
      } as unknown as ConstructorParameters<typeof GcsStorageDriver>[0],
      "fake-bucket",
    );
    const put = await numeric.put(k, randomBytes(100), { ...OPTS, owner: "row-10" });
    expect(put.generation).toBe(BIG);
    await numeric.delete(k, { ifGeneration: put.generation! });
    expect(received(k)).toEqual([BIG]);
    expect(store.objects.has(k)).toBe(false);
  });
});

describe("C. service-level cleanup carries the exact string through WriteAttempt, rollback, removeCopy and the sweep", () => {
  it("11. primary rollback (activation rejected before commit) deletes the primary copy at exactly the large generation", async () => {
    const cid = await newCompany("C-primary");
    store.gen = BEFORE_BIG;
    rejectActivationOnce();
    await expect(storage.storeBuffer({ companyId: cid, kind: "report", contentType: "application/pdf", buffer: Buffer.from("report") })).rejects.toBeInstanceOf(StorageError);
    const [row] = await rowsOf(cid);
    expect(row.state).toBe("failed");
    const name = objectName(row.storageKey);
    expect(received(name)).toEqual([BIG]);
    expect(store.objects.has(name)).toBe(false);
  });

  it("12. strict-mirror rollback deletes the mirror copy at exactly the large generation", async () => {
    useMemoryPrimaryWithGcsMirror();
    const cid = await newCompany("C-mirror");
    store.gen = BEFORE_BIG;
    rejectActivationOnce();
    await expect(storage.storeBuffer({ companyId: cid, kind: "export", contentType: "text/csv", buffer: Buffer.from("a,b") })).rejects.toBeInstanceOf(StorageError);
    const [row] = await rowsOf(cid);
    expect(row.state).toBe("failed");
    const name = objectName(row.mirrorKey!);
    expect(received(name)).toEqual([BIG]);
    expect(store.objects.has(name)).toBe(false);
    expect(memoryPrimary.objects.has(row.storageKey)).toBe(false);
  });

  it("13. removeCopy (delete by reference after a restart) deletes at the exact generation the ownership-proving HEAD observed; a foreign object at the key survives", async () => {
    const cid = await newCompany("C-remove");
    store.gen = BEFORE_BIG;
    const stored = await storage.storeBuffer({ companyId: cid, kind: "report", contentType: "application/pdf", buffer: Buffer.from("ours") });
    const row = (await repo.findById(stored.objectId))!;
    const name = objectName(row.storageKey);
    expect(store.objects.get(name)!.generation).toBe(BIG);
    __resetStorageRegistryForTests(); // "restart": nothing in memory but the database
    useGcsPrimary();
    await storage.deleteByReference({ companyId: cid, kind: "report", reference: stored.reference });
    expect(received(name)).toEqual([BIG]);
    expect(store.objects.has(name)).toBe(false);
    expect((await repo.findById(stored.objectId))!.state).toBe("deleted");

    // the same key re-written by someone else at the next generation (no marker): HEAD disproves ownership, nothing is sent
    const second = await storage.storeBuffer({ companyId: cid, kind: "report", contentType: "application/pdf", buffer: Buffer.from("ours too") });
    const row2 = (await repo.findById(second.objectId))!;
    const name2 = objectName(row2.storageKey);
    const foreign = store.seed(name2, Buffer.from("foreign newer generation"));
    expect(foreign.generation).toBe("9007199254740995");
    await storage.deleteByReference({ companyId: cid, kind: "report", reference: second.reference });
    await storage.sweepStorage(new Date(Date.now() + 2 * H));
    expect(store.objects.get(name2)!.generation).toBe(foreign.generation);
    expect(received(name2)).toEqual([]);
    expect((await repo.findById(second.objectId))!.lastError).toBe("OWNERSHIP_UNPROVEN");
  });

  it("14. a generation that changes between the proving HEAD and the DELETE is a mismatch: the newer neighbour survives and the row is re-examined", async () => {
    const cid = await newCompany("C-race");
    store.gen = BEFORE_BIG;
    const stored = await storage.storeBuffer({ companyId: cid, kind: "export", contentType: "text/csv", buffer: Buffer.from("x,y") });
    const row = (await repo.findById(stored.objectId))!;
    const name = objectName(row.storageKey);
    const realHead = gcsDriver.head.bind(gcsDriver);
    vi.spyOn(gcsDriver, "head").mockImplementationOnce(async (key) => {
      const h = await realHead(key); // observes OUR marker at …993 …
      store.seed(name, Buffer.from("replaced right after the HEAD")); // … then an unrelated writer commits …994
      return h;
    });
    await storage.deleteByReference({ companyId: cid, kind: "export", reference: stored.reference });
    expect(received(name)).toEqual([BIG]); // fenced at the observed generation …
    expect(store.objects.get(name)!.generation).toBe(BIG_NEXT); // … so the neighbour survives
    const after = (await repo.findById(stored.objectId))!;
    expect(after.state).toBe("deleting"); // not settled: re-examined by the durable retry / sweep, never a bare delete
    expect(after.lastError).toBe("DELETE_RETRY");
  });

  it("15. the sweep removes a late provider commit at the exact generation the HEAD reported (uncertain tombstone re-check)", async () => {
    const cid = await newCompany("C-late");
    store.gen = BEFORE_BIG;
    store.failWrite = () => "late-commit";
    await expect(storage.storeBuffer({ companyId: cid, kind: "report", contentType: "application/pdf", buffer: Buffer.from("late") })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    store.failWrite = () => null;
    const [failed] = await rowsOf(cid);
    expect(failed.state).toBe("failed");
    expect(failed.publicationUncertainAt).toBeInstanceOf(Date);
    const name = objectName(failed.storageKey);
    expect(store.deleteCalls).toEqual([]);
    const committed = store.commitPending(name);
    expect(committed.generation).toBe(BIG);
    await storage.sweepStorage(new Date(Date.now() + 2 * H));
    expect(store.objects.has(name)).toBe(false);
    expect(received(name)).toEqual([BIG]);
  });

  it("16. the sweep's generation-recovery after a generationless put deletes at the exact string too", async () => {
    const cid = await newCompany("C-head-fails");
    store.gen = BEFORE_BIG;
    store.failWrite = () => "no-generation";
    store.failHead = () => Object.assign(new Error("metadata unavailable"), { code: 503 });
    await expect(storage.storeBuffer({ companyId: cid, kind: "report", contentType: "application/pdf", buffer: Buffer.from("unproven") })).rejects.toBeInstanceOf(StorageError);
    expect(store.deleteCalls).toEqual([]);
    const [row] = await rowsOf(cid);
    expect(row.state).toBe("failed");
    const name = objectName(row.storageKey);
    expect(store.objects.get(name)!.generation).toBe(BIG);
    store.failHead = () => null;
    await storage.sweepStorage(new Date(Date.now() + 2 * H));
    expect(store.objects.has(name)).toBe(false);
    expect(received(name)).toEqual([BIG]);
  });
});

describe("D. migration mismatch cleanup against a provider target", () => {
  const LIMITS: Record<StorageKind, number> = { document: 1 << 20, export: 1 << 20, report: 1 << 20, scan_image: 1 << 20, branding_logo: 1 << 20 };

  function memoryInventory() {
    const rows = new Map<string, StorageObjectRow>();
    const adapter: InventoryAdapter = {
      async findByReference(companyId, kind, reference) {
        return [...rows.values()].find((r) => r.companyId === companyId && r.kind === kind && r.reference === reference) ?? null;
      },
      async register(c, { id, storageKey }) {
        const now = new Date();
        const row: StorageObjectRow = {
          id,
          companyId: c.companyId,
          kind: c.kind,
          entityType: c.entityType,
          entityId: c.entityId,
          reference: c.reference,
          storageKey,
          driver: "gcs",
          legacyKey: c.legacyKey,
          contentType: c.contentType ?? "application/octet-stream",
          sizeBytes: null,
          sha256: null,
          state: "active",
          mirrorState: null,
          mirrorKey: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        } as StorageObjectRow;
        rows.set(id, row);
        return row;
      },
      async listPending(afterId, limit) {
        return [...rows.values()]
          .filter((r) => r.state === "active" && r.legacyKey)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .filter((r) => !afterId || r.id > afterId)
          .slice(0, limit);
      },
      async update(id, patch: Partial<InsertStorageObject>) {
        Object.assign(rows.get(id)!, patch);
      },
    };
    return { rows, adapter };
  }

  it("17. a checksum mismatch removes the unverified provider copy at exactly the generation its put returned", async () => {
    store.gen = BEFORE_BIG;
    const source = new MemoryStorageDriver({ looseKeys: true });
    const uploadId = randomUUID();
    const legacyKey = `gs://dev-bucket/.private/uploads/${uploadId}`;
    await source.put(legacyKey, randomBytes(1200), { contentType: "application/pdf", maxBytes: LIMITS.document });
    const candidates: MigrationCandidate[] = [{ companyId: 1, kind: "document", entityType: "document_version", entityId: 100, reference: `/objects/uploads/${uploadId}`, legacyKey, contentType: "application/pdf" }];
    const realHead = source.head.bind(source);
    vi.spyOn(source, "head").mockImplementation(async (key) => {
      const h = await realHead(key);
      return h ? { ...h, sizeBytes: (h.sizeBytes ?? 0) + 1 } : null;
    });
    const inv = memoryInventory();
    const s = await runMigration({ mode: "copy", source, target: gcsDriver, inventory: inv.adapter, discover: async () => ({ candidates, unattributable: 0 }), limits: LIMITS, concurrency: 1, batchSize: 1 });
    expect(s.counts.checksum_mismatch).toBe(1);
    const [row] = [...inv.rows.values()];
    expect(row.driver).toBe("gcs"); // not adopted
    expect(received(row.storageKey)).toEqual([BIG]);
    expect(store.objects.has(row.storageKey)).toBe(false);
  });
});
