// B25 Correction 9 — lifecycle of a tombstone whose bucket object was RETAINED (last_error LEGACY_RETAINED,
// legacy deletion off). Source-backed regression against the real repository queries and the real sweep:
//   • LEGACY_RETAINED is a purge-blocking flag (PURGE_BLOCKING_ERRORS): a reconciled tombstone of a deleted
//     company older than 24 h is NEVER selected for purge — not after 24 h, not after 1000 days. There is no
//     purge deadline for a retained object; only an explicit, approved recovery removes it.
//   • The final reconciliation (listUnreconciledTombstones → markReconciled) PRESERVES the flag: the row
//     becomes reconciled_at != null and stays LEGACY_RETAINED, so it stays purge-blocked afterwards too.
//   • The same row WITHOUT the flag is purged by the very same sweep (control: the query is otherwise satisfied).
// Runs against the LOCAL database named by DATABASE_URL (synthetic rows of a company id that does not exist).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, storageObjectsTable, companiesTable } from "@workspace/db";
import { config } from "../src/config.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as storage from "../src/services/storage.service.js";

type MutableStorageConfig = { driver: string; bucketId: string; legacyDelete: boolean; sweepBatchSize: number };
const os = config.objectStorage as unknown as MutableStorageConfig;
const original = { ...os };
const H = 60 * 60 * 1000;
const D = 24 * H;
const ABSENT_COMPANY = 970_001; // never exists: the tombstones are "orphans of a deleted company"
const ids: string[] = [];

async function tombstone(opts: { lastError: string | null; reconciledAt: Date | null; ageMs: number }): Promise<string> {
  const id = randomUUID();
  const t = new Date(Date.now() - opts.ageMs);
  await db.insert(storageObjectsTable).values({
    id,
    companyId: ABSENT_COMPANY,
    kind: "document",
    reference: `/objects/${id}`,
    storageKey: `tenants/${ABSENT_COMPANY}/documents/${id}`,
    driver: "gcs",
    legacyKey: `gs://b25c9-test-bucket/.private/uploads/${id}`,
    contentType: "application/pdf",
    sizeBytes: 49_000,
    sha256: "ab".repeat(32),
    state: "deleted",
    lastError: opts.lastError,
    createdAt: t,
    updatedAt: t,
    deletedAt: t,
    reconciledAt: opts.reconciledAt,
  } as never);
  ids.push(id);
  return id;
}
async function row(id: string) {
  const [r] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.id, id));
  return r;
}

beforeAll(async () => {
  const exists = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, ABSENT_COMPANY));
  expect(exists.length, "the synthetic company id must not exist").toBe(0);
  // the sweep needs a configured store; the retained rows are gcs rows, so no copy is ever located (no provider call)
  os.driver = "memory";
  os.bucketId = "";
  os.legacyDelete = false;
  __setDriversForTests({ primary: new MemoryStorageDriver(), legacy: null });
});

afterAll(async () => {
  if (ids.length) await db.delete(storageObjectsTable).where(inArray(storageObjectsTable.id, ids));
  Object.assign(os, original);
  __resetStorageRegistryForTests();
});

describe("B25 C9 — a LEGACY_RETAINED tombstone is never auto-purged (no purge deadline exists)", () => {
  it("LEGACY_RETAINED is one of the purge-blocking flags in the repository", () => {
    expect(repo.PURGE_BLOCKING_ERRORS).toContain(repo.LEGACY_RETAINED);
    expect(repo.PURGE_BLOCKING_ERRORS).toContain(repo.CLEANUP_PENDING);
    expect(repo.PURGE_BLOCKING_ERRORS).toContain(repo.OWNERSHIP_UNPROVEN);
  });

  it("a reconciled LEGACY_RETAINED tombstone of a deleted company, older than 24 h, is not purgeable — not after 24 h and not after 1000 days; the same row without the flag is", async () => {
    const retained = await tombstone({ lastError: repo.LEGACY_RETAINED, reconciledAt: new Date(Date.now() - 2 * D), ageMs: 3 * D });
    const control = await tombstone({ lastError: null, reconciledAt: new Date(Date.now() - 2 * D), ageMs: 3 * D });
    const after24h = (await repo.listPurgeableTombstones(new Date(Date.now() - D), 1000)).map((r) => r.id);
    expect(after24h).toContain(control);
    expect(after24h).not.toContain(retained);
    const after1000d = (await repo.listPurgeableTombstones(new Date(Date.now() + 1000 * D), 1000)).map((r) => r.id);
    expect(after1000d).toContain(control);
    expect(after1000d).not.toContain(retained);
    // the other blocking flags behave the same way
    for (const flag of [repo.CLEANUP_PENDING, repo.OWNERSHIP_UNPROVEN]) {
      const blocked = await tombstone({ lastError: flag, reconciledAt: new Date(Date.now() - 2 * D), ageMs: 3 * D });
      expect((await repo.listPurgeableTombstones(new Date(Date.now() + 1000 * D), 1000)).map((r) => r.id)).not.toContain(blocked);
    }
  });

  it("the final reconciliation keeps the flag: an unreconciled LEGACY_RETAINED tombstone older than the quiescence horizon is reconciled (reconciled_at set) and stays LEGACY_RETAINED, hence still purge-blocked", async () => {
    const id = await tombstone({ lastError: repo.LEGACY_RETAINED, reconciledAt: null, ageMs: 3 * D });
    const quiescentBefore = new Date(Date.now() - config.objectStorage.uploadHardLifetimeMs - 5 * 60 * 1000);
    expect((await repo.listUnreconciledTombstones(quiescentBefore, 1000)).map((r) => r.id)).toContain(id);
    expect((await repo.listPurgeableTombstones(new Date(Date.now() + 1000 * D), 1000)).map((r) => r.id)).not.toContain(id); // unreconciled: not purgeable either
    const now = new Date();
    expect(await repo.markReconciled(id, now, repo.LEGACY_RETAINED)).toBe(true);
    expect(await repo.markReconciled(id, now, null)).toBe(false); // compare-and-set: a second reconciliation never clears the flag
    const r = await row(id);
    expect(r.state).toBe("deleted");
    expect(r.reconciledAt).not.toBeNull();
    expect(r.lastError).toBe(repo.LEGACY_RETAINED);
    expect((await repo.listUnreconciledTombstones(new Date(Date.now() + 1000 * D), 1000)).map((x) => x.id)).not.toContain(id);
    expect((await repo.listPurgeableTombstones(new Date(Date.now() + 1000 * D), 1000)).map((x) => x.id)).not.toContain(id);
  });

  it("the real maintenance sweep reconciles an unreconciled retained tombstone (flag kept), purges the unflagged control row, and leaves every LEGACY_RETAINED row in place", async () => {
    const retainedReconciled = await tombstone({ lastError: repo.LEGACY_RETAINED, reconciledAt: new Date(Date.now() - 2 * D), ageMs: 3 * D });
    const retainedUnreconciled = await tombstone({ lastError: repo.LEGACY_RETAINED, reconciledAt: null, ageMs: 3 * D });
    const control = await tombstone({ lastError: null, reconciledAt: new Date(Date.now() - 2 * D), ageMs: 3 * D });
    const summary = await storage.sweepStorage(new Date());
    expect(summary.purgedTombstones).toBeGreaterThanOrEqual(1);
    expect(await row(control)).toBeUndefined();
    const a = await row(retainedReconciled);
    expect(a).toBeDefined();
    expect(a.lastError).toBe(repo.LEGACY_RETAINED);
    const b = await row(retainedUnreconciled);
    expect(b).toBeDefined();
    expect(b.reconciledAt).not.toBeNull(); // reconciled by this sweep ...
    expect(b.lastError).toBe(repo.LEGACY_RETAINED); // ... with the flag preserved
    // a second sweep (far in the future) still never purges them
    const again = await storage.sweepStorage(new Date(Date.now() + 1000 * D));
    expect(await row(retainedReconciled)).toBeDefined();
    expect(await row(retainedUnreconciled)).toBeDefined();
    void again;
  });
});
