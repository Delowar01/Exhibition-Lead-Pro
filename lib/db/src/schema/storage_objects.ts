import { pgTable, uuid, text, integer, bigint, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

// Batch 25 — durable object-storage inventory. One row per product file
// (document version, export file, executive report file, scan image, branding
// logo). The feature tables keep their existing reference columns
// (document_versions.object_path, export_runs.object_path,
// executive_reports.object_path, scans.image_url, companies.brand_logo_key);
// this table says WHERE those references live, WHO owns them and WHETHER they
// still exist. It is additive: nothing in the feature tables changed.
//
// State machine:
//   pending   reserved (upload link minted / write in progress); no bytes yet
//   uploading one writer holds the upload lease (lease_token / lease_expires_at)
//             and is receiving the bytes; a second writer for the same intent is
//             refused; an expired lease is reclaimable (B25 Correction 1)
//   staged    bytes written + verified, not yet bound to a feature row
//             (documents: between the client PUT and POST /documents)
//   active    readable; bound to its feature row
//   deleting  tombstoned; the file removal is still pending/retrying
//   deleted   tombstoned; file removed (or retained in the legacy bucket when
//             OBJECT_STORAGE_LEGACY_DELETE is off — last_error = LEGACY_RETAINED
//             keeps it discoverable)
//   failed    write failed; never readable
// Only `active` rows are ever served. A tombstoned reference (deleting /
// deleted / failed) is NEVER served from the legacy driver either, which is
// what prevents a deleted object from reappearing through the GCS fallback.
//
// company_id intentionally carries NO foreign key: tombstones must outlive a
// deleted company until the purge job has removed their files.
export const storageObjectsTable = pgTable(
  "storage_objects",
  {
    id: uuid("id").primaryKey(), // unpredictable, application-generated (randomUUID)
    companyId: integer("company_id").notNull(), // tenant boundary (no FK — see above)
    kind: text("kind").notNull(), // document | export | report | scan_image | branding_logo
    entityType: text("entity_type"), // document_version | export_run | executive_report | scan | company
    entityId: integer("entity_id"),
    // The value the owning feature column stores (opaque handle such as
    // /objects/<uuid>, or a legacy key such as scans/<cid>/<id>.jpg).
    reference: text("reference").notNull(),
    // Canonical driver key: tenants/<companyId>/<kind dir>/<id>[.<ext>].
    storageKey: text("storage_key").notNull(),
    driver: text("driver").notNull(), // fs | gcs | memory
    // Where the bytes live in Google Cloud Storage while the object has not been
    // migrated (gs://<bucket>/<object>). Null for objects written natively.
    // Kept after migration: it is the verified ROLLBACK copy.
    legacyKey: text("legacy_key"),
    // B25 Correction 1 — exact location of the strict-mirror copy in the legacy
    // bucket (gs://<bucket>/<canonical key>), set only after the mirror write
    // succeeded. A rollback to the GCS driver reads it; a failed/absent mirror
    // leaves it null and is never presented as a rollback copy.
    mirrorKey: text("mirror_key"),
    // B25 Correction 1 — upload lease: exactly one writer may own publication of
    // an upload intent. Set while state = uploading; cleared on stage/failure;
    // an expired lease (lease_expires_at < now) is reclaimable.
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }), // PLAINTEXT bytes; null until written
    sha256: text("sha256"), // PLAINTEXT SHA-256 (hex); null until written
    state: text("state").notNull().default("pending"),
    // Strict mirror bookkeeping during the hosted transition (null = no mirror).
    mirrorState: text("mirror_state"), // null | ok | failed
    lastError: text("last_error"), // sanitized code/message only — never a path
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    // A reference is unique within a tenant and kind (resolution key).
    uniqueIndex("storage_objects_company_kind_reference_uq").on(t.companyId, t.kind, t.reference),
    index("storage_objects_company_idx").on(t.companyId),
    index("storage_objects_state_updated_idx").on(t.state, t.updatedAt),
    index("storage_objects_entity_idx").on(t.entityType, t.entityId),
  ],
);

export type StorageObjectRow = typeof storageObjectsTable.$inferSelect;
export type InsertStorageObject = typeof storageObjectsTable.$inferInsert;
