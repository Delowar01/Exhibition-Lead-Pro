// B25 Correction 2 — generation-safe GCS writes and cleanup.
//   • the REAL GcsStorageDriver against a deterministic fake of the Google SDK
//     surface it uses (bucket/file: createWriteStream with preconditionOpts,
//     delete with ifGenerationMatch, getMetadata, exists, createReadStream)
//     that models object generations:
//       – a failing no-overwrite upload (412, transport failure, failure after
//         the server committed) never deletes a pre-existing or concurrently
//         committed object by key
//       – a successful put reports its generation; cleanup after an integrity
//         failure removes ONLY that generation
//       – delete(key, { ifGeneration }) with a stale generation leaves the
//         committed object untouched
//   • the fake in-memory GCS adapter (memory driver, kind "gcs") models the same
//     ownership rules for the service-level fault-injection tests:
//       – successful attempt + later database failure → only that generation goes
//       – a stale cleanup cannot remove the committed mirror generation
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { db, storageObjectsTable } from "@workspace/db";
import type { Storage } from "@google-cloud/storage";
import { config } from "../src/config.js";
import { GcsStorageDriver } from "../src/storage/gcs-driver.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { StorageError, readAll } from "../src/storage/contract.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as storage from "../src/services/storage.service.js";

vi.mock("../src/repositories/storage-objects.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/storage-objects.repository.js")>();
  return { ...actual, transition: vi.fn(actual.transition) };
});

function sha(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

// ── deterministic fake of the Google SDK surface ────────────────────────────
type FailMode = "transport" | "after-commit" | null;
class FakeBucketStore {
  objects = new Map<string, { bytes: Buffer; generation: number; contentType: string }>();
  gen = 0;
  deleteCalls: Array<{ name: string; opts: Record<string, unknown> | undefined }> = [];
  failWrite: (name: string) => FailMode = () => null;
}
function apiError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}
class FakeFile {
  metadata: Record<string, unknown> = {};
  constructor(
    private readonly store: FakeBucketStore,
    readonly name: string,
  ) {}
  createWriteStream(opts: { contentType?: string; preconditionOpts?: { ifGenerationMatch?: number } }) {
    const chunks: Buffer[] = [];
    const store = this.store;
    const name = this.name;
    const self = this;
    return new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        const mode = store.failWrite(name);
        if (mode === "transport") return cb(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
        const existing = store.objects.get(name);
        if (opts?.preconditionOpts?.ifGenerationMatch === 0 && existing) return cb(apiError(412, "Precondition Failed"));
        const generation = ++store.gen;
        store.objects.set(name, { bytes: Buffer.concat(chunks), generation, contentType: opts?.contentType ?? "application/octet-stream" });
        self.metadata = { generation: String(generation), size: String(Buffer.concat(chunks).length) };
        if (mode === "after-commit") return cb(Object.assign(new Error("response lost after commit"), { code: "ECONNRESET" }));
        cb();
      },
    });
  }
  async delete(opts?: { ignoreNotFound?: boolean; ifGenerationMatch?: number | string }) {
    this.store.deleteCalls.push({ name: this.name, opts });
    const o = this.store.objects.get(this.name);
    if (!o) {
      if (opts?.ignoreNotFound) return;
      throw apiError(404, "Not Found");
    }
    if (opts?.ifGenerationMatch !== undefined && Number(opts.ifGenerationMatch) !== o.generation) throw apiError(412, "Precondition Failed");
    this.store.objects.delete(this.name);
  }
  async getMetadata() {
    const o = this.store.objects.get(this.name);
    if (!o) throw apiError(404, "Not Found");
    return [{ size: String(o.bytes.length), contentType: o.contentType, generation: String(o.generation) }];
  }
  async exists() {
    return [this.store.objects.has(this.name)];
  }
  createReadStream() {
    const o = this.store.objects.get(this.name);
    return Readable.from(o ? [Buffer.from(o.bytes)] : []);
  }
}
function fakeClient(store: FakeBucketStore): Storage {
  return {
    bucket: () => ({ file: (name: string) => new FakeFile(store, name), getFiles: async () => [[]] }),
  } as unknown as Storage;
}
function failingSource(prefix: Buffer): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(prefix);
        this.destroy(Object.assign(new Error("client disconnected"), { code: "ECONNRESET" }));
      }
    },
  });
}

describe("5. real GCS driver over a generation-aware fake SDK", () => {
  const key = (suffix = randomUUID()) => `tenants/1/documents/${suffix}`;

  it("an existing object survives a failing no-overwrite upload: precondition failure, transport failure, source-stream failure", async () => {
    const store = new FakeBucketStore();
    const driver = new GcsStorageDriver(fakeClient(store), "fake-bucket");
    const k = key();
    const existing = randomBytes(1000);
    await driver.put(k, existing, { contentType: "application/octet-stream", maxBytes: 4096 });
    expect(store.objects.get(k)!.generation).toBe(1);

    // 412: the object must not exist at commit time
    await expect(driver.put(k, randomBytes(1000), { contentType: "application/octet-stream", maxBytes: 4096 })).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
    // transport failure while finalizing
    store.failWrite = (n) => (n === k ? "transport" : null);
    await expect(driver.put(k, randomBytes(1000), { contentType: "application/octet-stream", maxBytes: 4096 })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    store.failWrite = () => null;
    // the client's own source stream dies mid-upload
    await expect(driver.put(k, failingSource(randomBytes(100)), { contentType: "application/octet-stream", maxBytes: 4096 })).rejects.toBeInstanceOf(Error);

    expect(store.objects.get(k)!.bytes.equals(existing)).toBe(true);
    expect(store.objects.get(k)!.generation).toBe(1);
    expect(store.deleteCalls).toEqual([]); // never a delete by key because a write failed
  });

  it("concurrent winner + loser transport failure → the winner is unchanged", async () => {
    const store = new FakeBucketStore();
    const driver = new GcsStorageDriver(fakeClient(store), "fake-bucket");
    const k = key();
    const winner = randomBytes(1200);
    let calls = 0;
    store.failWrite = (n) => (n === k && ++calls === 2 ? "transport" : null); // the second finalizer loses its connection
    const [a, b] = await Promise.allSettled([
      driver.put(k, winner, { contentType: "application/octet-stream", maxBytes: 4096 }),
      driver.put(k, randomBytes(1200), { contentType: "application/octet-stream", maxBytes: 4096 }),
    ]);
    expect([a.status, b.status].filter((s) => s === "fulfilled")).toHaveLength(1);
    expect(store.objects.get(k)!.bytes.equals(winner)).toBe(true);
    expect(store.deleteCalls).toEqual([]);
  });

  it("a failure AFTER the server committed never deletes by key (ownership unproven) — the row-owned key is settled by the inventory, not the driver", async () => {
    const store = new FakeBucketStore();
    const driver = new GcsStorageDriver(fakeClient(store), "fake-bucket");
    const k = key();
    store.failWrite = (n) => (n === k ? "after-commit" : null);
    await expect(driver.put(k, randomBytes(500), { contentType: "application/octet-stream", maxBytes: 4096 })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(store.objects.has(k)).toBe(true);
    expect(store.deleteCalls).toEqual([]);
  });

  it("a successful put reports its generation; an integrity failure removes ONLY that generation", async () => {
    const store = new FakeBucketStore();
    const driver = new GcsStorageDriver(fakeClient(store), "fake-bucket");
    const k = key();
    const bytes = randomBytes(700);
    const ok = await driver.put(k, bytes, { contentType: "application/octet-stream", maxBytes: 4096 });
    expect(ok.sha256).toBe(sha(bytes));
    expect(ok.generation).toBe("1");

    const k2 = key();
    await expect(driver.put(k2, bytes, { contentType: "application/octet-stream", maxBytes: 4096, expectedSha256: "00".repeat(32) })).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    expect(store.objects.has(k2)).toBe(false);
    const cleanup = store.deleteCalls.filter((c) => c.name === k2);
    expect(cleanup).toHaveLength(1);
    expect(Number(cleanup[0].opts?.ifGenerationMatch)).toBe(2); // exactly the generation this write created
  });

  it("delete(key, { ifGeneration }) with a stale generation leaves the committed object untouched", async () => {
    const store = new FakeBucketStore();
    const driver = new GcsStorageDriver(fakeClient(store), "fake-bucket");
    const k = key();
    const first = await driver.put(k, randomBytes(300), { contentType: "application/octet-stream", maxBytes: 4096 });
    const committed = randomBytes(300);
    const second = await driver.put(k, committed, { contentType: "application/octet-stream", maxBytes: 4096, allowOverwrite: true });
    expect(first.generation).toBe("1");
    expect(second.generation).toBe("2");
    await expect(driver.delete(k, { ifGeneration: first.generation })).rejects.toMatchObject({ code: "STORAGE_CONFLICT", reason: "GENERATION_MISMATCH" });
    expect(store.objects.get(k)!.bytes.equals(committed)).toBe(true);
    await driver.delete(k, { ifGeneration: second.generation });
    expect(store.objects.has(k)).toBe(false);
    expect((await readAll((await driver.getStream(k).catch((e: StorageError) => ({ stream: Readable.from([]), code: e.code }))).stream, 10)).length).toBe(0);
  });
});

describe("5b. service-level cleanup is generation-safe (fake adapter)", () => {
  const COMPANY = 9_400_000 + Math.floor(Math.random() * 500_000);
  const os = config.objectStorage as unknown as { driver: string; bucketId: string; legacyFallback: boolean; mirror: boolean; legacyDelete: boolean };
  const original = { ...os };
  let primary: MemoryStorageDriver;
  let gcs: MemoryStorageDriver;

  beforeAll(() => {
    os.driver = "memory";
    os.bucketId = "fake-bucket";
    os.legacyFallback = false;
    os.mirror = true;
    os.legacyDelete = false;
  });
  afterAll(async () => {
    Object.assign(os, original);
    __resetStorageRegistryForTests();
    await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  });
  beforeEach(async () => {
    __resetStorageRegistryForTests();
    primary = new MemoryStorageDriver();
    gcs = new MemoryStorageDriver({ looseKeys: true, kind: "gcs" });
    __setDriversForTests({ primary, legacy: gcs });
    vi.mocked(repo.transition).mockReset();
    vi.mocked(repo.transition).mockImplementation(async (...args) => {
      const actual = await vi.importActual<typeof import("../src/repositories/storage-objects.repository.js")>("../src/repositories/storage-objects.repository.js");
      return actual.transition(...args);
    });
    await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  });

  it("successful primary + mirror, then a database failure → exactly the written generations are removed", async () => {
    vi.mocked(repo.transition).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("pdf") })).rejects.toThrow(/database unavailable/);
    expect(primary.objects.size).toBe(0);
    expect(gcs.objects.size).toBe(0);
    const mirrorDeletes = gcs.deleteCalls;
    expect(mirrorDeletes).toHaveLength(1);
    expect(mirrorDeletes[0].ifGeneration).toBe("1"); // the generation the mirror put returned, never a bare key
    expect(primary.deleteCalls).toHaveLength(1);
    expect(primary.deleteCalls[0].ifGeneration).toBe("1");
  });

  it("a stale cleanup cannot remove the committed mirror generation", async () => {
    const mirrorKey = `gs://fake-bucket/tenants/${COMPANY}/reports/${randomUUID()}`;
    const stale = await gcs.put(mirrorKey, Buffer.from("stale attempt"), { contentType: "application/pdf", maxBytes: 100 });
    const committedBytes = Buffer.from("committed attempt");
    const committed = await gcs.put(mirrorKey, committedBytes, { contentType: "application/pdf", maxBytes: 100, allowOverwrite: true });
    expect(stale.generation).not.toBe(committed.generation);
    const attempt: storage.WriteAttempt = { rowId: randomUUID(), copies: [{ driver: gcs, key: mirrorKey, role: "mirror", generation: stale.generation }] };
    const clean = await storage.discardCopies(attempt);
    expect(clean).toBe(true); // nothing of the stale attempt remains — and nothing else was touched
    expect(gcs.objects.get(mirrorKey)!.bytes.equals(committedBytes)).toBe(true);
    expect(gcs.deleteCalls.at(-1)).toMatchObject({ key: mirrorKey, ifGeneration: stale.generation });
  });
});
