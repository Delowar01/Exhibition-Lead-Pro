import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateScanBody, ReprocessScanBody, ReplaceScanImageBody, AnalyzeCaptureBody, StartCaptureBatchBody } from "@workspace/api-zod";
import { uploadScanImage } from "../lib/imageStorage.js";
import * as scans from "../services/scans.service.js";
import { analyzeCapture } from "../services/capture-intelligence.service.js";
import { startCaptureBatch, getCaptureBatch } from "../services/capture-batch.service.js";

const router = Router();
router.use(requireAuth);
router.use("/scans", requireTenantUser);
router.use("/scans", blockReadOnlyMutations);
router.use("/scans", auditMutations("scans"));

// GET /scans
router.get("/scans", async (req: AuthRequest, res) => {
  const result = await scans.listScans(req.user!, req.query as Record<string, string>);
  res.json(result);
});

// POST /scans
router.post("/scans", requirePermission("scans", "create"), validateBody(CreateScanBody), async (req: AuthRequest, res) => {
  const { scanId, companyId, imageData, status, body } = await scans.createScan(req.user!, req.body ?? {});

  // Upload image to object storage after OCR — best-effort, non-blocking
  void (async () => {
    try {
      const objectKey = await uploadScanImage(scanId, companyId, imageData);
      await scans.setScanImageUrl(scanId, objectKey);
    } catch (imgErr) {
      req.log.warn({ err: imgErr }, "scan image upload failed; stored image unavailable");
    }
  })();

  res.status(status).json(body);
});

// POST /scans/analyze — read-only intelligent-capture analysis over not-yet-saved
// fields (validation + recognition + suggestions). Never writes/links/merges.
// MUST be declared before /scans/:id so "analyze" is not swallowed as an :id.
router.post("/scans/analyze", requirePermission("scans", "view"), validateBody(AnalyzeCaptureBody), async (req: AuthRequest, res) => {
  const body = req.body as { fields: Record<string, unknown>; includeAi?: boolean };
  res.json(await analyzeCapture(req.user!, body.fields, { includeAi: body.includeAi }));
});

// POST /scans/batch-analyze — enqueue read-only analysis for many captured cards (202).
router.post("/scans/batch-analyze", requirePermission("scans", "view"), validateBody(StartCaptureBatchBody), async (req: AuthRequest, res) => {
  const body = req.body as { items: Array<{ key: string; fields: Record<string, unknown> }> };
  res.status(202).json(await startCaptureBatch(req.user!, body.items));
});

// GET /scans/batch/:jobId — poll capture batch-analysis status + per-item results.
// MUST be declared before /scans/:id so "batch" is not swallowed as an :id.
router.get("/scans/batch/:jobId", requirePermission("scans", "view"), async (req: AuthRequest, res) => {
  res.json(getCaptureBatch(req.user!, String(req.params.jobId)));
});

// GET /scans/:id/image — streams the stored card image (auth-protected)
// MUST be declared before GET /scans/:id to avoid param-swallowing
router.get("/scans/:id/image", async (req: AuthRequest, res) => {
  const id = parseInt(String(req.params.id));
  const { stream, contentType } = await scans.getScanImageStream(req.user!, id);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=86400");
  stream.pipe(res);
});

// GET /scans/:id
router.get("/scans/:id", async (req: AuthRequest, res) => {
  const id = parseInt(String(req.params.id));
  const scan = await scans.getScan(req.user!, id);
  res.json(scan);
});

// POST /scans/:id/reprocess — re-run OCR on the stored image
router.post("/scans/:id/reprocess", requirePermission("scans", "create"), validateBody(ReprocessScanBody), async (req: AuthRequest, res) => {
  const id = parseInt(String(req.params.id));
  res.json(await scans.reprocessScan(req.user!, id, req.body ?? {}));
});

// POST /scans/:id/replace-image — replace the stored image + re-run OCR
router.post("/scans/:id/replace-image", requirePermission("scans", "create"), validateBody(ReplaceScanImageBody), async (req: AuthRequest, res) => {
  const id = parseInt(String(req.params.id));
  res.json(await scans.replaceScanImage(req.user!, id, req.body ?? {}));
});

// POST /scans/:id/score — AI lead-score preview over the extracted fields
router.post("/scans/:id/score", requirePermission("scans", "create"), async (req: AuthRequest, res) => {
  const id = parseInt(String(req.params.id));
  res.json(await scans.scoreScan(req.user!, id));
});

export default router;
