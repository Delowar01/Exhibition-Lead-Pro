// Batch 25 — migration core (legacy → primary) with in-memory drivers and an
// in-memory inventory. No bucket, no DB, no server. Covers dry run, copy,
// resume / already-copied detection, missing sources, checksum mismatches,
// conflicting local objects (never overwritten), verify mode, tombstones
// (never resurrected) and bounded concurrency.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { InsertStorageObject, StorageObjectRow } from "@workspace/db";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { runMigration, type InventoryAdapter, type MigrationCandidate, type MigrationSummary } from "../src/storage/migration.js";
import { __resetStorageCountersForTests, storageCounters } from "../src/storage/metrics.js";
import type { StorageKind } from "../src/storage/keys.js";

const LIMITS: Record<StorageKind, number> = { document: 1 << 20, export: 1 << 20, report: 1 << 20, scan_image: 1 << 20, branding_logo: 1 << 20 };

function sha(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

function makeRow(partial: Partial<StorageObjectRow> & Pick<StorageObjectRow, "id" | "companyId" | "kind" | "reference" | "storageKey" | "driver" | "contentType">): StorageObjectRow {
  const now = new Date();
  return {
    entityType: null,
    entityId: null,
    legacyKey: null,
    sizeBytes: null,
    sha256: null,
    state: "active",
    mirrorState: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...partial,
  };
}

function memoryInventory(initial: StorageObjectRow[] = []) {
  const rows = new Map<string, StorageObjectRow>();
  for (const r of initial) rows.set(r.id, r);
  const adapter: InventoryAdapter = {
    async register(c, { id, storageKey }) {
      const existing = [...rows.values()].find((r) => r.companyId === c.companyId && r.kind === c.kind && r.reference === c.reference);
      if (existing) return existing.state === "active" ? existing : null;
      const row = makeRow({
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
      });
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

interface Fixture {
  source: MemoryStorageDriver;
  target: MemoryStorageDriver;
  candidates: MigrationCandidate[];
  objects: Map<string, Buffer>;
}

async function fixture(n = 3, opts: { missing?: number } = {}): Promise<Fixture> {
  const source = new MemoryStorageDriver({ looseKeys: true });
  const target = new MemoryStorageDriver();
  const candidates: MigrationCandidate[] = [];
  const objects = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const uploadId = randomUUID();
    const legacyKey = `gs://dev-bucket/.private/uploads/${uploadId}`;
    const reference = `/objects/uploads/${uploadId}`;
    const bytes = randomBytes(1000 + i * 137);
    if (i >= n - (opts.missing ?? 0)) {
      // referenced in the DB but absent from the bucket
    } else {
      await source.put(legacyKey, bytes, { contentType: "application/pdf", maxBytes: LIMITS.document });
    }
    objects.set(reference, bytes);
    candidates.push({ companyId: 1 + (i % 2), kind: "document", entityType: "document_version", entityId: 100 + i, reference, legacyKey, contentType: "application/pdf" });
  }
  return { source, target, candidates, objects };
}

function run(f: Fixture, inventory: InventoryAdapter, mode: "dry-run" | "copy" | "verify", extra: Partial<Parameters<typeof runMigration>[0]> = {}): Promise<MigrationSummary> {
  return runMigration({
    mode,
    source: f.source,
    target: f.target,
    inventory,
    discover: async () => ({ candidates: f.candidates, unattributable: 0 }),
    limits: LIMITS,
    concurrency: 2,
    batchSize: 2,
    ...extra,
  });
}

beforeEach(() => __resetStorageCountersForTests());

describe("migration — dry run", () => {
  it("registers every referenced object once and reports present / missing without moving bytes", async () => {
    const f = await fixture(4, { missing: 1 });
    const inv = memoryInventory();
    const s1 = await run(f, inv.adapter, "dry-run");
    expect(s1.discovered).toBe(4);
    expect(s1.registered).toBe(4);
    expect(s1.counts.planned).toBe(3);
    expect(s1.counts.missing_source).toBe(1);
    expect(s1.complete).toBe(false);
    expect(s1.problems).toHaveLength(1);
    expect(s1.problems[0].status).toBe("missing_source");
    expect(f.target.objects.size).toBe(0);
    // idempotent registration: a second dry run creates no duplicate rows
    const s2 = await run(f, inv.adapter, "dry-run");
    expect(inv.rows.size).toBe(4);
    expect(s2.registered).toBe(4);
    expect([...inv.rows.values()].every((r) => r.driver === "gcs")).toBe(true);
    // the summary carries ids / kinds / codes only — never keys or bucket names
    const json = JSON.stringify(s1);
    expect(json).not.toContain("gs://");
    expect(json).not.toContain("tenants/");
    expect(json).not.toContain("/objects/");
  });

  it("marks an unattributable reference as incomplete", async () => {
    const f = await fixture(1);
    const inv = memoryInventory();
    const s = await run(f, inv.adapter, "dry-run", { discover: async () => ({ candidates: f.candidates, unattributable: 1 }) });
    expect(s.unattributable).toBe(1);
    expect(s.complete).toBe(false);
  });
});

describe("migration — copy", () => {
  it("copies, verifies (size + sha) and flips the inventory to the target driver; rerun resumes without re-copying", async () => {
    const f = await fixture(5, { missing: 1 });
    const inv = memoryInventory();
    const s1 = await run(f, inv.adapter, "copy");
    expect(s1.counts.copied).toBe(4);
    expect(s1.counts.missing_source).toBe(1);
    expect(s1.complete).toBe(false);
    expect(f.target.objects.size).toBe(4);
    for (const row of inv.rows.values()) {
      const bytes = f.objects.get(row.reference)!;
      if (row.legacyKey && f.source.objects.has(row.legacyKey)) {
        expect(row.driver).toBe("memory");
        expect(row.sha256).toBe(sha(bytes));
        expect(row.sizeBytes).toBe(bytes.length);
        expect(row.legacyKey).toContain("gs://"); // the legacy location is kept for fallback / audit
        expect(f.target.objects.get(row.storageKey)!.bytes.equals(bytes)).toBe(true);
      } else {
        expect(row.driver).toBe("gcs");
      }
    }
    // the source is never deleted
    expect(f.source.objects.size).toBe(4);

    const getSpy = vi.spyOn(f.source, "getStream");
    const s2 = await run(f, inv.adapter, "copy");
    expect(s2.counts.already).toBe(4);
    expect(s2.counts.copied).toBe(0);
    expect(s2.counts.missing_source).toBe(1);
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });

  it("adopts an identical pre-existing target object and refuses to overwrite a conflicting one", async () => {
    const f = await fixture(2);
    const inv = memoryInventory();
    await run(f, inv.adapter, "dry-run");
    const [rowA, rowB] = [...inv.rows.values()];
    // A: a previous crashed run already wrote the right bytes
    await f.target.put(rowA.storageKey, f.objects.get(rowA.reference)!, { contentType: "application/pdf", maxBytes: LIMITS.document });
    // B: something else lives at B's key
    const foreign = Buffer.from("not the migrated object");
    await f.target.put(rowB.storageKey, foreign, { contentType: "text/plain", maxBytes: LIMITS.document });
    const s = await run(f, inv.adapter, "copy");
    expect(s.counts.already).toBe(1);
    expect(s.counts.conflict).toBe(1);
    expect(s.complete).toBe(false);
    expect(inv.rows.get(rowA.id)!.driver).toBe("memory");
    expect(inv.rows.get(rowB.id)!.driver).toBe("gcs");
    expect(f.target.objects.get(rowB.storageKey)!.bytes.equals(foreign)).toBe(true);
    expect(storageCounters().migrationVerifyFailures).toBe(1);
  });

  it("reports a checksum mismatch (source head disagrees with the bytes) and removes the unverified copy", async () => {
    const f = await fixture(1);
    const inv = memoryInventory();
    const realHead = f.source.head.bind(f.source);
    vi.spyOn(f.source, "head").mockImplementation(async (key) => {
      const h = await realHead(key);
      return h ? { ...h, sizeBytes: (h.sizeBytes ?? 0) + 1 } : null;
    });
    const s = await run(f, inv.adapter, "copy");
    expect(s.counts.checksum_mismatch).toBe(1);
    expect(s.complete).toBe(false);
    expect(f.target.objects.size).toBe(0);
    expect([...inv.rows.values()][0].driver).toBe("gcs");
    expect(storageCounters().migrationVerifyFailures).toBe(1);
  });

  it("records a driver failure as failed with a sanitized code and keeps going", async () => {
    const f = await fixture(3);
    const inv = memoryInventory();
    f.target.failNextPut = true;
    const s = await run(f, inv.adapter, "copy", { concurrency: 1 });
    expect(s.counts.failed).toBe(1);
    expect(s.counts.copied).toBe(2);
    expect(s.problems[0].code).toBe("STORAGE_UNAVAILABLE");
    expect(s.complete).toBe(false);
    const s2 = await run(f, inv.adapter, "copy");
    expect(s2.counts.copied).toBe(1);
    expect(s2.counts.already).toBe(2);
    expect(s2.complete).toBe(true);
  });

  it("never resurrects a tombstoned reference", async () => {
    const f = await fixture(2);
    const c = f.candidates[0];
    const tomb = makeRow({ id: randomUUID(), companyId: c.companyId, kind: c.kind, reference: c.reference, storageKey: `tenants/${c.companyId}/documents/tomb`, driver: "gcs", legacyKey: c.legacyKey, contentType: "application/pdf", state: "deleted" });
    const inv = memoryInventory([tomb]);
    const s = await run(f, inv.adapter, "copy");
    expect(s.registered).toBe(1);
    expect(s.counts.copied).toBe(1);
    expect(inv.rows.size).toBe(2);
    expect(inv.rows.get(tomb.id)!.state).toBe("deleted");
    expect(f.target.objects.has(tomb.storageKey)).toBe(false);
  });

  it("runs with bounded concurrency over many objects", async () => {
    const f = await fixture(23);
    const inv = memoryInventory();
    const s = await run(f, inv.adapter, "copy", { concurrency: 8, batchSize: 5 });
    expect(s.counts.copied).toBe(23);
    expect(s.processed).toBe(23);
    expect(s.complete).toBe(true);
    expect(f.target.objects.size).toBe(23);
  });
});

describe("migration — verify", () => {
  it("proves every migrated object matches the inventory and reports unmigrated rows and tampered copies", async () => {
    const f = await fixture(3, { missing: 1 });
    const inv = memoryInventory();
    await run(f, inv.adapter, "copy");
    const v1 = await run(f, inv.adapter, "verify", { source: null });
    expect(v1.counts.verified).toBe(2);
    expect(v1.counts.not_migrated).toBe(1);
    expect(v1.complete).toBe(false);

    // tamper with one migrated object in the target
    const migrated = [...inv.rows.values()].find((r) => r.driver === "memory")!;
    f.target.objects.set(migrated.storageKey, { bytes: Buffer.from("tampered"), contentType: "application/pdf", sha256: "x" });
    const v2 = await run(f, inv.adapter, "verify", { source: null });
    expect(v2.counts.verified).toBe(1);
    expect(v2.counts.checksum_mismatch).toBe(1);
    expect(v2.problems.map((p) => p.status).sort()).toEqual(["checksum_mismatch", "not_migrated"]);
    expect(storageCounters().migrationVerifyFailures).toBe(1);
  });

  it("is complete only when everything is migrated and verified", async () => {
    const f = await fixture(2);
    const inv = memoryInventory();
    await run(f, inv.adapter, "copy");
    const v = await run(f, inv.adapter, "verify", { source: null });
    expect(v.counts.verified).toBe(2);
    expect(v.complete).toBe(true);
  });
});
