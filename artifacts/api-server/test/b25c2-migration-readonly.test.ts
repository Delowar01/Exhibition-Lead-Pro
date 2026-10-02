// B25 Correction 2 — `--dry-run` and `--verify` are read-only for the FILESYSTEM
// too: opening the migration target in a read-only mode never creates
// OBJECT_STORAGE_FS_ROOT (or any subdirectory, temp file, probe or object), a
// missing root is reported as absent, an existing root is inspected without
// modification, and only `--copy` creates/writes.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os_ from "node:os";
import path from "node:path";
import type { StorageObjectRow } from "@workspace/db";
import { config } from "../src/config.js";
import { FsStorageDriver } from "../src/storage/fs-driver.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { readAll } from "../src/storage/contract.js";
import { __resetStorageRegistryForTests } from "../src/storage/registry.js";
import { openMigrationDrivers } from "../src/storage/migration-cli.js";
import { runMigration, type InventoryAdapter, type MigrationCandidate } from "../src/storage/migration.js";
import { tenantKey } from "../src/storage/keys.js";

const KEY = randomBytes(32);
const LIMITS = { document: 1 << 20, export: 1 << 20, report: 1 << 20, scan_image: 1 << 20, branding_logo: 1 << 20 };
const os = config.objectStorage as unknown as { driver: string; fsRoot: string; encryptionKey: string | undefined; bucketId: string; legacyDelete: boolean; testEphemeralKey: boolean };
const original = { ...os };
let base = "";

function throwingInventory(rows: StorageObjectRow[] = []): InventoryAdapter {
  const mutate = (what: string) => async () => {
    throw new Error(`MUTATION IN READ-ONLY MODE: ${what}`);
  };
  return {
    async findByReference(companyId, kind, reference) {
      return rows.find((r) => r.companyId === companyId && r.kind === kind && r.reference === reference) ?? null;
    },
    register: mutate("inventory.register"),
    async listPending(afterId, limit) {
      return rows
        .filter((r) => r.state === "active" && r.legacyKey)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .filter((r) => !afterId || r.id > afterId)
        .slice(0, limit);
    },
    update: mutate("inventory.update"),
  };
}
function candidate(): MigrationCandidate {
  const id = randomUUID();
  return { companyId: 1, kind: "document", entityType: "document_version", entityId: 1, reference: `/objects/uploads/${id}`, legacyKey: `gs://fake-bucket/.private/uploads/${id}`, contentType: "application/pdf" };
}
function registeredRow(c: MigrationCandidate): StorageObjectRow {
  const id = randomUUID();
  const now = new Date();
  return { id, companyId: c.companyId, kind: c.kind, entityType: c.entityType, entityId: c.entityId, reference: c.reference, storageKey: tenantKey(c.kind, c.companyId, id), driver: "gcs", legacyKey: c.legacyKey, mirrorKey: null, leaseToken: null, leaseExpiresAt: null, contentType: "application/pdf", sizeBytes: null, sha256: null, state: "active", mirrorState: null, lastError: null, createdAt: now, updatedAt: now, deletedAt: null };
}

afterAll(() => {
  Object.assign(os, original);
  __resetStorageRegistryForTests();
  if (base) rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  __resetStorageRegistryForTests();
  base = base || mkdtempSync(path.join(os_.tmpdir(), "lcp-ro-"));
});

describe("8. read-only migration modes never create the target root", () => {
  it("a read-only filesystem driver reports a missing root as absent and refuses every write without creating anything", async () => {
    const root = path.join(base, "missing-" + randomUUID());
    const driver = new FsStorageDriver({ root, key: KEY, readOnly: true });
    await driver.init();
    expect(existsSync(root)).toBe(false);
    expect(driver.rootState()).toBe("absent");
    const key = `tenants/1/documents/${randomUUID()}`;
    expect(await driver.exists(key)).toBe(false);
    expect(await driver.head(key)).toBeNull();
    await expect(driver.getStream(key)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND" });
    await expect(driver.put(key, Buffer.from("x"), { contentType: "text/plain", maxBytes: 10 })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", reason: "READ_ONLY" });
    await expect(driver.delete(key)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", reason: "READ_ONLY" });
    await expect(driver.probe()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", reason: "READ_ONLY" });
    expect(existsSync(root)).toBe(false);
  });

  it("an existing target is inspected without modification", async () => {
    const root = path.join(base, "existing-" + randomUUID());
    const writer = new FsStorageDriver({ root, key: KEY });
    await writer.init();
    const key = `tenants/1/documents/${randomUUID()}`;
    const bytes = randomBytes(2000);
    await writer.put(key, bytes, { contentType: "application/pdf", maxBytes: 1 << 20 });
    const dir = path.join(root, "tenants", "1", "documents");
    const before = readdirSync(dir).map((n) => [n, statSync(path.join(dir, n)).mtimeMs] as const);

    const ro = new FsStorageDriver({ root, key: KEY, readOnly: true });
    await ro.init();
    expect(ro.rootState()).toBe("present");
    expect(await ro.exists(key)).toBe(true);
    expect(await ro.head(key)).not.toBeNull();
    expect((await readAll((await ro.getStream(key, { maxBytes: 1 << 20 })).stream, 1 << 20)).equals(bytes)).toBe(true);
    await expect(ro.put(`tenants/1/documents/${randomUUID()}`, Buffer.from("x"), { contentType: "text/plain", maxBytes: 10 })).rejects.toMatchObject({ reason: "READ_ONLY" });
    await expect(ro.delete(key)).rejects.toMatchObject({ reason: "READ_ONLY" });
    expect(readdirSync(dir).map((n) => [n, statSync(path.join(dir, n)).mtimeMs] as const)).toEqual(before);
    expect(readdirSync(root).sort()).toEqual(["tenants"]); // no health/ probe directory, no temp files
  });

  it("--dry-run and --verify through the CLI driver opener leave a nonexistent root nonexistent and perform zero writes; --copy creates it", async () => {
    const root = path.join(base, "cli-" + randomUUID());
    os.driver = "fs";
    os.fsRoot = root;
    os.encryptionKey = KEY.toString("hex");
    os.bucketId = "";
    os.legacyDelete = false;
    const source = new MemoryStorageDriver({ looseKeys: true, kind: "gcs" });
    const c = candidate();
    await source.put(c.legacyKey!, randomBytes(100), { contentType: "application/pdf", maxBytes: 1 << 20 });
    const sourcePut = vi.spyOn(source, "put");
    const sourceDelete = vi.spyOn(source, "delete");

    for (const mode of ["dry-run", "verify"] as const) {
      __resetStorageRegistryForTests();
      const opened = await openMigrationDrivers(mode);
      expect(opened.targetRoot).toBe("absent");
      expect(existsSync(root)).toBe(false);
      const targetPut = vi.spyOn(opened.target, "put");
      const targetDelete = vi.spyOn(opened.target, "delete");
      const rows = mode === "verify" ? [registeredRow(c)] : [];
      const summary = await runMigration({ mode, source, target: opened.target, inventory: throwingInventory(rows), discover: async () => ({ candidates: [c], unattributable: 0 }), limits: LIMITS });
      expect(summary.mode).toBe(mode);
      if (mode === "dry-run") {
        expect(summary.registrationsPlanned).toBe(1); // planned, never performed
        expect(summary.counts.planned).toBe(1);
      } else {
        expect(summary.complete).toBe(false); // the registered row has no target copy (root absent)
        expect(summary.counts.not_migrated + summary.counts.missing_source + summary.counts.failed).toBeGreaterThanOrEqual(1);
      }
      expect(targetPut).not.toHaveBeenCalled();
      expect(targetDelete).not.toHaveBeenCalled();
      expect(existsSync(root)).toBe(false); // STILL nonexistent: no root, no subdirectory, no probe, no temp file
    }
    expect(sourcePut).not.toHaveBeenCalled();
    expect(sourceDelete).not.toHaveBeenCalled();

    __resetStorageRegistryForTests();
    const copy = await openMigrationDrivers("copy");
    expect(copy.targetRoot).toBe("present");
    expect(existsSync(root)).toBe(true);
    expect((statSync(root).mode & 0o777).toString(8)).toBe("700");
    const key = `tenants/1/documents/${randomUUID()}`;
    await copy.target.put(key, Buffer.from("copied"), { contentType: "text/plain", maxBytes: 100 });
    expect(await copy.target.exists(key)).toBe(true);
  });
});
