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
import { ObjectNotFoundError } from "../lib/objectStorage.js";

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

// Fail fast on a malformed objectPath before persisting a version row. The
// normalized path from requestUploadURL is always `/objects/...`; a client that
// posts anything else never uploaded through our presign flow.
function assertValidObjectPath(objectPath: string): void {
  if (!objectPath.startsWith("/objects/")) throw new AppError(400, "Invalid objectPath");
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

// ── Presigned upload URL ─────────────────────────────────────────────────────
export interface UploadUrlInput {
  fileName?: string;
  contentType?: string;
  size?: number;
}

export async function createUploadUrl(_user: AuthUser, input: UploadUrlInput) {
  const { contentType, size } = input;
  if (!contentType) throw new AppError(400, "contentType required");
  if (size == null) throw new AppError(400, "size required");
  assertValidUpload(contentType, size);
  return requestUploadURL();
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

  // Batched enrichment: version counts, creator names, entity names (grouped by type).
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

  const documents = rows.map((r) =>
    fmtDocument(r.doc, {
      currentVersion: r.currentVersion
        ? fmtVersion(r.currentVersion, r.currentVersion.uploadedById != null ? (uploaderName.get(r.currentVersion.uploadedById) ?? null) : null)
        : null,
      createdByName: r.doc.createdById != null ? (creatorName.get(r.doc.createdById) ?? null) : null,
      entityName: entityNameMaps.get(r.doc.entityType)?.get(r.doc.entityId) ?? null,
      versionCount: countMap.get(r.doc.id) ?? 0,
    }),
  );
  return { documents, total };
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

  const doc = await docsRepo.insertWithFirstVersion(
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
      fileSize,
      mimeType,
      label: label ?? null,
      uploadedById: user.id,
    },
  );
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

  await docsRepo.addVersion(id, {
    companyId: found.doc.companyId,
    objectPath,
    fileName,
    fileSize,
    mimeType,
    label: label ?? null,
    uploadedById: user.id,
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

// ── Download / preview (signed URL) ──────────────────────────────────────────
export async function getDownloadUrlForCurrent(user: AuthUser, id: number) {
  const found = await docsRepo.findById(user, id);
  if (!found) throw new AppError(404, "Document not found");
  if (!found.currentVersion) throw new AppError(404, "Document has no file");
  return signVersion(found.currentVersion);
}

export async function getDownloadUrlForVersion(user: AuthUser, id: number, versionId: number) {
  const found = await docsRepo.findById(user, id);
  if (!found) throw new AppError(404, "Document not found");
  const version = await docsRepo.versionById(user, id, versionId);
  if (!version) throw new AppError(404, "Version not found");
  return signVersion(version);
}

async function signVersion(version: docsRepo.DocumentVersionRow) {
  try {
    const url = await getDownloadURL(version.objectPath);
    return { url, fileName: version.fileName, mimeType: version.mimeType };
  } catch (err) {
    if (err instanceof ObjectNotFoundError) throw new AppError(404, "File not found in storage");
    throw err;
  }
}
