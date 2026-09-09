import { AppError } from "../middlewares/errorHandler.js";
import { type AuthUser } from "../middlewares/requireAuth.js";
import { refInCompany } from "../lib/tenant.js";
import { extractCardData, scoreLead, logAiError, type ExtractedCardData } from "../lib/ai.js";
import { validateScanImage, hasReadableCard } from "../lib/image-validation.js";
import { streamScanImage, loadScanImageBase64, uploadScanImage } from "../lib/imageStorage.js";
import * as scansRepo from "../repositories/scans.repository.js";
import { parseListQuery } from "../lib/list-query.js";
import { analyzeCaptureFields } from "../lib/capture-validation.js";
import { createHash } from "node:crypto";
import { reserveScans, consumeReservation, releaseReservation } from "./entitlements.service.js";

// Builds the additive OCR-metadata + deterministic-validation columns persisted on a
// scan after a successful extraction. `captureSource` defaults to "camera" (the only
// server-side capture path today); QR/vCard/NFC callers pass their own source. The
// validation summary is computed deterministically from the extracted fields — no AI,
// no fabrication — and stored so the review UI can show it without re-deriving.
function ocrPersistFields(
  ocr: Awaited<ReturnType<typeof extractCardData>>,
  captureSource = "camera",
): Record<string, unknown> {
  const v = analyzeCaptureFields({
    firstName: ocr.fields.firstName,
    lastName: ocr.fields.lastName,
    jobTitle: ocr.fields.jobTitle,
    company: ocr.fields.company,
    email: ocr.fields.email,
    mobile: ocr.fields.mobile,
    website: ocr.fields.website,
    linkedin: ocr.fields.linkedin,
    address: ocr.fields.address,
    city: ocr.fields.city,
    country: ocr.fields.country,
    postalCode: ocr.fields.postalCode,
  });
  return {
    fieldConfidences: JSON.stringify(ocr.fieldConfidences),
    extractionMethod: ocr.extractionMethod,
    captureSource,
    aiModel: ocr.model,
    promptVersion: ocr.promptVersion,
    processingTimeMs: ocr.processingTimeMs,
    validationStatus: JSON.stringify({ validations: v.validations, suggestions: v.suggestions, detectedCountry: v.detectedCountry, detectedDialCode: v.detectedDialCode }),
  };
}

/** Return the public-facing API image URL for a scan (or null if not stored). */
export function scanImageApiUrl(scanId: number, hasImage: boolean): string | null {
  return hasImage ? `/api/scans/${scanId}/image` : null;
}

function parseJsonSafe(v: string | null | undefined): unknown {
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return null; }
}

// The additive Stage 5E metadata columns are stored as JSON text but exposed as objects
// in the API contract — parse them for every scan response so clients get structured data.
function parsedScanMeta(row: { fieldConfidences?: string | null; validationStatus?: string | null; qualityMeta?: string | null } | undefined) {
  return {
    fieldConfidences: parseJsonSafe(row?.fieldConfidences),
    validationStatus: parseJsonSafe(row?.validationStatus),
    qualityMeta: parseJsonSafe(row?.qualityMeta),
  };
}

export async function listScans(user: AuthUser, query: Record<string, string>) {
  const { page: pageNum, limit: limitNum, offset } = parseListQuery(query, { defaultPageSize: 20, maxPageSize: 100 });
  const { rows: scans, total } = await scansRepo.list(user, { limit: limitNum, offset });
  const formatted = scans.map((s) => ({
    ...s,
    extractedData: s.extractedData ? JSON.parse(s.extractedData) : null,
    ...parsedScanMeta(s),
    imageUrl: scanImageApiUrl(s.id, s.imageUrl !== null),
  }));
  return { scans: formatted, total };
}

export interface CreateScanResult {
  scanId: number;
  companyId: number;
  imageData: string;
  status: number;
  body: Record<string, unknown>;
}

export async function createScan(user: AuthUser, body: { imageData?: string; eventId?: unknown; appLanguage?: string; captureSource?: string | null; qualityScore?: number | null; qualityMeta?: unknown; latitude?: number | null; longitude?: number | null; gpsAccuracy?: number | null; notes?: string | null }): Promise<CreateScanResult> {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const { appLanguage } = body;
  // Batch 7: validate the actual image bytes (magic numbers, size, emptiness) BEFORE
  // creating a scan row, incrementing usage, or touching the AI provider. Bad input
  // is a 400 with a machine code and never records provider token usage.
  const image = validateScanImage(body.imageData);
  const lang = appLanguage === "ar" ? "ar" : "en";
  const captureSource = typeof body.captureSource === "string" && body.captureSource.length > 0 ? body.captureSource : "camera";
  const qualityScore = typeof body.qualityScore === "number" ? body.qualityScore : null;
  const qualityMeta = body.qualityMeta != null ? JSON.stringify(body.qualityMeta) : null;
  // Interaction context: event + GPS + notes captured at scan time are persisted
  // on the scan itself so it becomes a permanent interaction record. The eventId
  // is bound to the scan's own tenant.
  const eventId = typeof body.eventId === "number" && Number.isInteger(body.eventId) ? body.eventId : null;
  if (eventId != null && !(await refInCompany("events", companyId, eventId))) throw new AppError(400, "Invalid eventId");
  const latitude = typeof body.latitude === "number" ? body.latitude : null;
  const longitude = typeof body.longitude === "number" ? body.longitude : null;
  const gpsAccuracy = typeof body.gpsAccuracy === "number" ? body.gpsAccuracy : null;
  const notes = typeof body.notes === "string" && body.notes.trim().length > 0 ? body.notes : null;

  // Batch 20: reserve scan capacity BEFORE any provider work, under the tenant
  // lock, keyed by the image content so a retry of the same capture never consumes
  // twice. The legacy companies.scans_used counter is deprecated and no longer written.
  const reservationKey = `scan:${companyId}:${user.id}:${createHash("sha256").update(image.dataUrl).digest("hex").slice(0, 32)}`;
  const reservation = await reserveScans(companyId, reservationKey, 1);

  // Create scan record
  const scan = await scansRepo.insert({ companyId, userId: user.id, status: "processing", imageUrl: null, extractedData: null, eventId, latitude, longitude, gpsAccuracy, notes });

  // Real AI OCR + extraction (image upload happens after, fire-and-forget in route)
  let ocrResult: Awaited<ReturnType<typeof extractCardData>> | null = null;
  let ocrErr: unknown = null;
  try {
    ocrResult = await extractCardData(image.dataUrl, lang, { companyId, userId: user.id });
  } catch (err) {
    ocrErr = err;
  }

  if (ocrErr !== null) {
    // Enforcement rejections (AI disabled / budget exhausted / rate limited) surface
    // with their real status instead of being masked as a generic 502. The scan row
    // was written optimistically — reconcile it and release the unused reservation so
    // a denied scan never strands a "processing" row or consumes quota.
    if (ocrErr instanceof AppError) {
      await scansRepo.update(scan.id, { status: "failed" });
      if (!reservation.alreadyConsumed) await releaseReservation(reservation.reservationId);
      throw ocrErr;
    }
    if (!reservation.alreadyConsumed) await releaseReservation(reservation.reservationId);
    logAiError("scan-ocr", ocrErr);
    const failed = await scansRepo.update(scan.id, { status: "failed" });
    return {
      scanId: scan.id,
      companyId,
      imageData: image.dataUrl,
      status: 502,
      body: {
        ...failed,
        extractedData: null,
        ...parsedScanMeta(failed),
        imageUrl: scanImageApiUrl(scan.id, true),
        error: "Could not read the card. Please retake the photo.",
      },
    };
  }

  // Controlled no-card result: extraction succeeded but the model found none of the
  // identity fields (name/company/email/phone). The scan is marked failed, the image
  // is kept (the route still uploads it) so the user can review/replace, and the
  // client gets an honest 422 instead of an empty "successful" extraction.
  if (!hasReadableCard(ocrResult!.fields)) {
    if (!reservation.alreadyConsumed) await releaseReservation(reservation.reservationId);
    const failed = await scansRepo.update(scan.id, { status: "failed", rawOcr: ocrResult!.rawOcr });
    return {
      scanId: scan.id,
      companyId,
      imageData: image.dataUrl,
      status: 422,
      body: {
        ...failed,
        extractedData: null,
        ...parsedScanMeta(failed),
        imageUrl: scanImageApiUrl(scan.id, true),
        code: "SCAN_NO_CARD",
        error: "No readable business card was found in this image. Please retake the photo.",
      },
    };
  }

  if (!reservation.alreadyConsumed) await consumeReservation(reservation.reservationId, scan.id);
  const updated = await scansRepo.update(scan.id, {
    status: "completed",
    extractedData: JSON.stringify(ocrResult!.fields),
    rawOcr: ocrResult!.rawOcr,
    confidence: ocrResult!.confidence,
    ...ocrPersistFields(ocrResult!, captureSource),
    qualityScore,
    qualityMeta,
  });
  return {
    scanId: scan.id,
    companyId,
    imageData: image.dataUrl,
    status: 201,
    body: {
      ...updated,
      extractedData: ocrResult!.fields,
      ...parsedScanMeta(updated),
      imageUrl: scanImageApiUrl(scan.id, true),
    },
  };
}

export async function setScanImageUrl(scanId: number, objectKey: string) {
  await scansRepo.setImageUrl(scanId, objectKey);
}

export async function getScanImageStream(user: AuthUser, id: number) {
  const scan = await scansRepo.findById(user, id);
  if (!scan) throw new AppError(404, "Scan not found");
  if (!scan.imageUrl) throw new AppError(404, "No image stored for this scan");
  try {
    return await streamScanImage(scan.imageUrl);
  } catch {
    throw new AppError(404, "Image not found in storage");
  }
}

export async function getScan(user: AuthUser, id: number) {
  const scan = await scansRepo.findById(user, id);
  if (!scan) throw new AppError(404, "Scan not found");
  return {
    ...scan,
    extractedData: scan.extractedData ? JSON.parse(scan.extractedData) : null,
    ...parsedScanMeta(scan),
    imageUrl: scanImageApiUrl(scan.id, scan.imageUrl !== null),
  };
}

/**
 * Re-run OCR extraction on the scan's already-stored image. Honest failure:
 * a 400 when no image is stored, a 404 when the stored image is gone, and a
 * 502 when the AI OCR call fails (the scan is marked failed).
 */
export async function reprocessScan(user: AuthUser, id: number, body: { appLanguage?: string }) {
  const scan = await scansRepo.findById(user, id);
  if (!scan) throw new AppError(404, "Scan not found");
  if (!scan.imageUrl) throw new AppError(400, "No stored image to reprocess. Replace the image first.");
  const lang = body.appLanguage === "ar" ? "ar" : "en";

  let base64: string;
  try {
    base64 = await loadScanImageBase64(scan.imageUrl);
  } catch {
    throw new AppError(404, "Stored image is unavailable. Replace the image and try again.");
  }

  let ocr: Awaited<ReturnType<typeof extractCardData>>;
  try {
    ocr = await extractCardData(base64, lang, { companyId: user.companyId, userId: user.id });
  } catch (err) {
    if (err instanceof AppError) throw err;
    logAiError("scan-reprocess", err);
    await scansRepo.update(id, { status: "failed" });
    throw new AppError(502, "Could not re-read the card. Please try again or replace the image.");
  }

  if (!hasReadableCard(ocr.fields)) {
    await scansRepo.update(id, { status: "failed", rawOcr: ocr.rawOcr });
    throw new AppError(422, "No readable business card was found in this image. Replace the image and try again.", { code: "SCAN_NO_CARD" });
  }

  const updated = await scansRepo.update(id, {
    status: "completed",
    extractedData: JSON.stringify(ocr.fields),
    rawOcr: ocr.rawOcr,
    confidence: ocr.confidence,
    ...ocrPersistFields(ocr, scan.captureSource ?? "camera"),
  });
  return {
    ...updated,
    extractedData: ocr.fields,
    ...parsedScanMeta(updated),
    imageUrl: scanImageApiUrl(id, true),
  };
}

/**
 * Replace the stored card image and re-run OCR. The upload happens first so a
 * storage failure is surfaced honestly (502) before we touch the record; OCR
 * failure marks the scan failed but keeps the newly-stored image so the user
 * can Reprocess.
 */
export async function replaceScanImage(user: AuthUser, id: number, body: { imageData?: string; appLanguage?: string }) {
  const scan = await scansRepo.findById(user, id);
  if (!scan) throw new AppError(404, "Scan not found");
  // Batch 7: same byte-level validation as scan creation — before storage or AI.
  const image = validateScanImage(body.imageData);
  const lang = body.appLanguage === "ar" ? "ar" : "en";

  let objectKey: string;
  try {
    objectKey = await uploadScanImage(id, scan.companyId, image.dataUrl);
  } catch (err) {
    logAiError("scan-replace-upload", err);
    throw new AppError(502, "Could not store the replacement image. Please try again.");
  }
  await scansRepo.setImageUrl(id, objectKey);

  let ocr: Awaited<ReturnType<typeof extractCardData>>;
  try {
    ocr = await extractCardData(image.dataUrl, lang, { companyId: user.companyId, userId: user.id });
  } catch (err) {
    if (err instanceof AppError) {
      // The image swap already happened, so any previously extracted data no longer
      // matches the stored image — mark the scan failed (Reprocess OCR recovers it)
      // before surfacing the real denial status.
      await scansRepo.update(id, { status: "failed" });
      throw err;
    }
    logAiError("scan-replace-ocr", err);
    await scansRepo.update(id, { status: "failed" });
    throw new AppError(502, "Image replaced, but the card could not be read. Try Reprocess OCR.");
  }

  if (!hasReadableCard(ocr.fields)) {
    await scansRepo.update(id, { status: "failed", rawOcr: ocr.rawOcr });
    throw new AppError(422, "No readable business card was found in the replacement image. Try a clearer photo.", { code: "SCAN_NO_CARD" });
  }

  const updated = await scansRepo.update(id, {
    status: "completed",
    extractedData: JSON.stringify(ocr.fields),
    rawOcr: ocr.rawOcr,
    confidence: ocr.confidence,
    ...ocrPersistFields(ocr, scan.captureSource ?? "camera"),
  });
  return {
    ...updated,
    extractedData: ocr.fields,
    ...parsedScanMeta(updated),
    imageUrl: scanImageApiUrl(id, true),
  };
}

/**
 * Run AI lead scoring on the scan's already-extracted fields. This is a
 * grounded preview (not persisted to a contact — the scan may not have one
 * yet). 400 if there is nothing to score; 502 if the AI call fails.
 */
export async function scoreScan(user: AuthUser, id: number) {
  const scan = await scansRepo.findById(user, id);
  if (!scan) throw new AppError(404, "Scan not found");
  if (!scan.extractedData) throw new AppError(400, "No extracted data to score. Reprocess OCR first.");
  const fields = JSON.parse(scan.extractedData) as ExtractedCardData;

  try {
    const result = await scoreLead(
      {
        firstName: fields.firstName,
        lastName: fields.lastName,
        jobTitle: fields.jobTitle,
        contactCompany: fields.company,
        email: fields.email,
        mobile: fields.mobile,
        website: fields.website,
        linkedin: fields.linkedin,
      },
      undefined,
      { companyId: user.companyId, userId: user.id },
    );
    return { score: result.score, temperature: result.temperature, reasoning: result.reasoning };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logAiError("scan-score", err);
    throw new AppError(502, "AI scoring is temporarily unavailable. Please try again.");
  }
}
