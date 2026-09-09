import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { logger } from "../lib/logger.js";
import { parseListQuery } from "../lib/list-query.js";
import * as contactsRepo from "../repositories/contacts.repository.js";
import * as leadsRepo from "../repositories/leads.repository.js";
import * as customFieldsRepo from "../repositories/custom_fields.repository.js";
import * as runsRepo from "../repositories/export_runs.repository.js";
import * as schedulesRepo from "../repositories/export_schedules.repository.js";
import {
  contactColumns,
  leadColumns,
  isExportEntityType,
  type ExportColumn,
  type ExportEntityType,
} from "../lib/export-fields.js";
import {
  generateFile,
  encryptZip,
  fileExtension,
  contentType,
  isExportFormat,
  isEncryptionMethod,
  type ExportFormat,
  type EncryptionMethod,
} from "../lib/export-generate.js";
import { uploadExportBuffer, exportDownloadURL } from "../lib/exportStorage.js";
import { tenantWritable } from "../lib/company-access.js";

// Stage 4B — Export Center (export side). Produces a filtered CSV/Excel/PDF/JSON
// file of the caller's contacts or leads, optionally AES-encrypted (on-demand
// only — a password is never persisted), stores it in object storage, and
// records an export_runs row. Also manages recurring export schedules and the
// system-wide scheduler tick that fulfils due schedules. No fabricated data:
// every value comes from the tenant's own rows.

const MAX_EXPORT_ROWS = 10000;

type Filters = Record<string, string | undefined>;

function requireCompany(user: AuthUser): number {
  if (user.companyId == null) throw new AppError(400, "No company context");
  return user.companyId;
}

function assertEntityType(v: unknown): ExportEntityType {
  if (!isExportEntityType(v)) throw new AppError(400, "entityType must be 'contact' or 'lead'");
  return v;
}

function assertFormat(v: unknown): ExportFormat {
  if (!isExportFormat(v)) throw new AppError(400, "format must be one of csv, excel, pdf, json");
  return v;
}

function assertFrequency(v: unknown): "daily" | "weekly" | "monthly" {
  if (v !== "daily" && v !== "weekly" && v !== "monthly") throw new AppError(400, "frequency must be daily, weekly, or monthly");
  return v;
}

function assertPassword(v: unknown): string {
  if (typeof v !== "string" || v.length < 6) throw new AppError(400, "password must be at least 6 characters");
  return v;
}

// Transient request field — never persisted. Omitted/null keeps the strong
// AES-256 default so all existing callers are unchanged.
export function resolveEncryptionMethod(v: unknown): EncryptionMethod {
  if (v == null) return "aes256";
  if (!isEncryptionMethod(v)) throw new AppError(400, "encryptionMethod must be aes256 or zip20");
  return v;
}

function normalizeFilters(raw: unknown): Filters {
  if (raw == null) return {};
  if (typeof raw !== "object") throw new AppError(400, "filters must be an object");
  const out: Filters = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null || v === "") continue;
    out[k] = String(v);
  }
  return out;
}

function num(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

// ── Row fetch (tenant-scoped via the repos) ──────────────────────────────────
async function fetchContacts(user: AuthUser, f: Filters) {
  const { rows } = await contactsRepo.list(user, {
    search: f.search,
    status: f.status,
    temperature: f.temperature,
    eventId: num(f.eventId),
    assignedToId: num(f.assignedToId),
    excludeDuplicates: true,
    scheduledMeetingOnly: false,
    dateFrom: f.dateFrom,
    dateTo: f.dateTo,
    sort: f.sort,
    limit: MAX_EXPORT_ROWS,
    offset: 0,
  });
  return rows;
}

async function fetchLeads(user: AuthUser, f: Filters) {
  const { rows } = await leadsRepo.list(user, {
    stage: f.stage,
    assignedToId: num(f.assignedToId),
    eventId: num(f.eventId),
    contactId: num(f.contactId),
    limit: MAX_EXPORT_ROWS,
    offset: 0,
  });
  return rows;
}

// ── Matrix assembly (standard columns + this tenant's custom-field columns) ──
async function assembleMatrix<T extends { id: number }>(
  companyId: number,
  entityType: ExportEntityType,
  rows: T[],
  baseCols: ExportColumn<T>[],
): Promise<{ columns: string[]; matrix: string[][] }> {
  const customDefs = await customFieldsRepo.definitionsForEntityType(companyId, entityType);
  const ids = rows.map((r) => r.id);
  const values = await customFieldsRepo.valuesForEntities(companyId, entityType, ids);
  const byEntity = new Map<number, Map<number, string>>();
  for (const v of values) {
    let m = byEntity.get(v.entityId);
    if (!m) {
      m = new Map();
      byEntity.set(v.entityId, m);
    }
    m.set(v.definitionId, v.value ?? "");
  }
  const columns = [...baseCols.map((c) => c.label), ...customDefs.map((d) => d.label)];
  const matrix = rows.map((row) => {
    const base = baseCols.map((c) => c.get(row));
    const cf = customDefs.map((d) => byEntity.get(row.id)?.get(d.id) ?? "");
    return [...base, ...cf];
  });
  return { columns, matrix };
}

// ── Core: produce file, upload, record run ───────────────────────────────────
interface ProduceInput {
  entityType: ExportEntityType;
  format: ExportFormat;
  filters: Filters;
  passwordProtected: boolean;
  password: string | null;
  encryptionMethod: EncryptionMethod;
  scheduleId: number | null;
  createdById: number | null;
}

async function produceAndStore(user: AuthUser, companyId: number, input: ProduceInput) {
  const { entityType, format } = input;
  let columns: string[];
  let matrix: string[][];
  let rowCount: number;
  if (entityType === "contact") {
    const rows = await fetchContacts(user, input.filters);
    rowCount = rows.length;
    ({ columns, matrix } = await assembleMatrix(companyId, "contact", rows, contactColumns()));
  } else {
    const rows = await fetchLeads(user, input.filters);
    rowCount = rows.length;
    ({ columns, matrix } = await assembleMatrix(companyId, "lead", rows, leadColumns()));
  }

  const title = entityType === "contact" ? "Contacts Export" : "Leads Export";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const baseName = `${entityType}s-export-${stamp}`;

  let buffer = await generateFile({ format, title, columns, rows: matrix });
  const encrypted = input.passwordProtected && !!input.password;
  let fileName = `${baseName}.${fileExtension(format, false)}`;
  if (encrypted) {
    buffer = await encryptZip(buffer, fileName, input.password!, input.encryptionMethod);
    fileName = `${baseName}.zip`;
  }
  const ct = contentType(format, encrypted);

  try {
    const { objectPath } = await uploadExportBuffer(buffer, ct);
    return runsRepo.insert({
      companyId,
      scheduleId: input.scheduleId,
      createdById: input.createdById,
      entityType,
      format,
      status: "completed",
      objectPath,
      fileName,
      fileSize: buffer.length,
      rowCount,
      passwordProtected: String(encrypted),
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await runsRepo.insert({
      companyId,
      scheduleId: input.scheduleId,
      createdById: input.createdById,
      entityType,
      format,
      status: "failed",
      objectPath: null,
      fileName,
      fileSize: 0,
      rowCount,
      passwordProtected: String(encrypted),
      error: message,
    });
    throw new AppError(502, "Export storage upload failed");
  }
}

// ── Response formatting ──────────────────────────────────────────────────────
function fmtRun(run: runsRepo.ExportRunRow) {
  return {
    id: run.id,
    companyId: run.companyId,
    scheduleId: run.scheduleId ?? null,
    entityType: run.entityType,
    format: run.format,
    status: run.status,
    fileName: run.fileName,
    fileSize: run.fileSize,
    rowCount: run.rowCount,
    passwordProtected: run.passwordProtected === "true",
    error: run.error ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

function fmtSchedule(s: schedulesRepo.ExportScheduleRow) {
  return {
    id: s.id,
    companyId: s.companyId,
    name: s.name,
    entityType: s.entityType,
    format: s.format,
    filters: s.filters ? safeParseFilters(s.filters) : {},
    frequency: s.frequency,
    passwordProtected: s.passwordProtected,
    active: s.active,
    lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
    nextRunAt: s.nextRunAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
  };
}

function safeParseFilters(json: string): Filters {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Filters) : {};
  } catch {
    return {};
  }
}

// ── On-demand export ─────────────────────────────────────────────────────────
export async function createExport(
  user: AuthUser,
  body: { entityType?: unknown; format?: unknown; filters?: unknown; passwordProtected?: unknown; password?: unknown; encryptionMethod?: unknown },
) {
  const companyId = requireCompany(user);
  const entityType = assertEntityType(body.entityType);
  const format = assertFormat(body.format);
  const passwordProtected = body.passwordProtected === true;
  // Validated regardless of protection (bad values are never silently accepted),
  // but only consulted when a password is actually applied.
  const encryptionMethod = resolveEncryptionMethod(body.encryptionMethod);
  const password = passwordProtected ? assertPassword(body.password) : null;
  const filters = normalizeFilters(body.filters);

  const run = await produceAndStore(user, companyId, {
    entityType,
    format,
    filters,
    passwordProtected,
    password,
    encryptionMethod,
    scheduleId: null,
    createdById: user.id,
  });
  const downloadUrl = run.objectPath ? await exportDownloadURL(run.objectPath) : null;
  return { ...fmtRun(run), downloadUrl };
}

// ── Export run history ───────────────────────────────────────────────────────
export async function listRuns(user: AuthUser, params: { entityType?: string; scheduleId?: string; page?: string; limit?: string }) {
  const { limit, offset } = parseListQuery(params, { defaultPageSize: 50, maxPageSize: 200 });
  const entityType = isExportEntityType(params.entityType) ? params.entityType : undefined;
  const scheduleId = num(params.scheduleId);
  const { rows, total } = await runsRepo.list(user, { entityType, scheduleId, limit, offset });
  return { runs: rows.map(fmtRun), total };
}

export async function getRunDownloadUrl(user: AuthUser, id: number) {
  const run = await runsRepo.findById(user, id);
  if (!run) throw new AppError(404, "Export not found");
  if (run.status !== "completed" || !run.objectPath) throw new AppError(404, "Export file not available");
  const url = await exportDownloadURL(run.objectPath);
  return { url, fileName: run.fileName };
}

// ── Schedules ────────────────────────────────────────────────────────────────
export function computeNextRun(frequency: string, from: Date): Date {
  const next = new Date(from);
  if (frequency === "daily") next.setDate(next.getDate() + 1);
  else if (frequency === "weekly") next.setDate(next.getDate() + 7);
  else if (frequency === "monthly") next.setMonth(next.getMonth() + 1);
  else next.setDate(next.getDate() + 1);
  return next;
}

export async function listSchedules(user: AuthUser, params: { page?: string; limit?: string }) {
  const { limit, offset } = parseListQuery(params, { defaultPageSize: 50, maxPageSize: 200 });
  const { rows, total } = await schedulesRepo.list(user, { limit, offset });
  return { schedules: rows.map(fmtSchedule), total };
}

// Password-protected SCHEDULED exports are rejected: a stored password would be a
// plaintext secret. On-demand exports carry the password per request instead.
function assertNoScheduledPassword(passwordProtected: unknown): void {
  if (passwordProtected === true) {
    throw new AppError(400, "Scheduled exports cannot be password-protected (a password would have to be stored). Use an on-demand export for password protection.");
  }
}

export async function createSchedule(
  user: AuthUser,
  body: { name?: unknown; entityType?: unknown; format?: unknown; frequency?: unknown; filters?: unknown; passwordProtected?: unknown; active?: unknown },
) {
  const companyId = requireCompany(user);
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
  if (!name) throw new AppError(400, "name is required");
  const entityType = assertEntityType(body.entityType);
  const format = assertFormat(body.format);
  const frequency = assertFrequency(body.frequency);
  assertNoScheduledPassword(body.passwordProtected);
  const filters = normalizeFilters(body.filters);
  const active = body.active !== false;

  const row = await schedulesRepo.insert({
    companyId,
    createdById: user.id,
    name,
    entityType,
    format,
    filters: JSON.stringify(filters),
    frequency,
    passwordProtected: false,
    active,
    nextRunAt: computeNextRun(frequency, new Date()),
  });
  return fmtSchedule(row);
}

export async function updateSchedule(
  user: AuthUser,
  id: number,
  body: { name?: unknown; format?: unknown; frequency?: unknown; filters?: unknown; passwordProtected?: unknown; active?: unknown },
) {
  const existing = await schedulesRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Schedule not found");

  const data: Partial<schedulesRepo.ExportScheduleRow> = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new AppError(400, "name cannot be empty");
    data.name = name;
  }
  if (body.format !== undefined) data.format = assertFormat(body.format);
  if (body.filters !== undefined) data.filters = JSON.stringify(normalizeFilters(body.filters));
  if (body.passwordProtected !== undefined) assertNoScheduledPassword(body.passwordProtected);
  if (body.active !== undefined) data.active = body.active !== false;
  if (body.frequency !== undefined) {
    const frequency = assertFrequency(body.frequency);
    data.frequency = frequency;
    // Recompute the next run from now when cadence changes.
    data.nextRunAt = computeNextRun(frequency, new Date());
  }

  if (Object.keys(data).length === 0) throw new AppError(400, "No valid fields to update");
  const updated = await schedulesRepo.update(id, data);
  if (!updated) throw new AppError(404, "Schedule not found");
  return fmtSchedule(updated);
}

export async function deleteSchedule(user: AuthUser, id: number) {
  const existing = await schedulesRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Schedule not found");
  await schedulesRepo.softDelete(id);
  return { success: true, message: "Schedule deleted" };
}

export async function runScheduleNow(user: AuthUser, id: number) {
  const s = await schedulesRepo.findById(user, id);
  if (!s) throw new AppError(404, "Schedule not found");
  const run = await produceAndStore(user, s.companyId, {
    entityType: assertEntityType(s.entityType),
    format: assertFormat(s.format),
    filters: s.filters ? safeParseFilters(s.filters) : {},
    passwordProtected: false,
    password: null,
    encryptionMethod: "aes256",
    scheduleId: s.id,
    createdById: user.id,
  });
  await schedulesRepo.markRun(s.id, new Date(), computeNextRun(s.frequency, new Date()));
  const downloadUrl = run.objectPath ? await exportDownloadURL(run.objectPath) : null;
  return { ...fmtRun(run), downloadUrl };
}

// ── System scheduler tick (all tenants) ──────────────────────────────────────
// Builds a company-scoped synthetic principal so tenant scoping in the repos
// still applies (tenantScope filters by accessibleCompanies). Never platform-wide.
function systemUserForCompany(companyId: number, createdById: number | null): AuthUser {
  return {
    id: createdById ?? 0,
    email: "system@scheduler",
    name: "Scheduled Export",
    role: "primary_admin",
    companyId,
    permissions: {},
    contactVisibility: "all",
    companyVisibility: "all",
    selectedUserIds: [],
    isActive: true,
    companyStatus: "active",
    readOnly: false,
    accessibleCompanies: [companyId],
    sessionId: null,
  };
}

export async function runDueSchedules(): Promise<{ processed: number }> {
  const now = new Date();
  const due = await schedulesRepo.dueSchedules(now);
  for (const s of due) {
    try {
      // B20 Correction 1: a scheduled export is a side effect (artifact + storage
      // upload). The CANONICAL entitlement is re-read now; a read-only / blocked
      // tenant gets no artifact and the schedule simply advances.
      const gate = await tenantWritable(s.companyId, now);
      if (!gate.writable) {
        logger.warn({ scheduleId: s.id, companyId: s.companyId, accessMode: gate.accessMode, reasonCode: gate.reasonCode, code: "SUBSCRIPTION_NOT_WRITABLE" }, "Scheduled export skipped: subscription not writable");
        continue;
      }
      const sysUser = systemUserForCompany(s.companyId, s.createdById);
      await produceAndStore(sysUser, s.companyId, {
        entityType: assertEntityType(s.entityType),
        format: assertFormat(s.format),
        filters: s.filters ? safeParseFilters(s.filters) : {},
        passwordProtected: false,
        password: null,
        encryptionMethod: "aes256",
        scheduleId: s.id,
        createdById: s.createdById,
      });
    } catch (err) {
      logger.error({ err, scheduleId: s.id, companyId: s.companyId }, "Scheduled export failed");
    } finally {
      // Always advance so a persistently failing schedule doesn't hot-loop.
      await schedulesRepo.markRun(s.id, now, computeNextRun(s.frequency, now));
    }
  }
  return { processed: due.length };
}
