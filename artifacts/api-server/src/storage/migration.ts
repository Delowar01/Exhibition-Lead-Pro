// =============================================================================
// Batch 25 — legacy (GCS) → primary (filesystem) migration core.
//
// Pure orchestration over the StorageDriver contract and an inventory adapter,
// so the whole state machine is unit-tested with in-memory drivers and never
// needs a bucket. The command in scripts/migrate-storage.ts wires the real
// drivers and the storage_objects table around it.
//
//   dry-run  discover every DB-referenced legacy object, register it in the
//            inventory (idempotent), and report what exists / is missing /
//            would be copied — no bytes move.
//   copy     bounded-concurrency copy of each not-yet-migrated object into the
//            target, read-back verification (size + SHA-256), inventory update.
//            Resumable: rows already migrated are detected and skipped; a
//            target object that already exists is compared with the source and
//            adopted only when it matches — a conflicting local object is
//            NEVER overwritten (reported instead).
//   verify   prove every migrated object exists in the target and matches the
//            inventory digest; rows still on the legacy driver are reported as
//            not_migrated.
//
// Nothing here deletes a source object. Tombstoned inventory rows are skipped
// (never resurrected). The summary carries ids, kinds, counts and error codes
// only — never keys, paths, bucket names or file contents.
// =============================================================================
import { createHash, randomUUID } from "node:crypto";
import { Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { InsertStorageObject, StorageObjectRow } from "@workspace/db";
import { StorageError, type StorageDriver } from "./contract.js";
import { tenantKey, type StorageKind } from "./keys.js";
import { bump } from "./metrics.js";

export type MigrationMode = "dry-run" | "copy" | "verify";

export type MigrationItemStatus =
  | "planned"
  | "copied"
  | "already"
  | "verified"
  | "not_migrated"
  | "missing_source"
  | "checksum_mismatch"
  | "conflict"
  | "failed"
  | "skipped";

const OK_STATUSES: ReadonlySet<MigrationItemStatus> = new Set(["planned", "copied", "already", "verified", "skipped"]);

export interface MigrationCandidate {
  companyId: number;
  kind: StorageKind;
  entityType: string;
  entityId: number;
  /** The feature-column value (objectPath / imageUrl / brandLogoKey). */
  reference: string;
  /** Resolved legacy location (`gs://bucket/object`) or null when unattributable. */
  legacyKey: string | null;
  contentType: string | null;
}

export interface MigrationItem {
  objectId: string;
  companyId: number;
  kind: string;
  status: MigrationItemStatus;
  code?: string;
}

export interface InventoryAdapter {
  /** Register a discovered legacy reference (idempotent). Null when the reference is tombstoned. */
  register(candidate: MigrationCandidate, row: { id: string; storageKey: string }): Promise<StorageObjectRow | null>;
  /** Active rows with a legacy location, ordered by id, strictly after `afterId`. */
  listPending(afterId: string | null, limit: number): Promise<StorageObjectRow[]>;
  update(id: string, patch: Partial<InsertStorageObject>): Promise<void>;
}

export interface MigrationOptions {
  mode: MigrationMode;
  /** Legacy driver; may be null in verify mode. */
  source: StorageDriver | null;
  target: StorageDriver;
  inventory: InventoryAdapter;
  discover: () => Promise<{ candidates: MigrationCandidate[]; unattributable: number }>;
  /** Plaintext ceilings per kind (bytes). */
  limits: Record<StorageKind, number>;
  concurrency?: number;
  batchSize?: number;
  /** copy mode: read back rows already marked migrated instead of trusting their existence. */
  recheckMigrated?: boolean;
  newId?: () => string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface MigrationSummary {
  mode: MigrationMode;
  targetDriver: string;
  startedAt: string;
  durationMs: number;
  discovered: number;
  registered: number;
  unattributable: number;
  processed: number;
  counts: Record<MigrationItemStatus, number>;
  /** True only when nothing is missing, mismatched, conflicting, failed or (verify) unmigrated. */
  complete: boolean;
  /** Every non-OK item (ids / kinds / codes only). */
  problems: MigrationItem[];
}

function emptyCounts(): Record<MigrationItemStatus, number> {
  return { planned: 0, copied: 0, already: 0, verified: 0, not_migrated: 0, missing_source: 0, checksum_mismatch: 0, conflict: 0, failed: 0, skipped: 0 };
}

/** Stream → plaintext size + SHA-256 (bounded by the driver's own maxBytes). */
export async function digestStream(stream: Readable): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb();
    },
  });
  await pipeline(stream, sink);
  return { sizeBytes: size, sha256: hash.digest("hex") };
}

async function readBack(driver: StorageDriver, key: string, maxBytes: number): Promise<{ sizeBytes: number; sha256: string }> {
  const { stream } = await driver.getStream(key, { maxBytes });
  return digestStream(stream);
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

export async function runMigration(opts: MigrationOptions): Promise<MigrationSummary> {
  const startedAt = new Date();
  const counts = emptyCounts();
  const problems: MigrationItem[] = [];
  const log = opts.log ?? (() => undefined);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 16));
  const batchSize = Math.max(1, opts.batchSize ?? 200);
  const newId = opts.newId ?? randomUUID;

  // 1. Discovery + idempotent registration (never resurrects a tombstone).
  const { candidates, unattributable } = await opts.discover();
  let registered = 0;
  for (const c of candidates) {
    if (!c.legacyKey) continue;
    const id = newId();
    const row = await opts.inventory.register(c, { id, storageKey: tenantKey(c.kind, c.companyId, id) });
    if (row) registered += 1;
  }
  log("migration.discovered", { mode: opts.mode, discovered: candidates.length, registered, unattributable });

  // 2. Process the inventory in id order, batch by batch, with bounded concurrency.
  let after: string | null = null;
  let processed = 0;
  for (;;) {
    const rows = await opts.inventory.listPending(after, batchSize);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;
    await pool(rows, concurrency, async (row) => {
      const item = await processRow(opts, row);
      processed += 1;
      counts[item.status] += 1;
      if (!OK_STATUSES.has(item.status)) problems.push(item);
      log("migration.item", { ...item });
    });
  }

  const complete = problems.length === 0 && unattributable === 0;
  const summary: MigrationSummary = {
    mode: opts.mode,
    targetDriver: opts.target.kind,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    discovered: candidates.length,
    registered,
    unattributable,
    processed,
    counts,
    complete,
    problems,
  };
  log("migration.summary", { ...summary, problems: problems.length });
  return summary;
}

async function processRow(opts: MigrationOptions, row: StorageObjectRow): Promise<MigrationItem> {
  const base = { objectId: row.id, companyId: row.companyId, kind: row.kind };
  if (row.state !== "active") return { ...base, status: "skipped" };
  const kind = row.kind as StorageKind;
  const limit = opts.limits[kind] ?? 100 * 1024 * 1024;
  const { mode, source, target, inventory } = opts;
  const migrated = row.driver === target.kind;

  try {
    if (mode === "verify") {
      if (!migrated) return { ...base, status: "not_migrated" };
      const got = await readBack(target, row.storageKey, limit);
      if ((row.sha256 && got.sha256 !== row.sha256) || (row.sizeBytes != null && got.sizeBytes !== row.sizeBytes)) {
        bump("migrationVerifyFailures");
        return { ...base, status: "checksum_mismatch" };
      }
      return { ...base, status: "verified" };
    }

    if (migrated) {
      if (mode === "dry-run") return { ...base, status: "already" };
      if (opts.recheckMigrated) {
        const got = await readBack(target, row.storageKey, limit);
        if ((row.sha256 && got.sha256 !== row.sha256) || (row.sizeBytes != null && got.sizeBytes !== row.sizeBytes)) {
          bump("migrationVerifyFailures");
          return { ...base, status: "checksum_mismatch" };
        }
        return { ...base, status: "already" };
      }
      if (await target.exists(row.storageKey)) return { ...base, status: "already" };
      // Marked migrated but the target is gone: fall through and copy again.
    }

    if (!row.legacyKey) return { ...base, status: "failed", code: "NO_LEGACY_KEY" };
    if (!source) return { ...base, status: "failed", code: "SOURCE_UNAVAILABLE" };
    const head = await source.head(row.legacyKey);
    if (!head) return { ...base, status: "missing_source" };
    if (mode === "dry-run") return { ...base, status: "planned" };

    // copy mode
    const contentType = row.contentType && row.contentType !== "application/octet-stream" ? row.contentType : head.contentType ?? row.contentType;
    if (await target.exists(row.storageKey)) {
      // A previous run copied the bytes but could not update the inventory, or
      // something else wrote this key: adopt only an exact match.
      const [t, s] = await Promise.all([readBack(target, row.storageKey, limit), readBack(source, row.legacyKey, limit)]);
      if (t.sha256 === s.sha256 && t.sizeBytes === s.sizeBytes && (!row.sha256 || row.sha256 === t.sha256)) {
        await inventory.update(row.id, { driver: target.kind, sha256: t.sha256, sizeBytes: t.sizeBytes, contentType });
        return { ...base, status: "already" };
      }
      bump("migrationVerifyFailures");
      return { ...base, status: "conflict" };
    }

    const { stream } = await source.getStream(row.legacyKey, { maxBytes: limit });
    const put = await target.put(row.storageKey, stream, { contentType, maxBytes: limit });
    const back = await readBack(target, row.storageKey, limit);
    const sourceSizeKnown = head.sizeBytes != null;
    const mismatch =
      back.sha256 !== put.sha256 ||
      back.sizeBytes !== put.sizeBytes ||
      (sourceSizeKnown && head.sizeBytes !== put.sizeBytes) ||
      (!!row.sha256 && row.sha256 !== put.sha256) ||
      (row.sizeBytes != null && row.sizeBytes !== put.sizeBytes);
    if (mismatch) {
      bump("migrationVerifyFailures");
      await target.delete(row.storageKey).catch(() => undefined);
      return { ...base, status: "checksum_mismatch" };
    }
    await inventory.update(row.id, { driver: target.kind, sha256: put.sha256, sizeBytes: put.sizeBytes, contentType });
    return { ...base, status: "copied" };
  } catch (err) {
    return { ...base, status: "failed", code: err instanceof StorageError ? err.code : "ERROR" };
  }
}
