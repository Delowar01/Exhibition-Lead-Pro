import { Router } from "express";
import { db } from "@workspace/db";
import { scansTable, companiesTable } from "@workspace/db";
import { eq, and, count, inArray, sql } from "drizzle-orm";
import { requireAuth, blockReadOnlyMutations, requirePermission, canAccessCompany, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { extractCardData, logAiError } from "../lib/ai.js";
import { uploadScanImage, streamScanImage } from "../lib/imageStorage.js";

const router = Router();
router.use(requireAuth);
router.use("/scans", blockReadOnlyMutations);
router.use("/scans", auditMutations("scans"));

/** Return the public-facing API image URL for a scan (or null if not stored). */
function scanImageApiUrl(scanId: number, hasImage: boolean): string | null {
  return hasImage ? `/api/scans/${scanId}/image` : null;
}

// GET /scans
router.get("/scans", async (req: AuthRequest, res) => {
  try {
    const { page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, parseInt(limit));
    const offset = (pageNum - 1) * limitNum;
    const conditions = req.user!.role !== "platform_owner" ? [inArray(scansTable.companyId, req.user!.accessibleCompanies)] : [];
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [{ total }] = await db.select({ total: count() }).from(scansTable).where(whereClause);
    const scans = await db.select().from(scansTable).where(whereClause).limit(limitNum).offset(offset).orderBy(scansTable.createdAt);
    const formatted = scans.map(s => ({
      ...s,
      extractedData: s.extractedData ? JSON.parse(s.extractedData) : null,
      imageUrl: scanImageApiUrl(s.id, s.imageUrl !== null),
    }));
    res.json({ scans: formatted, total });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /scans
router.post("/scans", requirePermission("scans", "create"), async (req: AuthRequest, res) => {
  try {
    const companyId = req.user!.companyId;
    if (!companyId) { res.status(400).json({ error: "No company context" }); return; }
    const { imageData, eventId, appLanguage } = req.body;
    if (!imageData) { res.status(400).json({ error: "imageData required" }); return; }
    const lang = appLanguage === "ar" ? "ar" : "en";

    // Increment company scans used
    await db.update(companiesTable).set({ scansUsed: sql`${companiesTable.scansUsed} + 1` }).where(eq(companiesTable.id, companyId));

    // Create scan record
    const [scan] = await db.insert(scansTable).values({ companyId, userId: req.user!.id, status: "processing", imageUrl: null, extractedData: null }).returning();

    // Real AI OCR + extraction (image upload happens after, fire-and-forget)
    let ocrResult: Awaited<ReturnType<typeof extractCardData>> | null = null;
    let ocrErr: unknown = null;
    try {
      ocrResult = await extractCardData(imageData, lang);
    } catch (err) {
      ocrErr = err;
    }

    // Upload image to object storage after OCR — best-effort, non-blocking
    void (async () => {
      try {
        const objectKey = await uploadScanImage(scan.id, companyId, imageData);
        await db.update(scansTable).set({ imageUrl: objectKey }).where(eq(scansTable.id, scan.id));
      } catch (imgErr) {
        req.log.warn({ err: imgErr }, "scan image upload failed; stored image unavailable");
      }
    })();

    if (ocrErr !== null) {
      logAiError("scan-ocr", ocrErr);
      const [failed] = await db.update(scansTable)
        .set({ status: "failed" })
        .where(eq(scansTable.id, scan.id))
        .returning();
      res.status(502).json({
        ...failed,
        extractedData: null,
        imageUrl: scanImageApiUrl(scan.id, true),
        error: "Could not read the card. Please retake the photo.",
      });
      return;
    }

    const [updated] = await db.update(scansTable)
      .set({ status: "completed", extractedData: JSON.stringify(ocrResult!.fields), rawOcr: ocrResult!.rawOcr, confidence: ocrResult!.confidence })
      .where(eq(scansTable.id, scan.id))
      .returning();
    res.status(201).json({
      ...updated,
      extractedData: ocrResult!.fields,
      imageUrl: scanImageApiUrl(scan.id, true),
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /scans/:id/image — streams the stored card image (auth-protected)
// MUST be declared before GET /scans/:id to avoid param-swallowing
router.get("/scans/:id/image", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [scan] = await db.select().from(scansTable).where(eq(scansTable.id, id)).limit(1);
    if (!scan || !canAccessCompany(req.user, scan.companyId)) {
      res.status(404).json({ error: "Scan not found" });
      return;
    }
    if (!scan.imageUrl) {
      res.status(404).json({ error: "No image stored for this scan" });
      return;
    }
    try {
      const { stream, contentType } = await streamScanImage(scan.imageUrl);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=86400");
      stream.pipe(res);
    } catch {
      res.status(404).json({ error: "Image not found in storage" });
    }
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /scans/:id
router.get("/scans/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [scan] = await db.select().from(scansTable).where(eq(scansTable.id, id)).limit(1);
    if (!scan || !canAccessCompany(req.user, scan.companyId)) { res.status(404).json({ error: "Scan not found" }); return; }
    res.json({
      ...scan,
      extractedData: scan.extractedData ? JSON.parse(scan.extractedData) : null,
      imageUrl: scanImageApiUrl(scan.id, scan.imageUrl !== null),
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
