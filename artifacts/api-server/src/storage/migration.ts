// =============================================================================
// Batch 25 — legacy (GCS) → primary (filesystem) migration core.
//
// Pure orchestration over the StorageDriver contract and an inventory adapter,
// so the whole state machine is unit-tested with in-memory drivers and never
// needs a bucket. The command in scripts/migrate-storage.ts wires the real
// drivers and the storage_objects table around it.
//
//   dry-run  READ-ONLY: discover every DB-referenced legacy object, compare it
//            with the existing inventory, and report what would be registered,
//            copied, is already migrated, is missing at the source or is a
//            duplicate — zero inserts, updates, deletes or uploads.
//   copy     the ONLY mutating mode: registers missing references, copies each
//            not-yet-migrated object into the target with bounded concurrency,
//            read-back verification (size + SHA-256) and an inventory update.
//            Resumable: rows already migrated are detected and skipped; a
//            target object that already exists is compared with the source and
//            adopted only when it matches — a conflicting local object is
//            NEVER overwritten (reported instead).
//   verify   READ-ONLY: prove every migrated object exists in the target and
//            matches the inventory digest; report references without a row
//            (unregistered), rows still on the legacy driver (not_migrated),
//            integrity problems and duplicates — zero writes.
//
// Duplicate references (B25 Correction 1): several live feature rows pointing
// at ONE legacy object (two document versions, or an export run and an
// executive report sharing an artifact) are grouped by (company, legacy
// object), reported with a sanitized code and EXCLUDED from registration and
// copy — they block copy / cutover until resolved (the inventory's uniqueness
// constraint would otherwise silently collapse them into one association).
//
// Nothing here deletes a source object. Tombstoned inventory rows are skipped
// (never resurrected). Summaries carry ids, kinds, counts, hashes and error
// codes only — never keys, paths, bucket names or file contents.
// =============================================================================
import { createHash, randomUUID } from "node:crypto";
import { Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { InsertStorageObject, StorageObjectRow } from "@workspace/db";
import { StorageError, type StorageDriver } from "./contract.js";
import { tenantKey, type StorageKind } from "./keys.js";
import { legacyKeyHash } from "./legacy.js";
import { bump } from "./metrics.js";

export type MigrationMode = "dry-run" | "copy" | "verify";

export type MigrationItemStatus =
  | "planned"
  | "copied"
  | "already"
  | "verified"
  | "not_migrated"
  | "unregistered"
  | "missing_source"
  | "checksum_mismatch"
  | "conflict"
  | "duplicate"
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
  entityType?: string;
  entityId?: number;
}

export interface DuplicateGroup {
  code: "DUPLICATE_REFERENCE";
  companyId: number;
  /** sha256 prefix of the shared legacy location — never the key itself. */
  legacyKeyHash: string;
  kinds: string[];
  references: number;
  entities: Array<{ kind: string; entityType: string; entityId: number }>;
}

export interface InventoryAdapter {
  /** Read: the inventory row for a (company, kind, reference), or null. */
  findByReference(companyId: number, kind: StorageKind, reference: string): Promise<StorageObjectRow | null>;
  /** Mutating (copy mode only): register a discovered legacy reference (idempotent). Null when tombstoned. */
  register(candidate: MigrationCandidate, row: { id: string; storageKey: string }): Promise<StorageObjectRow | null>;
  /** Read: active rows with a legacy location, ordered by id, strictly after `afterId`. */
  listPending(afterId: string | null, limit: number): Promise<StorageObjectRow[]>;
  /** Mutating (copy mode only). */
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
  /** Feature-row references found (including duplicates). */
  sourceReferences: number;
  /** Distinct legacy objects behind those references. */
  uniqueObjects: number;
  /** @deprecated alias of sourceReferences (kept for the first B25 report format). */
  discovered: number;
  registered: number;
  registrationsPlanned: number;
  unattributable: number;
  processed: number;
  counts: Record<MigrationItemStatus, number>;
  duplicateGroups: DuplicateGroup[];
  /** True only when nothing is missing, mismatched, conflicting, duplicated, failed or (verify) unregistered / unmigrated. */
  complete: boolean;
  /** Every non-OK item (ids / kinds / codes only). */
  problems: MigrationItem[];
}

function emptyCounts(): Record<MigrationItemStatus, number> {
  return { planned: 0, copied: 0, already: 0, verified: 0, not_migrated: 0, unregistered: 0, missing_source: 0, checksum_mismatch: 0, conflict: 0, duplicate: 0, failed: 0, skipped: 0 };
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

/**
 * Group discovered references by (company, legacy object). Groups with more
 * than one feature reference are duplicates: reported and excluded.
 */
export function groupDuplicates(candidates: MigrationCandidate[]): { unique: MigrationCandidate[]; duplicates: DuplicateGroup[]; duplicateCandidates: MigrationCandidate[]; uniqueObjects: number } {
  const byObject = new Map<string, MigrationCandidate[]>();
  for (const c of candidates) {
    if (!c.legacyKey) continue;
    const k = `${c.companyId}|${c.legacyKey}`;
    const list = byObject.get(k) ?? [];
    list.push(c);
    byObject.set(k, list);
  }
  const unique: MigrationCandidate[] = [];
  const duplicates: DuplicateGroup[] = [];
  const duplicateCandidates: MigrationCandidate[] = [];
  for (const list of byObject.values()) {
    if (list.length === 1) {
      unique.push(list[0]);
      continue;
    }
    duplicateCandidates.push(...list);
    duplicates.push({
      code: "DUPLICATE_REFERENCE",
      companyId: list[0].companyId,
      legacyKeyHash: legacyKeyHash(list[0].legacyKey!),
      kinds: [...new Set(list.map((c) => c.kind))],
      references: list.length,
      entities: list.map((c) => ({ kind: c.kind, entityType: c.entityType, entityId: c.entityId })),
    });
  }
  return { unique, duplicates, duplicateCandidates, uniqueObjects: byObject.size };
}

export async function runMigration(opts: MigrationOptions): Promise<MigrationSummary> {
  const startedAt = new Date();
  const counts = emptyCounts();
  const problems: MigrationItem[] = [];
  const log = opts.log ?? (() => undefined);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 16));
  const batchSize = Math.max(1, opts.batchSize ?? 200);
  const newId = opts.newId ?? randomUUID;
  const { mode } = opts;

  // 1. Discovery (pure) + duplicate grouping.
  const { candidates, unattributable } = await opts.discover();
  const grouped = groupDuplicates(candidates);
  for (const c of grouped.duplicateCandidates) {
    counts.duplicate += 1;
    problems.push({ objectId: "", companyId: c.companyId, kind: c.kind, status: "duplicate", code: "DUPLICATE_REFERENCE", entityType: c.entityType, entityId: c.entityId });
  }

  // 2. Registration — copy mode mutates; dry-run / verify only read and plan.
  let registered = 0;
  let registrationsPlanned = 0;
  const candidateByRef = new Map<string, MigrationCandidate>();
  for (const c of grouped.unique) {
    if (!c.legacyKey) continue;
    candidateByRef.set(`${c.companyId}|${c.kind}|${c.reference}`, c);
    const existing = await opts.inventory.findByReference(c.companyId, c.kind, c.reference);
    if (existing) continue;
    if (mode === "copy") {
      const id = newId();
      const row = await opts.inventory.register(c, { id, storageKey: tenantKey(c.kind, c.companyId, id) });
      if (row) registered += 1;
    } else {
      registrationsPlanned += 1;
      if (mode === "verify") {
        counts.unregistered += 1;
        problems.push({ objectId: "", companyId: c.companyId, kind: c.kind, status: "unregistered", entityType: c.entityType, entityId: c.entityId });
      } else {
        // dry-run: plan the registration + the copy from the source's point of view
        const item = await planUnregistered(opts, c);
        counts[item.status] += 1;
        if (!OK_STATUSES.has(item.status)) problems.push(item);
      }
    }
  }
  log("migration.discovered", { mode, sourceReferences: candidates.length, uniqueObjects: grouped.uniqueObjects, duplicateGroups: grouped.duplicates.length, registered, registrationsPlanned, unattributable });

  // 3. Process inventory rows in id order, batch by batch, with bounded concurrency.
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

  const complete = problems.length === 0 && unattributable === 0 && grouped.duplicates.length === 0;
  const summary: MigrationSummary = {
    mode,
    targetDriver: opts.target.kind,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    sourceReferences: candidates.length,
    uniqueObjects: grouped.uniqueObjects,
    discovered: candidates.length,
    registered,
    registrationsPlanned,
    unattributable,
    processed,
    counts,
    duplicateGroups: grouped.duplicates,
    complete,
    problems,
  };
  log("migration.summary", { ...summary, problems: problems.length, duplicateGroups: grouped.duplicates.length });
  return summary;
}

/** dry-run: what would happen to a reference that has no inventory row yet (reads only). */
async function planUnregistered(opts: MigrationOptions, c: MigrationCandidate): Promise<MigrationItem> {
  const base = { objectId: "", companyId: c.companyId, kind: c.kind, entityType: c.entityType, entityId: c.entityId };
  if (!opts.source) return { ...base, status: "failed", code: "SOURCE_UNAVAILABLE" };
  try {
    const head = await opts.source.head(c.legacyKey!);
    return head ? { ...base, status: "planned" } : { ...base, status: "missing_source" };
  } catch (err) {
    return { ...base, status: "failed", code: err instanceof StorageError ? err.code : "ERROR" };
  }
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

    // copy mode (the only mutating mode)
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
