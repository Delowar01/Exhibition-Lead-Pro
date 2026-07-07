import { AppError } from "../middlewares/errorHandler.js";
import { type AuthUser } from "../middlewares/requireAuth.js";
import { extractCardData, scoreLead, logAiError, type ExtractedCardData } from "../lib/ai.js";
import { streamScanImage, loadScanImageBase64, uploadScanImage } from "../lib/imageStorage.js";
import * as scansRepo from "../repositories/scans.repository.js";
import { parseListQuery } from "../lib/list-query.js";
import { analyzeCaptureFields } from "../lib/capture-validation.js";

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

export async function createScan(user: AuthUser, body: { imageData?: string; eventId?: unknown; appLanguage?: string; captureSource?: string | null; qualityScore?: number | null; qualityMeta?: unknown }): Promise<CreateScanResult> {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const { imageData, appLanguage } = body;
  if (!imageData) throw new AppError(400, "imageData required");
  const lang = appLanguage === "ar" ? "ar" : "en";
  const captureSource = typeof body.captureSource === "string" && body.captureSource.length > 0 ? body.captureSource : "camera";
  const qualityScore = typeof body.qualityScore === "number" ? body.qualityScore : null;
  const qualityMeta = body.qualityMeta != null ? JSON.stringify(body.qualityMeta) : null;

  // Increment company scans used
  await scansRepo.incrementScansUsed(companyId);

  // Create scan record
  const scan = await scansRepo.insert({ companyId, userId: user.id, status: "processing", imageUrl: null, extractedData: null });

  // Real AI OCR + extraction (image upload happens after, fire-and-forget in route)
  let ocrResult: Awaited<ReturnType<typeof extractCardData>> | null = null;
  let ocrErr: unknown = null;
  try {
    ocrResult = await extractCardData(imageData, lang, { companyId, userId: user.id });
  } catch (err) {
    ocrErr = err;
  }

  if (ocrErr !== null) {
    // Enforcement rejections (AI disabled / budget exhausted) surface with their real
    // status instead of being masked as a generic "could not read the card" 502.
    if (ocrErr instanceof AppError) throw ocrErr;
    logAiError("scan-ocr", ocrErr);
    const failed = await scansRepo.update(scan.id, { status: "failed" });
    return {
      scanId: scan.id,
      companyId,
      imageData,
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
    imageData,
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
  if (!body.imageData) throw new AppError(400, "imageData required");
  const lang = body.appLanguage === "ar" ? "ar" : "en";

  let objectKey: string;
  try {
    objectKey = await uploadScanImage(id, scan.companyId, body.imageData);
  } catch (err) {
    logAiError("scan-replace-upload", err);
    throw new AppError(502, "Could not store the replacement image. Please try again.");
  }
  await scansRepo.setImageUrl(id, objectKey);

  let ocr: Awaited<ReturnType<typeof extractCardData>>;
  try {
    ocr = await extractCardData(body.imageData, lang, { companyId: user.companyId, userId: user.id });
  } catch (err) {
    if (err instanceof AppError) throw err;
    logAiError("scan-replace-ocr", err);
    await scansRepo.update(id, { status: "failed" });
    throw new AppError(502, "Image replaced, but the card could not be read. Try Reprocess OCR.");
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
