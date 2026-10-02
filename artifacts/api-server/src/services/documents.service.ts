import type { Request } from "express";
import { db } from "@workspace/db";
import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { canAccessCompany } from "../middlewares/requireAuth.js";
import { refInCompany } from "../lib/tenant.js";
import { parseListQuery } from "../lib/list-query.js";
import * as docsRepo from "../repositories/documents.repository.js";
import {
  DOCUMENT_CATEGORY_CATALOG,
  assertValidCategory,
  assertValidUpload,
  isDocumentEntityType,
  requestUploadURL,
  getDownloadURL,
  type DocumentEntityType,
} from "../lib/documentStorage.js";
import * as storage from "./storage.service.js";

// ── Response formatting ──────────────────────────────────────────────────────

type VersionLite = {
  id: number;
  documentId: number;
  versionNumber: number;
  label: string | null;
  objectPath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedById: number | null;
  uploadedByName: string | null;
  uploadedAt: string;
};

type VersionSource = {
  id: number;
  documentId: number;
  versionNumber: number;
  label: string | null;
  objectPath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedById: number | null;
  uploadedAt: Date;
};

function fmtVersion(v: VersionSource, uploadedByName: string | null): VersionLite {
  return {
    id: v.id,
    documentId: v.documentId,
    versionNumber: v.versionNumber,
    label: v.label ?? null,
    objectPath: v.objectPath,
    fileName: v.fileName,
    fileSize: v.fileSize,
    mimeType: v.mimeType,
    uploadedById: v.uploadedById ?? null,
    uploadedByName,
    uploadedAt: v.uploadedAt.toISOString(),
  };
}

function fmtDocument(
  doc: docsRepo.DocumentRow,
  opts: {
    currentVersion?: VersionLite | null;
    createdByName?: string | null;
    entityName?: string | null;
    versionCount?: number | null;
    versions?: VersionLite[];
  },
) {
  return {
    id: doc.id,
    companyId: doc.companyId,
    entityType: doc.entityType,
    entityId: doc.entityId,
    name: doc.name,
    category: doc.category,
    description: doc.description ?? null,
    currentVersionId: doc.currentVersionId ?? null,
    createdById: doc.createdById ?? null,
    createdByName: opts.createdByName ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
    deletedAt: doc.deletedAt ? doc.deletedAt.toISOString() : null,
    entityName: opts.entityName ?? null,
    versionCount: opts.versionCount ?? null,
    currentVersion: opts.currentVersion ?? null,
    versions: opts.versions ?? [],
  };
}

// ── Entity attach-target validation ──────────────────────────────────────────
// A document's tenant is the caller's own company. The attach target must belong
// to that same tenant. company targets must equal the caller's company; other
// entities are validated against the tenant via refInCompany.
async function assertEntityInTenant(user: AuthUser, companyId: number, entityType: DocumentEntityType, entityId: number): Promise<void> {
  if (entityType === "company") {
    if (entityId !== companyId || !canAccessCompany(user, entityId)) {
      throw new AppError(400, "Invalid company reference");
    }
    return;
  }
  const table = entityType === "contact" ? "contacts" : entityType === "lead" ? "leads" : "events";
  if (!(await refInCompany(table, companyId, entityId))) {
    throw new AppError(400, `Invalid ${entityType} reference`);
  }
}

// Fail fast on a malformed objectPath before touching the database. The handle
// returned by requestUploadURL is always `/objects/<id>`; a client that posts
// anything else never uploaded through our reserve flow. The binding itself
// (tenant + staged state) is enforced by storage.attachStaged inside the
// create/version transaction.
function assertValidObjectPath(objectPath: string): void {
  if (!storage.isNativeHandle(objectPath)) throw new AppError(400, "Invalid objectPath");
}

function requireCompany(user: AuthUser): number {
  // requireTenantUser guarantees a non-platform user reached this point, but a
  // tenant user could still (defensively) have a null company.
  if (user.companyId == null) throw new AppError(400, "No company context");
  return user.companyId;
}

// ── Category catalog ─────────────────────────────────────────────────────────
export function getCategoryCatalog() {
  return DOCUMENT_CATEGORY_CATALOG;
}

// ── Upload target (capability URL bound to the caller's tenant) ──────────────
export interface UploadUrlInput {
  fileName?: string;
  contentType?: string;
  size?: number;
}

export async function createUploadUrl(req: Request, user: AuthUser, input: UploadUrlInput) {
  const companyId = requireCompany(user);
  const { contentType, size } = input;
  if (!contentType) throw new AppError(400, "contentType required");
  if (size == null) throw new AppError(400, "size required");
  assertValidUpload(contentType, size);
  return requestUploadURL(req, { companyId, userId: user.id, contentType, size });
}

// ── List ─────────────────────────────────────────────────────────────────────
export interface ListDocumentsParams {
  entityType?: string;
  entityId?: string;
  category?: string;
  mimeType?: string;
  uploadedBy?: string;
  q?: string;
  from?: string;
  to?: string;
  includeDeleted?: string | boolean;
  page?: string;
  limit?: string;
}

export async function listDocuments(user: AuthUser, params: ListDocumentsParams) {
  const { page: _p, limit: limitNum, offset } = parseListQuery(params, { defaultPageSize: 100, maxPageSize: 500 });
  const entityType = params.entityType && isDocumentEntityType(params.entityType) ? params.entityType : undefined;
  const includeDeleted = params.includeDeleted === true || params.includeDeleted === "true";

  const { rows, total } = await docsRepo.list(user, {
    entityType,
    entityId: params.entityId && !isNaN(parseInt(params.entityId)) ? parseInt(params.entityId) : undefined,
    category: params.category || undefined,
    mimeType: params.mimeType || undefined,
    uploadedBy: params.uploadedBy && !isNaN(parseInt(params.uploadedBy)) ? parseInt(params.uploadedBy) : undefined,
    q: params.q || undefined,
    from: params.from || undefined,
    to: params.to || undefined,
    includeDeleted,
    limit: limitNum,
    offset,
  });

  const documents = await formatDocumentRows(rows);
  return { documents, total };
}

// Batched enrichment of raw document rows into the API Document shape: version
// counts, creator names, uploader names, and attach-target entity names
// (grouped by type). Shared by listDocuments and the Company Detail aggregate.
export async function formatDocumentRows(rows: docsRepo.DocumentWithVersion[]) {
  const docIds = rows.map((r) => r.doc.id);
  const creatorIds = [...new Set(rows.map((r) => r.doc.createdById).filter((v): v is number => v != null))];
  const uploaderIds = [...new Set(rows.map((r) => r.currentVersion?.uploadedById).filter((v): v is number => v != null))];
  const [countMap, creators, uploaders] = await Promise.all([
    docsRepo.versionCountsByIds(docIds),
    docsRepo.userNamesByIds(creatorIds),
    docsRepo.userNamesByIds(uploaderIds),
  ]);
  const creatorName = new Map(creators.map((u) => [u.id, u.name]));
  const uploaderName = new Map(uploaders.map((u) => [u.id, u.name]));

  const byType = new Map<string, number[]>();
  for (const r of rows) {
    const list = byType.get(r.doc.entityType) ?? [];
    list.push(r.doc.entityId);
    byType.set(r.doc.entityType, list);
  }
  const entityNameMaps = new Map<string, Map<number, string>>();
  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      entityNameMaps.set(type, await docsRepo.entityNames(type, ids));
    }),
  );

  return rows.map((r) =>
    fmtDocument(r.doc, {
      currentVersion: r.currentVersion
        ? fmtVersion(r.currentVersion, r.currentVersion.uploadedById != null ? (uploaderName.get(r.currentVersion.uploadedById) ?? null) : null)
        : null,
      createdByName: r.doc.createdById != null ? (creatorName.get(r.doc.createdById) ?? null) : null,
      entityName: entityNameMaps.get(r.doc.entityType)?.get(r.doc.entityId) ?? null,
      versionCount: countMap.get(r.doc.id) ?? 0,
    }),
  );
}

// ── Single document (with full version history) ──────────────────────────────
async function loadDocumentDetail(user: AuthUser, id: number, includeDeleted = false) {
  const found = await docsRepo.findById(user, id, includeDeleted);
  if (!found) throw new AppError(404, "Document not found");
  const versionRows = await docsRepo.versionsForDocument(id);
  const versions = versionRows.map((v) => fmtVersion(v, v.uploadedByName ?? null));
  const [creatorName, entityMap] = await Promise.all([
    found.doc.createdById != null ? docsRepo.userNamesByIds([found.doc.createdById]) : Promise.resolve([]),
    docsRepo.entityNames(found.doc.entityType, [found.doc.entityId]),
  ]);
  const current = versions.find((v) => v.id === found.doc.currentVersionId) ?? null;
  return fmtDocument(found.doc, {
    currentVersion: current,
    createdByName: creatorName[0]?.name ?? null,
    entityName: entityMap.get(found.doc.entityId) ?? null,
    versionCount: versions.length,
    versions,
  });
}

export async function getDocument(user: AuthUser, id: number) {
  return loadDocumentDetail(user, id);
}

export async function listVersions(user: AuthUser, id: number) {
  const found = await docsRepo.findById(user, id);
  if (!found) throw new AppError(404, "Document not found");
  const versionRows = await docsRepo.versionsForDocument(id);
  return { versions: versionRows.map((v) => fmtVersion(v, v.uploadedByName ?? null)) };
}

// ── Create ───────────────────────────────────────────────────────────────────
export interface CreateDocumentInput {
  entityType?: string;
  entityId?: number;
  category?: string;
  name?: string | null;
  description?: string | null;
  objectPath?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  label?: string | null;
}

// Batch 25: the uploaded object is attached to the new version INSIDE one
// transaction — the handle must be a STAGED object of THIS tenant whose
// reserved content type matches the declared mimeType; the stored size (not the
// client's claim) is what the version row records. A failure anywhere rolls
// back both the rows and the activation, so no committed reference can point
// at an object that was never written and no written object is left untracked.
export async function createDocument(user: AuthUser, input: CreateDocumentInput) {
  const companyId = requireCompany(user);
  const { entityType, entityId, category, name, description, objectPath, fileName, fileSize, mimeType, label } = input;

  if (!entityType || !isDocumentEntityType(entityType)) throw new AppError(400, "Invalid entityType");
  if (entityId == null) throw new AppError(400, "entityId required");
  if (!category) throw new AppError(400, "category required");
  if (!objectPath || !fileName || fileSize == null || !mimeType) throw new AppError(400, "Missing file metadata");

  assertValidCategory(entityType, category);
  assertValidUpload(mimeType, fileSize);
  assertValidObjectPath(objectPath);
  await assertEntityInTenant(user, companyId, entityType, entityId);

  const doc = await db.transaction(async (tx) => {
    const object = await storage.attachStaged(tx, {
      companyId,
      kind: "document",
      reference: objectPath,
      entityType: "document_version",
      entityId: null,
      contentType: mimeType,
    });
    const created = await docsRepo.insertWithFirstVersion(
      {
        companyId,
        entityType,
        entityId,
        name: name?.trim() || fileName,
        category,
        description: description ?? null,
        createdById: user.id,
      },
      {
        companyId,
        objectPath,
        fileName,
        fileSize: object.sizeBytes ?? fileSize,
        mimeType,
        label: label ?? null,
        uploadedById: user.id,
      },
      tx,
    );
    if (created.currentVersionId != null) await storage.bindEntity(tx, object.id, "document_version", created.currentVersionId);
    return created;
  });
  return loadDocumentDetail(user, doc.id);
}

// ── Add a version ─────────────────────────────────────────────────────────────
export interface AddVersionInput {
  objectPath?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  label?: string | null;
}

export async function addVersion(user: AuthUser, id: number, input: AddVersionInput) {
  const found = await docsRepo.findById(user, id);
  if (!found) throw new AppError(404, "Document not found");
  const { objectPath, fileName, fileSize, mimeType, label } = input;
  if (!objectPath || !fileName || fileSize == null || !mimeType) throw new AppError(400, "Missing file metadata");
  assertValidUpload(mimeType, fileSize);
  assertValidObjectPath(objectPath);

  await db.transaction(async (tx) => {
    const object = await storage.attachStaged(tx, {
      companyId: found.doc.companyId,
      kind: "document",
      reference: objectPath,
      entityType: "document_version",
      entityId: null,
      contentType: mimeType,
    });
    const version = await docsRepo.addVersion(
      id,
      {
        companyId: found.doc.companyId,
        objectPath,
        fileName,
        fileSize: object.sizeBytes ?? fileSize,
        mimeType,
        label: label ?? null,
        uploadedById: user.id,
      },
      tx,
    );
    await storage.bindEntity(tx, object.id, "document_version", version.id);
  });
  return loadDocumentDetail(user, id);
}

// ── Update (rename / move / recategorize) ────────────────────────────────────
export interface UpdateDocumentInput {
  name?: string | null;
  category?: string | null;
  description?: string | null;
  entityType?: string;
  entityId?: number | null;
}

export async function updateDocument(user: AuthUser, id: number, input: UpdateDocumentInput) {
  const found = await docsRepo.findById(user, id);
  if (!found) throw new AppError(404, "Document not found");
  const { name, category, description, entityType, entityId } = input;

  // Resolve the effective (entityType, category) so a cross-entity move is
  // validated against the DESTINATION entity's category list.
  const effectiveType = (entityType && isDocumentEntityType(entityType) ? entityType : found.doc.entityType) as DocumentEntityType;
  const effectiveEntityId = entityId != null ? entityId : found.doc.entityId;

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) {
    const trimmed = (name ?? "").trim();
    if (!trimmed) throw new AppError(400, "name cannot be empty");
    updateData.name = trimmed;
  }
  if (description !== undefined) updateData.description = description;

  // A move requires re-validating the destination entity + category coherence.
  const moving = entityType !== undefined || entityId != null;
  if (moving) {
    if (!isDocumentEntityType(effectiveType)) throw new AppError(400, "Invalid entityType");
    await assertEntityInTenant(user, found.doc.companyId, effectiveType, effectiveEntityId);
    updateData.entityType = effectiveType;
    updateData.entityId = effectiveEntityId;
  }
  if (category !== undefined && category !== null) {
    assertValidCategory(effectiveType, category);
    updateData.category = category;
  }

  if (Object.keys(updateData).length === 0) throw new AppError(400, "No valid fields to update");

  const updated = await docsRepo.update(id, updateData);
  if (!updated) throw new AppError(404, "Document not found");
  return loadDocumentDetail(user, id);
}

// ── Delete / restore ─────────────────────────────────────────────────────────
// Soft delete keeps every version's object (restore must bring the file back);
// the bytes go only when the version rows are hard-deleted (company deletion,
// retention) — the storage sweep removes objects whose version row is gone.
export async function deleteDocument(user: AuthUser, id: number) {
  const found = await docsRepo.findById(user, id);
  if (!found) throw new AppError(404, "Document not found");
  await docsRepo.softDelete(id);
  return { success: true, message: "Document deleted" };
}

export async function restoreDocument(user: AuthUser, id: number) {
  const found = await docsRepo.findById(user, id, true);
  if (!found) throw new AppError(404, "Document not found");
  if (found.doc.deletedAt == null) throw new AppError(400, "Document is not deleted");
  await docsRepo.restore(id);
  return loadDocumentDetail(user, id);
}

// ── Download / preview (short-lived capability URL) ──────────────────────────
export async function getDownloadUrlForCurrent(req: Request, user: AuthUser, id: number) {
  const found = await docsRepo.findById(user, id);
  if (!found) throw new AppError(404, "Document not found");
  if (!found.currentVersion) throw new AppError(404, "Document has no file");
  return signVersion(req, user, found.currentVersion);
}

export async function getDownloadUrlForVersion(req: Request, user: AuthUser, id: number, versionId: number) {
  const found = await docsRepo.findById(user, id);
  if (!found) throw new AppError(404, "Document not found");
  const version = await docsRepo.versionById(user, id, versionId);
  if (!version) throw new AppError(404, "Version not found");
  return signVersion(req, user, version);
}

async function signVersion(req: Request, user: AuthUser, version: docsRepo.DocumentVersionRow) {
  const url = await getDownloadURL(storage.publicBaseUrl(req), {
    companyId: version.companyId,
    objectPath: version.objectPath,
    userId: user.id,
    fileName: version.fileName,
    mimeType: version.mimeType,
  });
  if (!url) throw new AppError(404, "File not found in storage");
  return { url, fileName: version.fileName, mimeType: version.mimeType };
}
