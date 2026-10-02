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
//   uploading ONE writer holds the upload lease (lease_token / lease_expires_at)
//             and is receiving the bytes; a second writer for the same intent is
//             refused. An expired or lost lease is NEVER reclaimed (B25
//             Correction 2): the row is failed and cleaned by the sweep and the
//             client reserves a fresh object, so no two attempts ever share a
//             row, a primary key or a mirror key. Every writer transition is a
//             CAS fenced by state = uploading + lease_token (staging also needs
//             an unexpired lease).
//   staged    bytes written + verified, not yet bound to a feature row
//             (documents: between the client PUT and POST /documents)
//   active    readable; bound to its feature row
//   deleting  tombstoned; the file removal is still pending/retrying
//   deleted   tombstoned; file removed (or retained in the legacy bucket when
//             OBJECT_STORAGE_LEGACY_DELETE is off — last_error = LEGACY_RETAINED
//             keeps it discoverable). Kept until reconciled_at is set after the
//             late-publication horizon; last_error = OWNERSHIP_UNPROVEN marks a
//             bucket object at the row's key without the row's ownership
//             marker (never deleted automatically, never purged)
//   failed    write failed; never readable
// Provider uncertainty (B25 Correction 4): a tombstone (failed / deleting /
// deleted) whose publication_uncertain_at is set handed at least one request to
// a remote provider (GCS) whose outcome the writer never durably observed; it is
// never reconciled or purged by automation — bounded sweeps keep re-checking
// its persisted locations and remove only an object carrying the row's own
// ownership marker, at the observed generation.
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
    // B25 Correction 1 / 2 — exact location of the strict-mirror copy in the
    // legacy bucket (gs://<bucket>/<canonical key>). The location is RESERVED
    // when the row is created (so a failed attempt's copy is always
    // discoverable for cleanup) but it is readable as a rollback copy ONLY
    // after the fenced, committed row records mirror_state = "ok" — the
    // verified copy of the single attempt that published this row. A failed /
    // absent mirror is never presented as a rollback copy.
    mirrorKey: text("mirror_key"),
    // B25 Correction 1 / 2 — upload lease: exactly one writer may own publication
    // of an upload intent. Set while state = uploading; cleared on stage /
    // failure / tombstone; an expired lease is lost (never reclaimed).
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }), // PLAINTEXT bytes; null until written
    sha256: text("sha256"), // PLAINTEXT SHA-256 (hex); null until written
    state: text("state").notNull().default("pending"),
    // Strict mirror bookkeeping during the hosted transition (null = no mirror).
    mirrorState: text("mirror_state"), // null | ok | failed
    lastError: text("last_error"), // sanitized code only (e.g. LEASE_EXPIRED, MIRROR_FAILED, CLEANUP_PENDING, LEGACY_RETAINED) — never a path, key or message
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    deletedAt: timestamp("deleted_at"),
    // B25 Correction 3 — when a `deleted` tombstone's persisted locations were
    // physically re-checked AFTER the late-publication horizon (created_at +
    // OBJECT_STORAGE_UPLOAD_HARD_LIFETIME_MS + slack), i.e. once no writer can
    // publish a late copy any more. A tombstone is purged only after this is
    // set; never merely because time passed.
    reconciledAt: timestamp("reconciled_at"),
    // B25 Correction 4 — set DURABLY (committed) before the first byte of any
    // request to a remote provider that can commit independently of the
    // client (GCS primary put, strict-mirror put); cleared ONLY by the durable
    // commit of the complete write (staged / active, after every required put
    // returned). A client-side timeout, transport failure or process death
    // leaves it set: the provider may still publish the object later, so the
    // row is never reconciled "once and for all" and never purged while set.
    publicationUncertainAt: timestamp("publication_uncertain_at"),
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
