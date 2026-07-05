import { pgTable, serial, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Enterprise Document Management (Stage 3 Phase 3B). Documents are first-class,
// tenant-scoped objects attachable to a Company, Contact, Lead (== Opportunity),
// or Event. File BYTES live in object storage (GCS); only METADATA lives here.
//
// entityType is intentionally an open text column (not a pg enum) so a future
// dedicated Opportunities module can be introduced additively — a new
// "opportunity" value plus a data migration that repoints entityId — without a
// breaking DB migration. Today Lead documents carry both lead- and
// opportunity-category files.
export const documentsTable = pgTable("documents", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  entityType: text("entity_type").notNull(), // company | contact | lead | event
  entityId: integer("entity_id").notNull(),
  name: text("name").notNull(), // display name (defaults to original filename)
  category: text("category").notNull(),
  description: text("description"),
  // Pointer to the latest document_versions.id. Plain integer (not an FK) to
  // avoid a circular FK with document_versions; maintained by the service layer.
  currentVersionId: integer("current_version_id"),
  createdById: integer("created_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker (delete/restore); excluded from reads by default
}, (t) => [
  index("documents_company_id_idx").on(t.companyId),
  index("documents_entity_idx").on(t.companyId, t.entityType, t.entityId),
  index("documents_category_idx").on(t.companyId, t.category),
  index("documents_deleted_at_idx").on(t.deletedAt),
]);

// Immutable version history. Each upload creates a NEW row — versions are never
// overwritten (Quotation V1 → V2 → Final → Signed Copy). companyId is
// denormalized for direct tenant scoping on version reads/downloads.
export const documentVersionsTable = pgTable("document_versions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  documentId: integer("document_id").notNull().references(() => documentsTable.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  label: text("label"), // optional human label, e.g. "Final", "Signed Copy"
  objectPath: text("object_path").notNull(), // normalized /objects/... path in GCS
  fileName: text("file_name").notNull(), // original upload filename
  fileSize: integer("file_size").notNull(), // bytes
  mimeType: text("mime_type").notNull(),
  uploadedById: integer("uploaded_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
}, (t) => [
  index("document_versions_document_id_idx").on(t.documentId),
  index("document_versions_company_id_idx").on(t.companyId),
  // Guarantees monotonic, collision-free version numbers even under concurrent
  // uploads to the same document — two racing addVersion() txns computing the
  // same max+1 cannot both commit; the loser hits this constraint and retries.
  uniqueIndex("document_versions_doc_version_uq").on(t.documentId, t.versionNumber),
]);

export const insertDocumentSchema = createInsertSchema(documentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertDocumentVersionSchema = createInsertSchema(documentVersionsTable).omit({ id: true, uploadedAt: true });
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documentsTable.$inferSelect;
export type DocumentVersion = typeof documentVersionsTable.$inferSelect;
