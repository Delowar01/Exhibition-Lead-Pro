// =============================================================================
// Batch 25 — pre-B25 ("legacy") reference shapes. Pure functions over config:
// where a reference written before the inventory existed lives in the Google
// Cloud bucket, and whether a reference is a native B25 handle. Shared by the
// object manager (reads / deletes), the migration command and company
// deletion, so every path attributes a legacy reference the same way.
// =============================================================================
import { createHash } from "node:crypto";
import { config } from "../config.js";
import type { StorageKind } from "./keys.js";

const HANDLE = /^\/objects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Opaque B25 handle (`/objects/<uuid>`) — always backed by an inventory row. */
export function isNativeHandle(reference: string): boolean {
  return HANDLE.test(reference);
}

/**
 * Where a PRE-B25 reference lives in the legacy bucket (`gs://bucket/object`),
 * or null when the reference is not a legacy shape for this kind / tenant or
 * no bucket is configured. The tenant id embedded in scan / branding keys MUST
 * match the caller's tenant; document / export / report handles are namespaced
 * by the caller's tenant through the inventory and the feature tables.
 */
export function legacyLocation(kind: StorageKind, reference: string, companyId: number): string | null {
  const bucket = config.objectStorage.bucketId;
  if (!bucket || typeof reference !== "string") return null;
  switch (kind) {
    case "document":
    case "export":
    case "report": {
      const m = /^\/objects\/(uploads\/[0-9a-f-]{36})$/.exec(reference);
      if (!m) return null;
      const dir = config.objectStorage.privateObjectDir.replace(/\/+$/, "");
      if (!dir) return null;
      const parts = `${dir}/${m[1]}`.replace(/^\/+/, "").split("/");
      if (parts.length < 2) return null;
      return `gs://${parts[0]}/${parts.slice(1).join("/")}`;
    }
    case "scan_image": {
      const m = /^scans\/(\d+)\/(\d+)\.jpg$/.exec(reference);
      if (!m || Number(m[1]) !== companyId) return null;
      return `gs://${bucket}/${reference}`;
    }
    case "branding_logo": {
      const m = /^branding\/(\d+)\/[0-9a-f]{32}\.(png|jpg|webp)$/.exec(reference);
      if (!m || Number(m[1]) !== companyId) return null;
      return `gs://${bucket}/${reference}`;
    }
  }
}

/** Sanitized identity of a legacy object for reports and logs (never the key itself). */
export function legacyKeyHash(legacyKey: string): string {
  return createHash("sha256").update(legacyKey).digest("hex").slice(0, 16);
}

/** The canonical mirror location of a native object in the legacy bucket. */
export function mirrorLocation(storageKey: string): string | null {
  const bucket = config.objectStorage.bucketId;
  return bucket ? `gs://${bucket}/${storageKey}` : null;
}
