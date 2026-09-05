import * as XLSX from "xlsx";
import { db } from "@workspace/db";
import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as contactsRepo from "../repositories/contacts.repository.js";
import * as leadsRepo from "../repositories/leads.repository.js";
import * as customFieldsRepo from "../repositories/custom_fields.repository.js";
import * as pipelineRepo from "../repositories/pipeline_stages.repository.js";
import * as subscriptionsRepo from "../repositories/subscriptions.repository.js";
import { buildContactDupeMatcher } from "./contacts.service.js";
import * as customFields from "./custom_fields.service.js";
import { ensureStages } from "./pipeline.service.js";
import { stageOutcome } from "./leads.service.js";
import type { CustomFieldDefinitionRow } from "../repositories/custom_fields.repository.js";
import {
  standardFields,
  inferMapping,
  coerceStandardValue,
  type ImportEntityType,
  type ImportFieldDef,
} from "../lib/import-fields.js";
import { enqueueWorkflowRuns, persistWorkflowRuns } from "../lib/workflows/dispatch.js";
import { contactCreatedEvent, leadCreatedEvent } from "../lib/workflows/events.js";

// Stage 4B — Import & Export Center (import side). Stateless three-step pipeline:
// preview (parse → columns + auto-mapping + field catalog), validate (apply a
// mapping → per-row errors + duplicate detection, no persistence), commit
// (transactional bulk insert reusing the real dedupe + custom-field validators).
// No fabricated data: every value comes from the uploaded file; unmapped fields
// stay empty and AI lead-scoring is intentionally deferred (scored later on demand).

const MAX_ROWS = 5000;
const SAMPLE_ROWS = 5;

function assertEntityType(v: unknown): ImportEntityType {
  if (v !== "contact" && v !== "lead") throw new AppError(400, "entityType must be 'contact' or 'lead'");
  return v;
}

// Decode the uploaded file (base64, optionally a data: URL) and parse the first
// sheet into a header row + object rows. Handles CSV and XLSX uniformly via SheetJS.
function parseWorkbook(fileBase64: string): { columns: string[]; rows: Record<string, string>[] } {
  if (typeof fileBase64 !== "string" || fileBase64.trim() === "") throw new AppError(400, "file is required");
  const cleaned = fileBase64.includes(",") ? fileBase64.slice(fileBase64.indexOf(",") + 1) : fileBase64;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(cleaned, "base64");
  } catch {
    throw new AppError(400, "file must be valid base64");
  }
  if (buffer.length === 0) throw new AppError(400, "file is empty");

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
  } catch {
    throw new AppError(400, "could not parse file — expected CSV or Excel (.xlsx)");
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new AppError(400, "the file has no sheets");
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false });
  if (matrix.length === 0) throw new AppError(400, "the file has no rows");

  const headerRow = (matrix[0] ?? []).map((h) => String(h ?? "").trim());
  const columns: string[] = [];
  const seen = new Set<string>();
  headerRow.forEach((h, i) => {
    let name = h || `Column ${i + 1}`;
    while (seen.has(name)) name = `${name}_${i}`;
    seen.add(name);
    columns.push(name);
  });

  const dataRows = matrix.slice(1);
  if (dataRows.length > MAX_ROWS) throw new AppError(400, `too many rows (${dataRows.length}); the limit is ${MAX_ROWS} per import`);

  const rows: Record<string, string>[] = [];
  for (const r of dataRows) {
    const obj: Record<string, string> = {};
    let hasValue = false;
    columns.forEach((col, i) => {
      const cell = String((r as string[])[i] ?? "").trim();
      obj[col] = cell;
      if (cell !== "") hasValue = true;
    });
    if (hasValue) rows.push(obj);
  }
  return { columns, rows };
}

// Build the field catalog exposed to the mapping UI: standard fields plus this
// company's custom fields (keyed "cf:<id>").
function customFieldKey(id: number): string {
  return `cf:${id}`;
}

async function loadCustomDefs(companyId: number, entityType: ImportEntityType): Promise<CustomFieldDefinitionRow[]> {
  // Custom fields only exist for "contact"/"lead" entity types, which match ours.
  return customFields.importDefinitions(companyId, entityType);
}

function fieldCatalog(entityType: ImportEntityType, customDefs: CustomFieldDefinitionRow[]) {
  const std = standardFields(entityType).map((f) => ({ key: f.key, label: f.label, type: f.type, required: false, custom: false }));
  const custom = customDefs.map((d) => ({ key: customFieldKey(d.id), label: d.label, type: d.fieldType, required: d.required, custom: true }));
  return [...std, ...custom];
}

export async function preview(user: AuthUser, body: { entityType?: unknown; file?: unknown }) {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const entityType = assertEntityType(body.entityType);
  const { columns, rows } = parseWorkbook(String(body.file ?? ""));
  const customDefs = await loadCustomDefs(companyId, entityType);

  // Auto-map against standard aliases first; then custom fields by label/key.
  const stdFieldDefs = standardFields(entityType);
  const customAsFields: ImportFieldDef[] = customDefs.map((d) => ({
    key: customFieldKey(d.id),
    label: d.label,
    type: "text",
    aliases: [d.fieldKey, d.label],
  }));
  const mapping = inferMapping(columns, [...stdFieldDefs, ...customAsFields]);

  return {
    entityType,
    columns,
    rowCount: rows.length,
    sampleRows: rows.slice(0, SAMPLE_ROWS),
    inferredMapping: mapping,
    availableFields: fieldCatalog(entityType, customDefs),
  };
}

interface MappingInput { [column: string]: string | null; }

interface BuiltRow {
  index: number; // 1-based data row number
  record: Record<string, string | null>;
  customValues: Array<{ definitionId: number; value: string }>;
  errors: string[];
  duplicateOfExistingId: number | null;
  duplicateReason: string | null;
  // A hard integrity conflict that must NEVER be inserted, regardless of
  // skipDuplicates. Unlike a contact "duplicate" (which can be legitimately linked
  // to its original when skipDuplicates=false), a lead whose contact already has an
  // active lead would violate the single-active-lead-per-contact invariant enforced
  // by leads.service#createLead.
  hardConflict: boolean;
}

interface BuildContext {
  entityType: ImportEntityType;
  companyId: number;
  rows: Record<string, string>[];
  mapping: MappingInput;
  customDefs: CustomFieldDefinitionRow[];
  // Configured stage flags (key → isWon/isLost) so lead-import dedup shares the
  // CANONICAL open/closed rule (custom terminal stages count as closed too).
  configuredStageFlags: Map<string, { isWon: boolean; isLost: boolean }>;
}

function normalizeMapping(raw: unknown): MappingInput {
  if (!raw || typeof raw !== "object") throw new AppError(400, "mapping is required");
  const out: MappingInput = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = v == null || v === "" ? null : String(v);
  }
  return out;
}

// Shared row builder used by validate + commit. Applies the mapping, coerces +
// validates every mapped value (standard via coerceStandardValue, custom via the
// real custom-field validator), enforces per-row identity requirements, and runs
// duplicate detection (contacts: reuse the scan-time matcher; leads: one-active-
// lead-per-contact invariant). Pure of persistence.
async function buildRows(ctx: BuildContext): Promise<{ built: BuiltRow[]; unmappedRequiredCustom: string[] }> {
  const stdByKey = new Map(standardFields(ctx.entityType).map((f) => [f.key, f]));
  const customById = new Map(ctx.customDefs.map((d) => [customFieldKey(d.id), d]));

  // A required custom field that no column maps to (and has no default) fails the
  // whole batch — every row would be missing it.
  const mappedFieldKeys = new Set(Object.values(ctx.mapping).filter((v): v is string => v != null));
  const unmappedRequiredCustom = ctx.customDefs
    .filter((d) => d.required && !(d.defaultValue && d.defaultValue !== "") && !mappedFieldKeys.has(customFieldKey(d.id)))
    .map((d) => d.label);

  const built: BuiltRow[] = [];

  // Contact dedupe matcher (existing originals + intra-file). Leads use contact
  // active-lead lookups instead (below).
  const contactMatcher = ctx.entityType === "contact" ? await buildContactDupeMatcher(ctx.companyId) : null;

  // Lead prep: resolve contactEmail → existing contactId and detect contacts that
  // already carry an active (non-lost) lead so we never create a second one.
  let leadContactByEmail = new Map<string, number>();
  const leadContactsWithActive = new Set<number>();
  if (ctx.entityType === "lead") {
    const emails = new Set<string>();
    for (const r of ctx.rows) {
      for (const [col, fk] of Object.entries(ctx.mapping)) {
        if (fk === "contactEmail") {
          const v = String(r[col] ?? "").trim().toLowerCase();
          if (v) emails.add(v);
        }
      }
    }
    if (emails.size > 0) {
      leadContactByEmail = await leadsRepo.contactIdsByEmails(ctx.companyId, [...emails]);
      for (const cid of leadContactByEmail.values()) {
        const active = await leadsRepo.activeLeadIdForContact(ctx.companyId, cid);
        if (active !== undefined) leadContactsWithActive.add(cid);
      }
    }
  }

  const seenActiveLeadContacts = new Set<number>();

  ctx.rows.forEach((raw, i) => {
    const record: Record<string, string | null> = {};
    const customValues: Array<{ definitionId: number; value: string }> = [];
    const errors: string[] = [];

    for (const [col, fk] of Object.entries(ctx.mapping)) {
      if (!fk) continue;
      const cell = String(raw[col] ?? "");
      const cdef = customById.get(fk);
      if (cdef) {
        const res = customFields.validateImportValue(cdef, cell.trim() === "" ? null : cell.trim());
        if (!res.ok) errors.push(res.error);
        else if (res.value != null) customValues.push({ definitionId: cdef.id, value: res.value });
        continue;
      }
      const sdef = stdByKey.get(fk);
      if (!sdef) continue; // unknown field key — ignore
      const res = coerceStandardValue(sdef, cell);
      if (!res.ok) errors.push(res.error ?? `${sdef.label}: invalid`);
      else record[fk] = res.value;
    }

    // Resolve the row's FINAL custom-field state (parity with custom_fields.service
    // setValues): apply configured defaults for unset fields and enforce required
    // custom fields per row. Doing this here means commit inserts a complete,
    // fully-validated set inside its transaction — no out-of-band writes. A required
    // custom field that is mapped but empty for this row becomes a row error (the
    // row is skipped); the unmapped-required case is handled at batch level above.
    const providedCustomIds = new Set(customValues.map((c) => c.definitionId));
    for (const cdef of ctx.customDefs) {
      if (providedCustomIds.has(cdef.id)) continue;
      if (cdef.defaultValue != null && cdef.defaultValue !== "") {
        const dres = customFields.validateImportValue(cdef, cdef.defaultValue);
        if (dres.ok && dres.value != null) customValues.push({ definitionId: cdef.id, value: dres.value });
      } else if (cdef.required && mappedFieldKeys.has(customFieldKey(cdef.id))) {
        errors.push(`${cdef.label} is required`);
      }
    }

    let duplicateOfExistingId: number | null = null;
    let duplicateReason: string | null = null;
    let hardConflict = false;

    if (ctx.entityType === "contact") {
      const hasIdentity = ["firstName", "lastName", "email", "mobile", "officePhone"].some((k) => record[k]);
      if (!hasIdentity) errors.push("row has no name, email, or phone");
      if (contactMatcher && errors.length === 0) {
        const fullName = [record.firstName, record.lastName].filter(Boolean).join(" ") || null;
        const matched = contactMatcher.match({
          email: record.email, mobile: record.mobile, officePhone: record.officePhone,
          fullName, firstName: record.firstName, lastName: record.lastName, contactCompany: record.contactCompany,
        });
        if (matched != null) {
          duplicateOfExistingId = matched > 0 ? matched : null;
          duplicateReason = matched > 0 ? "matches an existing contact" : "duplicate row within this file";
        } else {
          // Register this row so a later identical row in the same file is caught.
          contactMatcher.remember(-(i + 1), {
            email: record.email, mobile: record.mobile, officePhone: record.officePhone,
            fullName, firstName: record.firstName, lastName: record.lastName, contactCompany: record.contactCompany,
          });
        }
      }
    } else {
      const hasIdentity = Boolean(record.title || record.contactEmail || record.companyName);
      if (!hasIdentity) errors.push("row has no title, contact email, or company");
      const email = record.contactEmail ? record.contactEmail.trim().toLowerCase() : null;
      const cid = email ? leadContactByEmail.get(email) ?? null : null;
      if (cid != null) {
        // "Active" must mean exactly what leadsRepo.activeLeadIdForContact enforces:
        // OPEN = the stage is not a configured terminal stage (isWon/isLost), with
        // the literal won/lost fallback for unconfigured keys. A closed row creates
        // no open opportunity, so it neither conflicts with an existing open lead
        // nor blocks a later row for the same contact.
        const stageText = (record.stage ?? "prospect").trim().toLowerCase() || "prospect";
        if (!stageOutcome(ctx.configuredStageFlags.get(stageText) ?? null, stageText).closed) {
          if (leadContactsWithActive.has(cid) || seenActiveLeadContacts.has(cid)) {
            duplicateReason = "contact already has an active lead";
            duplicateOfExistingId = cid;
            hardConflict = true;
          } else {
            seenActiveLeadContacts.add(cid);
          }
        }
      }
    }

    built.push({ index: i + 1, record, customValues, errors, duplicateOfExistingId, duplicateReason, hardConflict });
  });

  return { built, unmappedRequiredCustom };
}

function summarize(built: BuiltRow[], unmappedRequiredCustom: string[]) {
  const rowErrors = built
    .filter((b) => b.errors.length > 0)
    .map((b) => ({ row: b.index, errors: b.errors }));
  const duplicates = built
    .filter((b) => b.errors.length === 0 && b.duplicateReason)
    .map((b) => ({ row: b.index, reason: b.duplicateReason as string }));
  const validCount = built.filter((b) => b.errors.length === 0 && !b.duplicateReason).length;
  return {
    totalRows: built.length,
    validRows: validCount,
    errorRows: rowErrors.length,
    duplicateRows: duplicates.length,
    batchErrors: unmappedRequiredCustom.map((label) => `Required custom field "${label}" is not mapped to any column`),
    rowErrors,
    duplicates,
  };
}

export async function validate(user: AuthUser, body: { entityType?: unknown; file?: unknown; mapping?: unknown }) {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const entityType = assertEntityType(body.entityType);
  const { rows } = parseWorkbook(String(body.file ?? ""));
  const mapping = normalizeMapping(body.mapping);
  const customDefs = await loadCustomDefs(companyId, entityType);
  const configuredStageFlags = await loadStageFlags(companyId, entityType);
  const { built, unmappedRequiredCustom } = await buildRows({ entityType, companyId, rows, mapping, customDefs, configuredStageFlags });
  return summarize(built, unmappedRequiredCustom);
}

// Stage flags feed the lead-import open/closed rule; contacts don't need them.
async function loadStageFlags(companyId: number, entityType: ImportEntityType): Promise<Map<string, { isWon: boolean; isLost: boolean }>> {
  if (entityType !== "lead") return new Map();
  await ensureStages(companyId);
  const rows = await pipelineRepo.stageFlagsByCompany(companyId);
  return new Map(rows.map((s) => [s.key, { isWon: s.isWon, isLost: s.isLost }]));
}

export interface CommitResult {
  imported: number;
  skippedDuplicates: number;
  skippedErrors: number;
  totalRows: number;
}

export async function commit(
  user: AuthUser,
  body: { entityType?: unknown; file?: unknown; mapping?: unknown; skipDuplicates?: unknown },
): Promise<CommitResult> {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const entityType = assertEntityType(body.entityType);
  const { rows } = parseWorkbook(String(body.file ?? ""));
  const mapping = normalizeMapping(body.mapping);
  const skipDuplicates = body.skipDuplicates !== false; // default: skip duplicates
  const customDefs = await loadCustomDefs(companyId, entityType);
  const configuredStageFlags = await loadStageFlags(companyId, entityType);

  const { built, unmappedRequiredCustom } = await buildRows({ entityType, companyId, rows, mapping, customDefs, configuredStageFlags });

  // Fatal: a required custom field mapped to no column would leave every row
  // invalid. Reject the whole batch rather than importing broken rows.
  if (unmappedRequiredCustom.length > 0) {
    throw new AppError(400, `Cannot import: required custom field(s) not mapped: ${unmappedRequiredCustom.join(", ")}`);
  }

  const errorRows = built.filter((b) => b.errors.length > 0).length;
  // Rows we will actually insert: no per-row errors, never a hard integrity conflict
  // (e.g. a lead whose contact already has an active lead), and — when skipDuplicates —
  // not a soft duplicate. A hard conflict is skipped even when skipDuplicates=false so
  // bulk import can never bypass the single-active-lead-per-contact invariant.
  const toInsert = built.filter(
    (b) => b.errors.length === 0 && !b.hardConflict && (!skipDuplicates || !b.duplicateReason),
  );
  const insertSet = new Set(toInsert);
  const skippedDuplicates = built.filter(
    (b) => b.errors.length === 0 && b.duplicateReason && !insertSet.has(b),
  ).length;

  if (toInsert.length === 0) {
    return { imported: 0, skippedDuplicates, skippedErrors: errorRows, totalRows: built.length };
  }

  if (entityType === "contact") {
    await commitContacts(user, companyId, toInsert, skipDuplicates);
  } else {
    await commitLeads(user, companyId, toInsert, mapping, rows);
  }

  return { imported: toInsert.length, skippedDuplicates, skippedErrors: errorRows, totalRows: built.length };
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
}

async function commitContacts(user: AuthUser, companyId: number, toInsert: BuiltRow[], skipDuplicates: boolean) {
  // Enforce the plan contact limit against ORIGINALS (stats counts originals).
  // Rows linked as duplicates of an existing contact don't add to the original count.
  const sub = await subscriptionsRepo.findSubscriptionByCompanyId(companyId);
  const limit = sub?.contactsLimit ?? null;
  const newOriginals = toInsert.filter((b) => !b.duplicateOfExistingId).length;
  if (limit != null) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const { total } = await contactsRepo.stats(user, today);
    if (total + newOriginals > limit) {
      throw new AppError(400, `Import would exceed the plan contact limit (${limit}); ${total} used, ${newOriginals} new.`);
    }
  }

  const values = toInsert.map((b) => {
    const r = b.record;
    const fullName = [r.firstName, r.lastName].filter(Boolean).join(" ") || null;
    return {
      companyId,
      firstName: r.firstName ?? null,
      lastName: r.lastName ?? null,
      fullName,
      arabicName: r.arabicName ?? null,
      jobTitle: r.jobTitle ?? null,
      contactCompany: r.contactCompany ?? null,
      email: r.email ?? null,
      mobile: r.mobile ?? null,
      officePhone: r.officePhone ?? null,
      website: r.website ?? null,
      country: r.country ?? null,
      address: r.address ?? null,
      linkedin: r.linkedin ?? null,
      notes: r.notes ?? null,
      tags: JSON.stringify(parseTags(r.tags ?? null)),
      status: r.status ?? "new",
      leadScore: null,
      leadTemperature: null,
      aiReasoning: null,
      source: r.source ?? "import",
      // When not skipping, link rows matching an existing contact as duplicates
      // (mirrors scan-time auto-link) so they stay hidden from the main list.
      duplicateOfId: skipDuplicates ? null : (b.duplicateOfExistingId ?? null),
    };
  });

  // Atomic: base contacts + their (already-resolved, already-validated) custom-field
  // values commit together or not at all. A failure on ANY custom-field write rolls
  // back the whole batch — no partial imports (contact created but fields missing).
  // Batch 16 durability boundary: the batch, its custom-field values AND every
  // matching workflow run commit together or not at all; jobs are enqueued only
  // after the commit. Imported contacts are human-initiated creations (linked
  // duplicates are hidden rows and emit nothing).
  const runs = await db.transaction(async (tx) => {
    const inserted = await contactsRepo.bulkInsert(values, tx);
    const cfEntries = inserted.flatMap((row, i) =>
      toInsert[i].customValues.map((cv) => ({
        companyId,
        definitionId: cv.definitionId,
        entityType: "contact",
        entityId: row.id,
        value: cv.value,
      })),
    );
    await customFieldsRepo.bulkInsertValues(cfEntries, tx);
    return persistWorkflowRuns(inserted.filter((c) => c.duplicateOfId == null).map((c) => contactCreatedEvent(c, user.id)), tx);
  });
  await enqueueWorkflowRuns(runs);
}

async function commitLeads(
  user: AuthUser,
  companyId: number,
  toInsert: BuiltRow[],
  mapping: MappingInput,
  rows: Record<string, string>[],
) {
  await ensureStages(companyId);

  // Resolve contact emails → ids once for linking.
  const emails = new Set<string>();
  for (const b of toInsert) {
    if (b.record.contactEmail) emails.add(b.record.contactEmail.trim().toLowerCase());
  }
  const contactByEmail = emails.size > 0 ? await leadsRepo.contactIdsByEmails(companyId, [...emails]) : new Map<string, number>();

  // Resolve stage keys → ids (cache per key).
  const stageIdCache = new Map<string, number | null>();
  const resolveStage = async (key: string): Promise<number | null> => {
    if (stageIdCache.has(key)) return stageIdCache.get(key)!;
    const s = await pipelineRepo.findByKey(companyId, key);
    const id = s?.id ?? null;
    stageIdCache.set(key, id);
    return id;
  };

  const values: Array<Parameters<typeof leadsRepo.bulkInsert>[0][number]> = [];
  const customPerRow: Array<Array<{ definitionId: number; value: string }>> = [];
  for (const b of toInsert) {
    const r = b.record;
    const stageText = (r.stage ?? "prospect").trim().toLowerCase() || "prospect";
    const stageId = await resolveStage(stageText);
    const email = r.contactEmail ? r.contactEmail.trim().toLowerCase() : null;
    const contactId = email ? contactByEmail.get(email) ?? null : null;
    values.push({
      companyId,
      contactId,
      stage: stageText,
      stageId,
      title: r.title ?? null,
      value: r.value ?? null,
      currency: r.currency ?? "USD",
      closingDate: r.closingDate ?? null,
      probability: r.probability != null ? Number(r.probability) : null,
      priority: r.priority ?? null,
      notes: r.notes ?? null,
      companyName: r.companyName ?? null,
      source: r.source ?? "import",
      createdById: user.id,
    });
    customPerRow.push(b.customValues);
  }

  // Atomic: base leads + their resolved custom-field values commit together or not
  // at all (see commitContacts). A custom-field write failure rolls back the batch.
  // Batch 16 durability boundary: same atomic batch + workflow-run commit as
  // commitContacts; jobs are enqueued only after the commit.
  const runs = await db.transaction(async (tx) => {
    const inserted = await leadsRepo.bulkInsert(values, tx);
    const cfEntries = inserted.flatMap((row, i) =>
      customPerRow[i].map((cv) => ({
        companyId,
        definitionId: cv.definitionId,
        entityType: "lead",
        entityId: row.id,
        value: cv.value,
      })),
    );
    await customFieldsRepo.bulkInsertValues(cfEntries, tx);
    return persistWorkflowRuns(inserted.map((l) => leadCreatedEvent(l, user.id)), tx);
  });
  await enqueueWorkflowRuns(runs);
}
