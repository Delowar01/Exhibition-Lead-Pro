import { Router } from "express";
import { requireAuth, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateScanBody } from "@workspace/api-zod";
import { uploadScanImage } from "../lib/imageStorage.js";
import * as scans from "../services/scans.service.js";

const router = Router();
router.use(requireAuth);
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

export default router;
