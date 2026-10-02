import * as storage from "../services/storage.service.js";

// Stage 4B / Batch 25 — Export Center + executive-report storage helper. Export
// files are produced SERVER-SIDE, so the generated buffer is written straight
// through the object-storage boundary (inventory row → encrypted bytes →
// activation). Only the opaque `/objects/...` handle is persisted on the
// feature row (export_runs.objectPath / executive_reports.objectPath); the
// bytes live in the configured object store.
export interface StoredExport {
  objectPath: string;
  objectId: string;
  sizeBytes: number;
  sha256: string;
}

export async function uploadExportBuffer(
  buffer: Buffer,
  contentType: string,
  owner: { companyId: number; kind: "export" | "report"; entityType?: string; entityId?: number },
): Promise<StoredExport> {
  const stored = await storage.storeBuffer({
    companyId: owner.companyId,
    kind: owner.kind,
    contentType,
    buffer,
    entityType: owner.entityType,
    entityId: owner.entityId,
  });
  return { objectPath: stored.reference, objectId: stored.objectId, sizeBytes: stored.sizeBytes, sha256: stored.sha256 };
}

// Mint a short-lived download capability URL for a produced file. Null when the
// object no longer exists (tombstoned, never written, or a legacy object that
// the fallback cannot serve) — callers answer 404 / omit the link.
export async function exportDownloadURL(
  base: string,
  ref: { companyId: number; kind: "export" | "report"; objectPath: string; userId: number | null; fileName?: string | null },
  ttlSec?: number,
): Promise<string | null> {
  return storage.mintDownloadUrl(base, {
    companyId: ref.companyId,
    kind: ref.kind,
    reference: ref.objectPath,
    userId: ref.userId,
    fileName: ref.fileName ?? undefined,
    disposition: "attachment",
    ttlSec,
  });
}

/** Tombstone a produced file whose feature row could not be committed (never leaves bytes untracked). */
export async function discardExportObject(ref: { companyId: number; kind: "export" | "report"; objectPath: string }): Promise<void> {
  await storage.deleteByReference({ companyId: ref.companyId, kind: ref.kind, reference: ref.objectPath });
}
