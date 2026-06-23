import { AppError } from "../middlewares/errorHandler.js";
import { type AuthUser } from "../middlewares/requireAuth.js";
import { extractCardData, logAiError } from "../lib/ai.js";
import { streamScanImage } from "../lib/imageStorage.js";
import * as scansRepo from "../repositories/scans.repository.js";

/** Return the public-facing API image URL for a scan (or null if not stored). */
export function scanImageApiUrl(scanId: number, hasImage: boolean): string | null {
  return hasImage ? `/api/scans/${scanId}/image` : null;
}

export async function listScans(user: AuthUser, query: Record<string, string>) {
  const { page = "1", limit = "20" } = query;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit));
  const offset = (pageNum - 1) * limitNum;
  const { rows: scans, total } = await scansRepo.list(user, { limit: limitNum, offset });
  const formatted = scans.map((s) => ({
    ...s,
    extractedData: s.extractedData ? JSON.parse(s.extractedData) : null,
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

export async function createScan(user: AuthUser, body: { imageData?: string; eventId?: unknown; appLanguage?: string }): Promise<CreateScanResult> {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const { imageData, appLanguage } = body;
  if (!imageData) throw new AppError(400, "imageData required");
  const lang = appLanguage === "ar" ? "ar" : "en";

  // Increment company scans used
  await scansRepo.incrementScansUsed(companyId);

  // Create scan record
  const scan = await scansRepo.insert({ companyId, userId: user.id, status: "processing", imageUrl: null, extractedData: null });

  // Real AI OCR + extraction (image upload happens after, fire-and-forget in route)
  let ocrResult: Awaited<ReturnType<typeof extractCardData>> | null = null;
  let ocrErr: unknown = null;
  try {
    ocrResult = await extractCardData(imageData, lang);
  } catch (err) {
    ocrErr = err;
  }

  if (ocrErr !== null) {
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
  });
  return {
    scanId: scan.id,
    companyId,
    imageData,
    status: 201,
    body: {
      ...updated,
      extractedData: ocrResult!.fields,
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
    imageUrl: scanImageApiUrl(scan.id, scan.imageUrl !== null),
  };
}
