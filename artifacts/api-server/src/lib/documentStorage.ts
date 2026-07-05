import { ObjectStorageService } from "./objectStorage.js";
import { AppError } from "../middlewares/errorHandler.js";

const objectStorage = new ObjectStorageService();

// ── Upload constraints (enforced at both upload-URL request and create/version).
export const MAX_DOCUMENT_SIZE = 25 * 1024 * 1024; // 25 MB

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

// Request a presigned PUT URL for a direct-to-storage upload. Returns both the
// signed URL (client PUTs the file here) and the normalized `/objects/...` path
// the client echoes back when creating the document/version.
export async function requestUploadURL(): Promise<{ uploadURL: string; objectPath: string }> {
  const uploadURL = await objectStorage.getObjectEntityUploadURL();
  const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);
  return { uploadURL, objectPath };
}

// Mint a short-lived signed GET URL for download/preview. Throws
// ObjectNotFoundError (mapped to 404 by callers) if the object is missing.
export async function getDownloadURL(objectPath: string, ttlSec = 300): Promise<string> {
  return objectStorage.getObjectEntityDownloadURL(objectPath, ttlSec);
}
