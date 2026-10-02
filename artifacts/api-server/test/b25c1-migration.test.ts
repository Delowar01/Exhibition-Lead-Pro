// B25 Correction 1 — migration core: --dry-run and --verify are genuinely read-only
// (adapters that THROW on any mutating method), and duplicate legacy references are
// detected, reported with sanitized codes and block copy / verification instead of
// being silently collapsed by the inventory's uniqueness constraint.
import { describe, it, expect } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { InsertStorageObject, StorageObjectRow } from "@workspace/db";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { runMigration, type InventoryAdapter, type MigrationCandidate } from "../src/storage/migration.js";
import type { StorageDriver } from "../src/storage/contract.js";
import type { StorageKind } from "../src/storage/keys.js";

const LIMITS: Record<StorageKind, number> = { document: 1 << 20, export: 1 << 20, report: 1 << 20, scan_image: 1 << 20, branding_logo: 1 << 20 };

function makeRow(p: Partial<StorageObjectRow> & Pick<StorageObjectRow, "id" | "companyId" | "kind" | "reference" | "storageKey" | "driver" | "contentType">): StorageObjectRow {
  const now = new Date();
  return { entityType: null, entityId: null, legacyKey: null, mirrorKey: null, leaseToken: null, leaseExpiresAt: null, sizeBytes: null, sha256: null, state: "active", mirrorState: null, lastError: null, createdAt: now, updatedAt: now, deletedAt: null, ...p };
}

/** In-memory inventory whose mutating methods can be armed to throw. */
function memoryInventory(initial: StorageObjectRow[] = [], opts: { readOnly?: boolean } = {}) {
  const rows = new Map<string, StorageObjectRow>();
  for (const r of initial) rows.set(r.id, r);
  const writes: string[] = [];
  const mutate = (name: string) => {
    writes.push(name);
    if (opts.readOnly) throw new Error(`MUTATION IN READ-ONLY MODE: inventory.${name}`);
  };
  const adapter: InventoryAdapter = {
    async findByReference(companyId, kind, reference) {
      return [...rows.values()].find((r) => r.companyId === companyId && r.kind === kind && r.reference === reference) ?? null;
    },
    async register(c, { id, storageKey }) {
      mutate("register");
      const existing = await adapter.findByReference(c.companyId, c.kind, c.reference);
      if (existing) return existing.state === "active" ? existing : null;
      const row = makeRow({ id, companyId: c.companyId, kind: c.kind, entityType: c.entityType, entityId: c.entityId, reference: c.reference, storageKey, driver: "gcs", legacyKey: c.legacyKey, contentType: c.contentType ?? "application/octet-stream" });
      rows.set(id, row);
      return row;
    },
    async listPending(afterId, limit) {
      return [...rows.values()].filter((r) => r.state === "active" && r.legacyKey).sort((a, b) => (a.id < b.id ? -1 : 1)).filter((r) => !afterId || r.id > afterId).slice(0, limit);
    },
    async update(id, patch: Partial<InsertStorageObject>) {
      mutate("update");
      Object.assign(rows.get(id)!, patch);
    },
  };
  return { rows, adapter, writes };
}

/** Wrap a driver so every mutating method throws (and records) — reads pass through. */
function readOnlyDriver(inner: StorageDriver, calls: string[]): StorageDriver {
  return {
    kind: inner.kind,
    put: async () => {
      calls.push(`${inner.kind}.put`);
      throw new Error(`MUTATION IN READ-ONLY MODE: ${inner.kind}.put`);
    },
    delete: async () => {
      calls.push(`${inner.kind}.delete`);
      throw new Error(`MUTATION IN READ-ONLY MODE: ${inner.kind}.delete`);
    },
    getStream: (k, o) => inner.getStream(k, o),
    head: (k) => inner.head(k),
    exists: (k) => inner.exists(k),
    probe: () => inner.probe(),
  };
}

function sha(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

async function fixture(n = 3) {
  const source = new MemoryStorageDriver({ looseKeys: true, kind: "gcs" });
  const target = new MemoryStorageDriver();
  const candidates: MigrationCandidate[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    const legacyKey = `gs://dev-bucket/.private/uploads/${id}`;
    await source.put(legacyKey, randomBytes(500 + i), { contentType: "application/pdf", maxBytes: LIMITS.document });
    candidates.push({ companyId: 1, kind: "document", entityType: "document_version", entityId: 100 + i, reference: `/objects/uploads/${id}`, legacyKey, contentType: "application/pdf" });
  }
  return { source, target, candidates };
}

describe("7. --dry-run and --verify perform zero writes", () => {
  it("dry-run plans registrations and copies without touching the inventory or either store", async () => {
    const f = await fixture(3);
    const calls: string[] = [];
    const inv = memoryInventory([], { readOnly: true });
    const s = await runMigration({ mode: "dry-run", source: readOnlyDriver(f.source, calls), target: readOnlyDriver(f.target, calls), inventory: inv.adapter, discover: async () => ({ candidates: f.candidates, unattributable: 0 }), limits: LIMITS });
    expect(inv.writes).toEqual([]);
    expect(calls).toEqual([]);
    expect(inv.rows.size).toBe(0);
    expect(f.target.objects.size).toBe(0);
    expect(s.registrationsPlanned).toBe(3);
    expect(s.counts.planned).toBe(3);
    expect(s.counts.failed).toBe(0);
    expect(s.mode).toBe("dry-run");
  });

  it("dry-run reports already-migrated and missing-source objects from the existing inventory, still without writes", async () => {
    const f = await fixture(2);
    const migrated = makeRow({ id: randomUUID(), companyId: 1, kind: "document", reference: f.candidates[0].reference, storageKey: "tenants/1/documents/m", driver: "memory", legacyKey: f.candidates[0].legacyKey, contentType: "application/pdf", sha256: "x", sizeBytes: 1 });
    f.source.objects.delete(f.candidates[1].legacyKey!);
    const calls: string[] = [];
    const inv = memoryInventory([migrated], { readOnly: true });
    const s = await runMigration({ mode: "dry-run", source: readOnlyDriver(f.source, calls), target: readOnlyDriver(f.target, calls), inventory: inv.adapter, discover: async () => ({ candidates: f.candidates, unattributable: 0 }), limits: LIMITS });
    expect(inv.writes).toEqual([]);
    expect(calls).toEqual([]);
    expect(s.counts.already).toBe(1);
    expect(s.counts.missing_source).toBe(1);
    expect(s.registrationsPlanned).toBe(1);
    expect(s.complete).toBe(false);
  });

  it("verify reads legacy references + inventory and reports unregistered / unmigrated / mismatched rows with zero writes", async () => {
    const f = await fixture(3);
    const copied = makeRow({ id: randomUUID(), companyId: 1, kind: "document", reference: f.candidates[0].reference, storageKey: "tenants/1/documents/c", driver: "memory", legacyKey: f.candidates[0].legacyKey, contentType: "application/pdf" });
    const bytes = f.source.objects.get(f.candidates[0].legacyKey!)!.bytes;
    await f.target.put(copied.storageKey, bytes, { contentType: "application/pdf", maxBytes: LIMITS.document });
    copied.sha256 = sha(bytes);
    copied.sizeBytes = bytes.length;
    const tampered = makeRow({ id: randomUUID(), companyId: 1, kind: "document", reference: f.candidates[1].reference, storageKey: "tenants/1/documents/t", driver: "memory", legacyKey: f.candidates[1].legacyKey, contentType: "application/pdf", sha256: "0".repeat(64), sizeBytes: 1 });
    await f.target.put(tampered.storageKey, Buffer.from("tampered"), { contentType: "application/pdf", maxBytes: LIMITS.document });
    const calls: string[] = [];
    const inv = memoryInventory([copied, tampered], { readOnly: true });
    const s = await runMigration({ mode: "verify", source: readOnlyDriver(f.source, calls), target: readOnlyDriver(f.target, calls), inventory: inv.adapter, discover: async () => ({ candidates: f.candidates, unattributable: 0 }), limits: LIMITS });
    expect(inv.writes).toEqual([]);
    expect(calls).toEqual([]);
    expect(s.counts.verified).toBe(1);
    expect(s.counts.checksum_mismatch).toBe(1);
    expect(s.counts.unregistered).toBe(1); // candidate 2 has no inventory row at all
    expect(s.complete).toBe(false);
    expect(s.problems.map((p) => p.status).sort()).toEqual(["checksum_mismatch", "unregistered"]);
  });

  it("only copy mode registers and writes", async () => {
    const f = await fixture(2);
    const inv = memoryInventory();
    const s = await runMigration({ mode: "copy", source: f.source, target: f.target, inventory: inv.adapter, discover: async () => ({ candidates: f.candidates, unattributable: 0 }), limits: LIMITS });
    expect(inv.writes.filter((w) => w === "register")).toHaveLength(2);
    expect(s.counts.copied).toBe(2);
    expect(s.complete).toBe(true);
  });
});

describe("8. duplicate legacy references", () => {
  async function dupFixture() {
    const f = await fixture(1);
    // document-version duplicate: two versions share one object
    const shared = f.candidates[0];
    f.candidates.push({ ...shared, entityId: 999 });
    // cross-feature collision: an export run and an executive report share one legacy object
    const id = randomUUID();
    const legacyKey = `gs://dev-bucket/.private/uploads/${id}`;
    await f.source.put(legacyKey, Buffer.from("shared artifact"), { contentType: "application/pdf", maxBytes: LIMITS.export });
    f.candidates.push({ companyId: 1, kind: "export", entityType: "export_run", entityId: 7, reference: `/objects/uploads/${id}`, legacyKey, contentType: null });
    f.candidates.push({ companyId: 1, kind: "report", entityType: "executive_report", entityId: 8, reference: `/objects/uploads/${id}`, legacyKey, contentType: null });
    // a healthy one
    const ok = randomUUID();
    await f.source.put(`gs://dev-bucket/.private/uploads/${ok}`, Buffer.from("fine"), { contentType: "application/pdf", maxBytes: LIMITS.document });
    f.candidates.push({ companyId: 1, kind: "document", entityType: "document_version", entityId: 500, reference: `/objects/uploads/${ok}`, legacyKey: `gs://dev-bucket/.private/uploads/${ok}`, contentType: "application/pdf" });
    return f;
  }

  it("reports duplicate groups with sanitized codes and counts, and blocks copy for them", async () => {
    const f = await dupFixture();
    const inv = memoryInventory();
    const s = await runMigration({ mode: "copy", source: f.source, target: f.target, inventory: inv.adapter, discover: async () => ({ candidates: f.candidates, unattributable: 0 }), limits: LIMITS });
    expect(s.sourceReferences).toBe(5);
    expect(s.uniqueObjects).toBe(3);
    expect(s.duplicateGroups).toHaveLength(2);
    for (const g of s.duplicateGroups) {
      expect(g.code).toBe("DUPLICATE_REFERENCE");
      expect(g.companyId).toBe(1);
      expect(g.references).toBeGreaterThanOrEqual(2);
      expect(g.entities.length).toBeGreaterThanOrEqual(2);
      expect(g.legacyKeyHash).toMatch(/^[0-9a-f]{16}$/);
    }
    const versionGroup = s.duplicateGroups.find((g) => g.kinds.includes("document"))!;
    expect(versionGroup.entities.map((e) => e.entityId).sort()).toEqual([100, 999]);
    const crossGroup = s.duplicateGroups.find((g) => g.kinds.includes("export"))!;
    expect(crossGroup.kinds.sort()).toEqual(["export", "report"]);
    expect(s.counts.duplicate).toBe(4);
    expect(s.counts.copied).toBe(1); // only the healthy reference moves
    expect(s.complete).toBe(false);
    expect(inv.rows.size).toBe(1); // duplicates are not registered (never collapsed into one row)
    const json = JSON.stringify(s);
    expect(json).not.toContain("gs://");
    expect(json).not.toContain("/objects/");
  });

  it("verification fails while unsupported duplicates remain and dry-run reports them without writes", async () => {
    const f = await dupFixture();
    const calls: string[] = [];
    const inv = memoryInventory([], { readOnly: true });
    const dry = await runMigration({ mode: "dry-run", source: readOnlyDriver(f.source, calls), target: readOnlyDriver(f.target, calls), inventory: inv.adapter, discover: async () => ({ candidates: f.candidates, unattributable: 0 }), limits: LIMITS });
    expect(inv.writes).toEqual([]);
    expect(calls).toEqual([]);
    expect(dry.duplicateGroups).toHaveLength(2);
    expect(dry.complete).toBe(false);
    const ver = await runMigration({ mode: "verify", source: readOnlyDriver(f.source, calls), target: readOnlyDriver(f.target, calls), inventory: inv.adapter, discover: async () => ({ candidates: f.candidates, unattributable: 0 }), limits: LIMITS });
    expect(ver.complete).toBe(false);
    expect(ver.counts.duplicate).toBe(4);
    expect(calls).toEqual([]);
  });
});
