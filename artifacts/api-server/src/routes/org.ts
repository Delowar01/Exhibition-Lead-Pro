import { Router } from "express";
import { requireAuth, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import * as org from "../services/org.service.js";

const router = Router();
router.use(requireAuth);
router.use("/organization", blockReadOnlyMutations);
router.use("/organization", auditMutations("organization"));

// GET /organization — the caller's own organization profile.
router.get("/organization", requirePermission("organization", "view"), async (req: AuthRequest, res) => {
  const companyId = req.query.companyId ? parseInt(String(req.query.companyId)) : undefined;
  res.json(await org.getMyOrg(req.user!, companyId));
});

// PATCH /organization
router.patch("/organization", requirePermission("organization", "edit"), async (req: AuthRequest, res) => {
  res.json(await org.updateMyOrg(req.user!, req.body ?? {}));
});

export default router;
