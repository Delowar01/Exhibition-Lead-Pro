import { pgTable, serial, text, integer, timestamp, doublePrecision, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { contactsTable } from "./contacts";
import { eventsTable } from "./events";

export const scansTable = pgTable("scans", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  contactId: integer("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
  imageUrl: text("image_url"),
  status: text("status").notNull().default("pending"), // pending, processing, completed, failed
  extractedData: text("extracted_data"), // JSON
  rawOcr: text("raw_ocr"),
  confidence: integer("confidence"), // 0-100 AI extraction confidence
  // ── Stage 5E Intelligent Capture Engine metadata (all additive + nullable) ──
  fieldConfidences: text("field_confidences"), // JSON map field->0-100 per-field OCR confidence
  extractionMethod: text("extraction_method"), // ai_vision | qr | vcard | nfc | manual
  captureSource: text("capture_source"), // camera | qr | vcard | digital_card | email_signature | nfc | manual
  aiModel: text("ai_model"), // model that produced the extraction (provenance)
  promptVersion: integer("prompt_version"), // extraction prompt version (provenance)
  processingTimeMs: integer("processing_time_ms"), // OCR round-trip latency
  validationStatus: text("validation_status"), // JSON deterministic validation summary
  qualityScore: integer("quality_score"), // 0-100 on-device capture-quality heuristic (mobile)
  qualityMeta: text("quality_meta"), // JSON on-device quality signals (brightness/sharpness/coverage)
  // ── Interaction model (Task: Contact vs Interaction) — every scan/capture is a
  // permanent interaction attached to a contact. All additive + nullable.
  eventId: integer("event_id").references(() => eventsTable.id, { onDelete: "set null" }), // exhibition/event where the capture happened
  latitude: doublePrecision("latitude"), // GPS at capture time (nullable when unavailable)
  longitude: doublePrecision("longitude"),
  gpsAccuracy: doublePrecision("gps_accuracy"), // meters
  notes: text("notes"), // notes entered at capture time
  aiSummary: text("ai_summary"), // optional AI summary of the interaction
  createdAt: timestamp("created_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker (parity with contacts)
}, (t) => [
  index("scans_company_id_idx").on(t.companyId),
  index("scans_user_id_idx").on(t.userId),
  index("scans_contact_id_idx").on(t.contactId),
  index("scans_event_id_idx").on(t.eventId),
  index("scans_created_at_idx").on(t.createdAt),
]);

export const insertScanSchema = createInsertSchema(scansTable).omit({ id: true, createdAt: true });
export type InsertScan = z.infer<typeof insertScanSchema>;
export type Scan = typeof scansTable.$inferSelect;
