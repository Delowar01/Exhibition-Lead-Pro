// =============================================================================
// Batch 25 — database side of the migration command and of company deletion:
// discovery of every DB-referenced legacy object (documents + versions, export
// runs, executive reports, scan images, branding logos) with tenant / entity
// attribution, and the storage_objects-backed inventory adapter. Pure SQL +
// attribution (reads only); the copy/verify state machine lives in
// migration.ts and the ONLY mutating adapter methods are called in copy mode.
// =============================================================================
import { db, documentVersionsTable, exportRunsTable, executiveReportsTable, scansTable, companiesTable } from "@workspace/db";
import { and, eq, isNotNull, type SQL } from "drizzle-orm";
import * as repo from "../repositories/storage-objects.repository.js";
import { exec, type Executor } from "../repositories/base.js";
import { isNativeHandle, legacyLocation } from "./legacy.js";
import type { InventoryAdapter, MigrationCandidate } from "./migration.js";
import type { StorageKind } from "./keys.js";

export interface DiscoverOptions {
  /** Restrict discovery to one tenant (company deletion). */
  companyId?: number;
  tx?: Executor;
}

/**
 * Every legacy-shaped reference still stored on a feature row, attributed to
 * its tenant and entity. Duplicates (several rows → one object) are returned
 * as separate candidates; migration.ts groups and reports them.
 */
export async function discoverLegacyReferences(opts: DiscoverOptions = {}): Promise<{ candidates: MigrationCandidate[]; unattributable: number }> {
  const x = exec(opts.tx);
  const candidates: MigrationCandidate[] = [];
  let unattributable = 0;
  const add = (kind: StorageKind, companyId: number, entityType: string, entityId: number, reference: string | null, contentType: string | null) => {
    if (!reference || isNativeHandle(reference)) return; // native B25 handles already have inventory rows
    const legacyKey = legacyLocation(kind, reference, companyId);
    if (!legacyKey) {
      unattributable += 1;
      return;
    }
    candidates.push({ companyId, kind, entityType, entityId, reference, legacyKey, contentType });
  };
  const scoped = (cond: SQL, companyCol: typeof documentVersionsTable.companyId | typeof exportRunsTable.companyId | typeof executiveReportsTable.companyId | typeof scansTable.companyId) =>
    opts.companyId === undefined ? cond : and(cond, eq(companyCol, opts.companyId));

  for (const v of await x
    .select({ id: documentVersionsTable.id, companyId: documentVersionsTable.companyId, objectPath: documentVersionsTable.objectPath, mimeType: documentVersionsTable.mimeType })
    .from(documentVersionsTable)
    .where(scoped(isNotNull(documentVersionsTable.objectPath), documentVersionsTable.companyId))) {
    add("document", v.companyId, "document_version", v.id, v.objectPath, v.mimeType);
  }
  for (const r of await x
    .select({ id: exportRunsTable.id, companyId: exportRunsTable.companyId, objectPath: exportRunsTable.objectPath })
    .from(exportRunsTable)
    .where(scoped(isNotNull(exportRunsTable.objectPath), exportRunsTable.companyId))) {
    add("export", r.companyId, "export_run", r.id, r.objectPath, null);
  }
  for (const r of await x
    .select({ id: executiveReportsTable.id, companyId: executiveReportsTable.companyId, objectPath: executiveReportsTable.objectPath })
    .from(executiveReportsTable)
    .where(scoped(isNotNull(executiveReportsTable.objectPath), executiveReportsTable.companyId))) {
    add("report", r.companyId, "executive_report", r.id, r.objectPath, null);
  }
  for (const s of await x
    .select({ id: scansTable.id, companyId: scansTable.companyId, imageUrl: scansTable.imageUrl })
    .from(scansTable)
    .where(scoped(isNotNull(scansTable.imageUrl), scansTable.companyId))) {
    add("scan_image", s.companyId, "scan", s.id, s.imageUrl, "image/jpeg");
  }
  const companyCond = opts.companyId === undefined ? isNotNull(companiesTable.brandLogoKey) : and(isNotNull(companiesTable.brandLogoKey), eq(companiesTable.id, opts.companyId));
  for (const c of await x
    .select({ id: companiesTable.id, brandLogoKey: companiesTable.brandLogoKey, brandLogoContentType: companiesTable.brandLogoContentType })
    .from(companiesTable)
    .where(companyCond)) {
    add("branding_logo", c.id, "company", c.id, c.brandLogoKey, c.brandLogoContentType);
  }
  return { candidates, unattributable };
}

/** storage_objects-backed inventory for the migration core. */
export function dbInventoryAdapter(): InventoryAdapter {
  return {
    async findByReference(companyId, kind, reference) {
      return (await repo.findByReference(companyId, kind, reference)) ?? null;
    },
    async register(c, { id, storageKey }) {
      const row = await repo.insertIfAbsent({
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
      });
      return row.state === "active" ? row : null;
    },
    listPending: (afterId, limit) => repo.listMigratable(afterId, limit),
    async update(id, patch) {
      await repo.update(id, patch);
    },
  };
}

export { db };
