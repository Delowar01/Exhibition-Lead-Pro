import { Router } from "express";
import { requireAuth, requireRole, type AuthRequest } from "../middlewares/requireAuth.js";
import { AppError } from "../middlewares/errorHandler.js";
import * as platformPlans from "../services/platform-plans.service.js";

// Batch 39 — Plan Builder foundation: READ-ONLY platform-owner plan catalog.
// Behind the same platform firewall as the subscription administration
// (requireRole("platform_owner") → tenant users receive 403 without existence
// leakage). There is deliberately NO POST / PUT / PATCH / DELETE here: editing a
// published plan's entitlements in place is unsafe for every subscriber, and the
// versioned Plan Builder (drafts, immutable published versions) is pending the
// owner's data-model approval (PB-1.4 / PB-2).
const router = Router();
router.use(requireAuth);
router.use("/platform/plans", requireRole("platform_owner"));

router.get("/platform/plans", async (_req: AuthRequest, res) => {
  res.json(await platformPlans.listPlanCatalog());
});

router.get("/platform/plans/:planId", async (req: AuthRequest, res) => {
  res.json(await platformPlans.getPlanDetail(String(req.params.planId)));
});

router.get("/platform/plans/:planId/effective-limits/:companyId", async (req: AuthRequest, res) => {
  const raw = String(req.params.companyId ?? "");
  const companyId = /^\d{1,12}$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isInteger(companyId) || companyId <= 0) throw new AppError(400, "companyId must be a positive integer", { code: "INVALID_COMPANY_ID" });
  res.json(await platformPlans.previewEffectiveLimits(String(req.params.planId), companyId));
});

export default router;
