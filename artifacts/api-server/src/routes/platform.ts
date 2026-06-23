import { Router } from "express";
import { requireAuth, requireRole, type AuthRequest } from "../middlewares/requireAuth.js";
import * as platform from "../services/platform.service.js";

const router = Router();
router.use(requireAuth);
router.use("/platform", requireRole("platform_owner"));

// GET /platform/stats
router.get("/platform/stats", async (_req: AuthRequest, res) => {
  res.json(await platform.getStats());
});

// GET /platform/revenue-trend
router.get("/platform/revenue-trend", async (_req: AuthRequest, res) => {
  res.json(await platform.getRevenueTrend());
});

// GET /platform/scan-trend
router.get("/platform/scan-trend", async (_req: AuthRequest, res) => {
  res.json(await platform.getScanTrend());
});

// GET /platform/activity
router.get("/platform/activity", async (_req: AuthRequest, res) => {
  res.json(await platform.getActivity());
});

export default router;
