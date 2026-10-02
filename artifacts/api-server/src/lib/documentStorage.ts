import type { Request } from "express";
import { AppError } from "../middlewares/errorHandler.js";
import * as storage from "../services/storage.service.js";

const INLINE_SAFE_TYPES = storage.INLINE_SAFE_TYPES;

// ── Upload constraints (enforced at both upload-URL request and create/version).
export const MAX_DOCUMENT_SIZE = storage.OBJECT_LIMITS.document; // 25 MB

// Allowlist of accepted document MIME types (images, PDFs, Office docs, plain
// text/CSV, and common archives). Anything else is rejected with a 400.
export const ALLOWED_DOCUMENT_MIME_TYPES: readonly string[] = [
  // images
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/tiff",
  // documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  // archives (e.g. bundled drawings)
  "application/zip",
  "application/x-zip-compressed",
];

// ── Category catalog per entity type. Lead (== Opportunity) carries both lead-
// and opportunity-category files. "Other Attachments" is a catch-all on every
// entity so nothing is ever un-categorizable. Kept server-side as the single
// source of truth and surfaced to clients via GET /documents/categories.
export type DocumentEntityType = "company" | "contact" | "lead" | "event";

export const DOCUMENT_CATEGORY_CATALOG: Record<DocumentEntityType, string[]> = {
  company: [
    "Business Card",
    "Company Profile",
    "Trade License",
    "Contract",
    "Signed Agreement",
    "Purchase Order",
    "Invoice",
    "Images",
    "PDFs",
    "Other Attachments",
  ],
  contact: [
    "Business Card",
    "Signed Agreement",
    "Images",
    "PDFs",
    "Other Attachments",
  ],
  lead: [
    "Business Card",
    "Quotation",
    "Proposal",
    "BOQ",
    "Drawing",
    "Contract",
    "Purchase Order",
    "Invoice",
    "Delivery Note",
    "Signed Agreement",
    "Images",
    "PDFs",
    "Other Attachments",
  ],
  event: ["Brochure", "Images", "PDFs", "Other Attachments"],
};

export const DOCUMENT_ENTITY_TYPES = Object.keys(DOCUMENT_CATEGORY_CATALOG) as DocumentEntityType[];

export function isDocumentEntityType(v: string): v is DocumentEntityType {
  return (DOCUMENT_ENTITY_TYPES as string[]).includes(v);
}

export function assertValidCategory(entityType: DocumentEntityType, category: string): void {
  if (!DOCUMENT_CATEGORY_CATALOG[entityType].includes(category)) {
    throw new AppError(400, `Invalid category "${category}" for ${entityType}`);
  }
}

export function assertValidUpload(mimeType: string, fileSize: number): void {
  if (!ALLOWED_DOCUMENT_MIME_TYPES.includes(mimeType)) {
    throw new AppError(400, `Unsupported file type: ${mimeType}`);
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new AppError(400, "Invalid file size");
  }
  if (fileSize > MAX_DOCUMENT_SIZE) {
    throw new AppError(413, `File exceeds the ${Math.round(MAX_DOCUMENT_SIZE / (1024 * 1024))}MB limit`);
  }
}

// Batch 25 — reserve an upload target for the AUTHENTICATED tenant. Returns the
// credential-free URL the client PUTs the bytes to (with its normal session
// AND the `uploadToken` in the X-Storage-Capability header), and the opaque
// `/objects/...` handle it echoes back when creating the document/version. The
// handle is bound to this tenant in the object inventory before any byte lands;
// a handle posted by another tenant (or never uploaded) is rejected on create.
export async function requestUploadURL(
  req: Request,
  input: { companyId: number; userId: number; contentType: string; size: number },
): Promise<{ uploadURL: string; objectPath: string; uploadToken: string }> {
  const reserved = await storage.reserveUpload(req, {
    companyId: input.companyId,
    userId: input.userId,
    kind: "document",
    contentType: input.contentType,
    declaredSize: input.size,
  });
  return { uploadURL: reserved.uploadURL, objectPath: reserved.reference, uploadToken: reserved.uploadToken };
}

// Credential-free download URL of the API byte route for a stored version
// (the route re-checks the current session, tenant and state on every
// request). Resolves to null when the object no longer exists (callers answer
// 404). Inline vs attachment is decided server-side from the stored type.
export async function getDownloadURL(
  base: string,
  input: { companyId: number; objectPath: string; userId: number | null; fileName: string; mimeType: string },
  ttlSec?: number,
): Promise<string | null> {
  return storage.mintDownloadUrl(base, {
    companyId: input.companyId,
    kind: "document",
    reference: input.objectPath,
    userId: input.userId,
    fileName: input.fileName,
    disposition: INLINE_SAFE_TYPES.has(input.mimeType.toLowerCase()) ? "inline" : "attachment",
    ttlSec,
  });
}
