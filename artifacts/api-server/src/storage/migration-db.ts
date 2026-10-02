// =============================================================================
// Batch 25 — database side of the migration command: discovery of every
// DB-referenced legacy object (documents + versions, export runs, executive
// reports, scan images, branding logos) with tenant / entity attribution, and
// the storage_objects-backed inventory adapter. Pure SQL + attribution; the
// copy/verify state machine lives in migration.ts.
// =============================================================================
import { db, documentVersionsTable, exportRunsTable, executiveReportsTable, scansTable, companiesTable } from "@workspace/db";
import { isNotNull } from "drizzle-orm";
import * as repo from "../repositories/storage-objects.repository.js";
import { isNativeHandle, legacyLocation } from "../services/storage.service.js";
import type { InventoryAdapter, MigrationCandidate } from "./migration.js";
import type { StorageKind } from "./keys.js";

/** Every legacy-shaped reference still stored on a feature row, attributed to its tenant and entity. */
export async function discoverLegacyReferences(): Promise<{ candidates: MigrationCandidate[]; unattributable: number }> {
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

  for (const v of await db.select({ id: documentVersionsTable.id, companyId: documentVersionsTable.companyId, objectPath: documentVersionsTable.objectPath, mimeType: documentVersionsTable.mimeType }).from(documentVersionsTable)) {
    add("document", v.companyId, "document_version", v.id, v.objectPath, v.mimeType);
  }
  for (const r of await db.select({ id: exportRunsTable.id, companyId: exportRunsTable.companyId, objectPath: exportRunsTable.objectPath }).from(exportRunsTable).where(isNotNull(exportRunsTable.objectPath))) {
    add("export", r.companyId, "export_run", r.id, r.objectPath, null);
  }
  for (const r of await db.select({ id: executiveReportsTable.id, companyId: executiveReportsTable.companyId, objectPath: executiveReportsTable.objectPath }).from(executiveReportsTable).where(isNotNull(executiveReportsTable.objectPath))) {
    add("report", r.companyId, "executive_report", r.id, r.objectPath, null);
  }
  for (const s of await db.select({ id: scansTable.id, companyId: scansTable.companyId, imageUrl: scansTable.imageUrl }).from(scansTable).where(isNotNull(scansTable.imageUrl))) {
    add("scan_image", s.companyId, "scan", s.id, s.imageUrl, "image/jpeg");
  }
  for (const c of await db.select({ id: companiesTable.id, brandLogoKey: companiesTable.brandLogoKey, brandLogoContentType: companiesTable.brandLogoContentType }).from(companiesTable).where(isNotNull(companiesTable.brandLogoKey))) {
    add("branding_logo", c.id, "company", c.id, c.brandLogoKey, c.brandLogoContentType);
  }
  return { candidates, unattributable };
}

/** storage_objects-backed inventory for the migration core. */
export function dbInventoryAdapter(): InventoryAdapter {
  return {
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
