// B25 Correction 1 — race-free upload publication.
//   • driver level: two writers for the same key reach the publication point
//     together (deterministic barrier); exactly one wins, the loser gets
//     STORAGE_CONFLICT, never deletes the winner's object, and leaves no temp file
//     — for the filesystem driver (atomic no-replace link) and the fake GCS
//     adapter (generation precondition)
//   • service level: one upload intent, two concurrent PUT bodies → the database
//     lease (CAS) admits exactly one; one staged row, bytes/digest of the winner
//   • crash recovery (B25 Correction 2 model): an expired `uploading` lease is
//     NEVER reclaimed — a PUT on it is refused, the sweep fails the row and
//     removes its leftover copy, and the client reserves a fresh object
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os_ from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { eq, inArray } from "drizzle-orm";
import { db, storageObjectsTable } from "@workspace/db";
import { config } from "../src/config.js";
import { FsStorageDriver } from "../src/storage/fs-driver.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { StorageError, readAll, type StorageDriver } from "../src/storage/contract.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as storage from "../src/services/storage.service.js";
import type { AuthUser } from "../src/middlewares/requireAuth.js";

function sha(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

/** Resolves every caller only once `n` callers have arrived. */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return async () => {
    arrived += 1;
    if (arrived >= n) release();
    await gate;
  };
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

async function raceTwoWriters(driver: StorageDriver, key: string, listTemp: () => string[]) {
  const a = randomBytes(2000);
  const b = randomBytes(2000);
  const [ra, rb] = await Promise.all([
    settle(driver.put(key, a, { contentType: "application/octet-stream", maxBytes: 4096 })),
    settle(driver.put(key, b, { contentType: "application/octet-stream", maxBytes: 4096 })),
  ]);
  const results = [
    { ...ra, bytes: a },
    { ...rb, bytes: b },
  ];
  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  const loserErr = (losers[0] as { error: unknown }).error as StorageError;
  expect(loserErr).toBeInstanceOf(StorageError);
  expect(loserErr.code).toBe("STORAGE_CONFLICT");
  const stored = await readAll((await driver.getStream(key, { maxBytes: 4096 })).stream, 4096);
  expect(stored.equals(winners[0].bytes)).toBe(true);
  expect(sha(stored)).toBe((winners[0] as { value: { sha256: string } }).value.sha256);
  expect(await driver.exists(key)).toBe(true);
  expect(listTemp()).toEqual([]);
}

describe("4. atomic no-replace publication (driver level, barrier-controlled)", () => {
  let base = "";
  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("filesystem driver: exactly one of two simultaneous writers publishes; the loser never removes the winner's object", async () => {
    base = mkdtempSync(path.join(os_.tmpdir(), "lcp-race-"));
    const root = path.join(base, "objects");
    const gate = barrier(2);
    const driver = new FsStorageDriver({ root, key: randomBytes(32), chunkSize: 1024, beforePublish: gate });
    await driver.init();
    const key = `tenants/1/documents/${randomUUID()}`;
    const dir = path.join(root, "tenants", "1", "documents");
    await raceTwoWriters(driver, key, () => readdirSync(dir).filter((n) => n.startsWith(".tmp-")));
  });

  it("fake GCS adapter (generation precondition): same outcome", async () => {
    const gate = barrier(2);
    const driver = new MemoryStorageDriver({ looseKeys: true, kind: "gcs", beforePublish: gate });
    const key = `gs://fake-bucket/tenants/1/documents/${randomUUID()}`;
    await raceTwoWriters(driver, key, () => []);
    expect(driver.objects.size).toBe(1);
  });
});

describe("4b. upload lease (database CAS) and crash recovery", () => {
  const COMPANY = 9_300_000 + Math.floor(Math.random() * 600_000);
  const os = config.objectStorage as unknown as { driver: string; legacyFallback: boolean; mirror: boolean; pendingTtlMs: number; uploadLeaseMs: number };
  const original = { ...os };
  let primary: MemoryStorageDriver;
  const user: AuthUser = { id: 1, email: "u@t", name: "U", role: "primary_admin", companyId: COMPANY, permissions: {}, contactVisibility: "all", companyVisibility: "all", selectedUserIds: [], isActive: true, companyStatus: "active", readOnly: false, accessibleCompanies: [COMPANY], sessionId: null };

  beforeAll(() => {
    os.driver = "memory";
    os.legacyFallback = false;
    os.mirror = false;
  });
  afterAll(async () => {
    Object.assign(os, original);
    __resetStorageRegistryForTests();
    await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  });
  beforeEach(async () => {
    __resetStorageRegistryForTests();
    primary = new MemoryStorageDriver();
    __setDriversForTests({ primary, legacy: null });
    await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  });

  it("one upload intent, two concurrent bodies: exactly one succeeds, the other answers 409, one staged row with the winner's digest", async () => {
    const reserved = await storage.reserveUpload(null, { companyId: COMPANY, userId: user.id, kind: "document", contentType: "text/plain", declaredSize: 2000 });
    const a = randomBytes(1500);
    const b = randomBytes(1500);
    const [ra, rb] = await Promise.all([
      settle(storage.receiveUpload(user, reserved.objectId, reserved.uploadToken, Readable.from([a]))),
      settle(storage.receiveUpload(user, reserved.objectId, reserved.uploadToken, Readable.from([b]))),
    ]);
    const results = [
      { ...ra, bytes: a },
      { ...rb, bytes: b },
    ];
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { error: { statusCode?: number } }).error).toMatchObject({ statusCode: 409 });
    const row = (await repo.findById(reserved.objectId))!;
    expect(row.state).toBe("staged");
    expect(row.sha256).toBe(sha(winners[0].bytes));
    expect(row.leaseToken).toBeNull();
    expect(primary.objects.size).toBe(1);
    expect(primary.objects.get(row.storageKey)!.bytes.equals(winners[0].bytes)).toBe(true);
    // a third attempt after completion is a plain 409 (already completed)
    await expect(storage.receiveUpload(user, reserved.objectId, reserved.uploadToken, Readable.from([a]))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("an expired lease is never reclaimed: the PUT is refused, the sweep removes the leftover unverified file, a fresh reservation succeeds", async () => {
    const reserved = await storage.reserveUpload(null, { companyId: COMPANY, userId: user.id, kind: "document", contentType: "text/plain", declaredSize: 100 });
    const row = (await repo.findById(reserved.objectId))!;
    // simulate a crashed writer: lease expired, bytes published but never staged
    await primary.put(row.storageKey, Buffer.from("stale unverified bytes"), { contentType: "text/plain", maxBytes: 100 });
    await repo.update(row.id, { state: "uploading", leaseToken: "stale-token", leaseExpiresAt: new Date(Date.now() - 60_000) });
    const fresh = Buffer.from("fresh bytes");
    await expect(storage.receiveUpload(user, reserved.objectId, reserved.uploadToken, Readable.from([fresh]))).rejects.toMatchObject({ statusCode: 409, code: "STORAGE_UPLOAD_EXPIRED" });
    expect(primary.objects.get(row.storageKey)!.bytes.toString()).toBe("stale unverified bytes"); // untouched by the refused PUT
    const summary = await storage.sweepStorage(new Date());
    expect(summary.expiredLeases).toBe(1);
    const after = (await repo.findById(reserved.objectId))!;
    expect(["failed", "deleted"]).toContain(after.state);
    expect(after.leaseToken).toBeNull();
    expect(primary.objects.has(row.storageKey)).toBe(false); // leftover removed by the sweep
    const again = await storage.reserveUpload(null, { companyId: COMPANY, userId: user.id, kind: "document", contentType: "text/plain", declaredSize: 100 });
    const result = await storage.receiveUpload(user, again.objectId, again.uploadToken, Readable.from([fresh]));
    expect(result.sha256).toBe(sha(fresh));
    expect((await repo.findById(again.objectId))!.state).toBe("staged");
  });

  it("a live lease blocks other writers (409) and the sweep settles expired leases to failed", async () => {
    const reserved = await storage.reserveUpload(null, { companyId: COMPANY, userId: user.id, kind: "document", contentType: "text/plain", declaredSize: 100 });
    await repo.update(reserved.objectId, { state: "uploading", leaseToken: "live-token", leaseExpiresAt: new Date(Date.now() + 60_000) });
    await expect(storage.receiveUpload(user, reserved.objectId, reserved.uploadToken, Readable.from([Buffer.from("x")]))).rejects.toMatchObject({ statusCode: 409 });
    expect((await repo.findById(reserved.objectId))!.leaseToken).toBe("live-token");

    const expired = await storage.reserveUpload(null, { companyId: COMPANY, userId: user.id, kind: "document", contentType: "text/plain", declaredSize: 100 });
    await repo.update(expired.objectId, { state: "uploading", leaseToken: "dead-token", leaseExpiresAt: new Date(Date.now() - 1000) });
    const summary = await storage.sweepStorage(new Date());
    expect(summary.expiredLeases).toBe(1);
    const settled = (await repo.findById(expired.objectId))!;
    expect(["failed", "deleted"]).toContain(settled.state); // fenced out and cleaned in the same pass
    expect(settled.leaseToken).toBeNull();
    expect((await repo.findById(reserved.objectId))!.state).toBe("uploading");
  });

  it("a stale writer whose lease was lost never deletes the new owner's object", async () => {
    const reserved = await storage.reserveUpload(null, { companyId: COMPANY, userId: user.id, kind: "document", contentType: "text/plain", declaredSize: 100 });
    const row = (await repo.findById(reserved.objectId))!;
    // new owner already finished: staged with its bytes
    const winner = Buffer.from("winner bytes");
    await primary.put(row.storageKey, winner, { contentType: "text/plain", maxBytes: 100 });
    await repo.update(row.id, { state: "staged", sha256: sha(winner), sizeBytes: winner.length, leaseToken: null, leaseExpiresAt: null });
    // the stale writer's finish step must refuse without touching the object
    await expect(storage.finishUploadForTests(row.id, "stale-token", { sizeBytes: 3, sha256: "abc" })).resolves.toBe(false);
    expect(primary.objects.get(row.storageKey)!.bytes.equals(winner)).toBe(true);
    expect((await repo.findById(row.id))!.state).toBe("staged");
  });
  void inArray;
});
