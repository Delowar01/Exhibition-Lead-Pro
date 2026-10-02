// B25 Correction 6 — NO GENERATIONLESS GCS DELETE. `PutResult.generation` is
// optional in the storage contract and a successful GCS put used to be accepted
// without one; `discardCopies()` then rolled such a copy back with a BARE
// provider delete (no ifGenerationMatch), the public `GcsStorageDriver.delete`
// permitted a call without a generation, and the health round-trip removed its
// object unconditionally. Any newer or foreign object at the key could be
// deleted. After this correction every provider delete carries the exact
// observed generation, a put whose stream reports no generation recovers it
// through a HEAD that also proves the ownership marker, and a put that cannot
// prove both fails closed (fixed sanitized error, nothing deleted, the row stays
// provider-uncertain for the sweep).
// The REAL GcsStorageDriver runs over the fake SDK whose "no-generation" mode
// commits the very request the client issued but exposes no generation on the
// write stream's metadata — never an object written around the driver.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, storageObjectsTable, companiesTable } from "@workspace/db";
import { config } from "../src/config.js";
import { GcsStorageDriver } from "../src/storage/gcs-driver.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { StorageError } from "../src/storage/contract.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as storage from "../src/services/storage.service.js";
import { FakeBucketStore, fakeGcsClient } from "./helpers/fake-gcs-sdk.js";

vi.mock("../src/repositories/storage-objects.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/storage-objects.repository.js")>();
  return { ...actual, transition: vi.fn(actual.transition) };
});
type Repo = typeof import("../src/repositories/storage-objects.repository.js");
const actualRepo = await vi.importActual<Repo>("../src/repositories/storage-objects.repository.js");

type MutableStorageConfig = { driver: string; bucketId: string; privateObjectDir: string; legacyFallback: boolean; mirror: boolean; legacyDelete: boolean; pendingTtlMs: number };
const os = config.objectStorage as unknown as MutableStorageConfig;
const original = { ...os };
const H = 60 * 60 * 1000;

const companies: number[] = [];
let COMPANY = 0;
let store: FakeBucketStore;
let gcsDriver: GcsStorageDriver;
let memoryPrimary: MemoryStorageDriver;
const objectName = (key: string) => key.replace(/^gs:\/\/fake-bucket\//, "");
const unconditional = () => store.deleteCalls.filter((c) => c.opts?.ifGenerationMatch === undefined);
const expectEveryDeleteFenced = () => expect(unconditional(), `provider deletes without ifGenerationMatch: ${JSON.stringify(unconditional())}`).toEqual([]);

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
  const [c] = await db.insert(companiesTable).values({ name: `B25C6 ${label} ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
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
  COMPANY = await newCompany("generation");
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
  store = new FakeBucketStore();
  gcsDriver = new GcsStorageDriver(fakeGcsClient(store), "fake-bucket");
  memoryPrimary = new MemoryStorageDriver();
  vi.mocked(repo.transition).mockReset().mockImplementation(actualRepo.transition);
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  useGcsPrimary();
});
afterEach(() => {
  // the suite-wide invariant: no provider delete recorded anywhere lacks the precondition
  expectEveryDeleteFenced();
});

describe("A. the public driver surface", () => {
  it("1. GcsStorageDriver.delete without a generation fails BEFORE the SDK is called", async () => {
    const name = `tenants/${COMPANY}/documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    store.seed(name, Buffer.from("someone's object"));
    const thrown = await gcsDriver.delete(name).catch((e) => e);
    expect(store.deleteCalls, "the SDK delete was invoked without ifGenerationMatch").toEqual([]);
    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).reason).toBe("GENERATION_REQUIRED");
    expect(store.objects.has(name)).toBe(true);
  });

  it("2. the health round-trip removes its object only at the generation its put returned; without one it retains the object and reports failure", async () => {
    await gcsDriver.roundTripProbe();
    expect(store.deleteCalls).toHaveLength(1);
    expect(store.deleteCalls[0].name).toMatch(/^health\//);
    expect(store.deleteCalls[0].opts?.ifGenerationMatch, "health cleanup issued a bare delete").toBeDefined();
    expect([...store.objects.keys()].filter((k) => k.startsWith("health/"))).toEqual([]);

    // the stream reports no generation and the recovering HEAD cannot run: the put fails closed BEFORE the read,
    // the health object is retained for explicit health-namespace cleanup and no bare delete is issued
    store.failWrite = () => "no-generation";
    store.failHead = (n) => (n.startsWith("health/") ? Object.assign(new Error("metadata unavailable"), { code: 503 }) : null);
    const thrown = await gcsDriver.roundTripProbe().catch((e) => e);
    expect(store.deleteCalls, "a second (bare) delete was issued for the generationless health object").toHaveLength(1);
    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).reason).toBe("GENERATION_UNPROVEN");
    expect([...store.objects.keys()].filter((k) => k.startsWith("health/"))).toHaveLength(1); // retained for explicit health-namespace cleanup
    store.failHead = () => null;
    // with the HEAD available the generation is recovered and the health object is removed at exactly that generation
    await gcsDriver.roundTripProbe();
    expect(store.deleteCalls).toHaveLength(2);
    expect(store.deleteCalls[1].opts?.ifGenerationMatch).toBeDefined();
  });
});

describe("B. a put whose stream reports no generation", () => {
  it("3. GCS primary: the generation is recovered through HEAD (ownership marker proven) and a later rollback deletes only that generation", async () => {
    const cid = await newCompany("B-primary");
    store.failWrite = () => "no-generation";
    rejectActivationOnce();
    const thrown = await storage.storeBuffer({ companyId: cid, kind: "report", contentType: "application/pdf", buffer: Buffer.from("report") }).catch((e) => e);
    expect(thrown).toBeInstanceOf(StorageError);
    const [row] = await rowsOf(cid);
    expect(row.state).toBe("failed");
    const name = objectName(row.storageKey);
    const dels = store.deleteCalls.filter((c) => c.name === name);
    expect(dels).toHaveLength(1);
    expect(dels[0].opts?.ifGenerationMatch, "rollback deleted without the observed generation").toBe("1");
    expect(store.objects.has(name)).toBe(false);
  });

  it("4. a newer foreign generation at the key survives the rollback of a generationless put", async () => {
    const cid = await newCompany("B-foreign");
    store.failWrite = () => "no-generation";
    let foreignGeneration = "";
    vi.mocked(repo.transition)
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("connection terminated unexpectedly"), { code: "08006" });
      })
      .mockImplementationOnce(async (id, from, to, data, tx) => {
        // between the rejected activation and the fence, an unrelated writer replaced the object (newer generation, no marker)
        const [r] = await rowsOf(cid);
        foreignGeneration = store.seed(objectName(r.storageKey), Buffer.from("newer unrelated object")).generation;
        return actualRepo.transition(id, from, to, data, tx);
      });
    await expect(storage.storeBuffer({ companyId: cid, kind: "export", contentType: "text/csv", buffer: Buffer.from("a,b") })).rejects.toBeInstanceOf(StorageError);
    const [row] = await rowsOf(cid);
    const name = objectName(row.storageKey);
    expect(store.objects.get(name)?.generation, "the unrelated newer object was deleted").toBe(foreignGeneration);
    expect(unconditional()).toEqual([]);
    await storage.sweepStorage(new Date(Date.now() + 2 * H)); // the sweep re-checks: foreign object → unproven, never deleted
    expect(store.objects.get(name)?.generation).toBe(foreignGeneration);
  });

  it("5. strict mirror: a generationless mirror put is recovered the same way; the rollback deletes the mirror copy only at its generation", async () => {
    useMemoryPrimaryWithGcsMirror();
    const cid = await newCompany("B-mirror");
    store.failWrite = () => "no-generation";
    rejectActivationOnce();
    await expect(storage.storeBuffer({ companyId: cid, kind: "report", contentType: "application/pdf", buffer: Buffer.from("mirrored") })).rejects.toBeInstanceOf(StorageError);
    const [row] = await rowsOf(cid);
    expect(row.state).toBe("failed");
    const name = objectName(row.mirrorKey!);
    const dels = store.deleteCalls.filter((c) => c.name === name);
    expect(dels).toHaveLength(1);
    expect(dels[0].opts?.ifGenerationMatch, "mirror rollback deleted without the observed generation").toBe("1");
    expect(store.objects.has(name)).toBe(false);
    expect(memoryPrimary.objects.has(row.storageKey)).toBe(false);
  });

  it("6. no generation AND the recovering HEAD fails: fixed sanitized failure, nothing deleted, the row stays provider-uncertain; the later sweep deletes by marker + observed generation", async () => {
    const cid = await newCompany("B-head-fails");
    store.failWrite = () => "no-generation";
    store.failHead = () => Object.assign(new Error("metadata fetch failed: https://storage.googleapis.com/secret-bucket/o?X-Goog-Signature=deadbeef"), { code: 503 });
    const thrown = await storage.storeBuffer({ companyId: cid, kind: "report", contentType: "application/pdf", buffer: Buffer.from("unproven") }).catch((e) => e);
    expect(thrown, "a put whose generation and ownership could not be proven was reported as a completed copy").toBeInstanceOf(StorageError);
    expect(JSON.stringify({ message: (thrown as Error).message, stack: (thrown as Error).stack, cause: (thrown as { cause?: unknown }).cause })).not.toContain("secret-bucket");
    expect(store.deleteCalls).toEqual([]);
    const [row] = await rowsOf(cid);
    expect(row.state).toBe("failed");
    expect(row.publicationUncertainAt).toBeInstanceOf(Date);
    const name = objectName(row.storageKey);
    expect(store.objects.has(name)).toBe(true); // the committed object is still there, discoverable through the row
    store.failHead = () => null;
    await storage.sweepStorage(new Date(Date.now() + 2 * H));
    expect(store.objects.has(name)).toBe(false);
    const dels = store.deleteCalls.filter((c) => c.name === name);
    expect(dels).toHaveLength(1);
    expect(dels[0].opts?.ifGenerationMatch).toBe("1");
  });

  it("7. no generation and the HEAD shows another owner's marker: nothing deleted, the row fails closed and the sweep keeps the object as OWNERSHIP_UNPROVEN", async () => {
    const cid = await newCompany("B-owner-mismatch");
    store.failWrite = () => "no-generation";
    let foreignGeneration = "";
    store.afterCommit = (name) => {
      store.afterCommit = undefined;
      foreignGeneration = store.seed(name, Buffer.from("replaced by someone else"), "application/octet-stream", { "lcp-object-id": "another-row" }).generation;
    };
    const thrown = await storage.storeBuffer({ companyId: cid, kind: "export", contentType: "text/csv", buffer: Buffer.from("x") }).catch((e) => e);
    expect(thrown, "an object owned by another row was accepted as this write's copy").toBeInstanceOf(StorageError);
    expect(store.deleteCalls).toEqual([]);
    const [row] = await rowsOf(cid);
    expect(row.state).toBe("failed");
    const name = objectName(row.storageKey);
    for (const dt of [2 * H, 25 * H]) await storage.sweepStorage(new Date(Date.now() + dt));
    expect(store.objects.get(name)?.generation).toBe(foreignGeneration);
    expect(store.deleteCalls).toEqual([]);
    expect((await rowsOf(cid))[0].lastError).toBe("OWNERSHIP_UNPROVEN");
  });

  it("8. a normal put still returns the stream's generation without an extra HEAD and a rollback deletes exactly it", async () => {
    const cid = await newCompany("B-normal");
    rejectActivationOnce();
    await expect(storage.storeBuffer({ companyId: cid, kind: "report", contentType: "application/pdf", buffer: Buffer.from("normal") })).rejects.toBeInstanceOf(StorageError);
    const [row] = await rowsOf(cid);
    const name = objectName(row.storageKey);
    expect(store.deleteCalls.filter((c) => c.name === name).map((c) => c.opts?.ifGenerationMatch)).toEqual(["1"]);
  });
});
