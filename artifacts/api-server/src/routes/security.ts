import { Router } from "express";
import { requireAuth, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { UpdateSecurityPolicyBody } from "@workspace/api-zod";
import * as security from "../services/security.service.js";

const router = Router();
router.use(requireAuth);
router.use("/security", blockReadOnlyMutations);
router.use("/security", auditMutations("security"));

// GET /security/policy
router.get("/security/policy", requirePermission("security", "view"), async (req: AuthRequest, res) => {
  const companyId = req.query.companyId ? parseInt(String(req.query.companyId)) : undefined;
  res.json(await security.getPolicy(req.user!, companyId));
});

// PATCH /security/policy
router.patch("/security/policy", requirePermission("security", "edit"), validateBody(UpdateSecurityPolicyBody), async (req: AuthRequest, res) => {
  res.json(await security.updatePolicy(req.user!, req.body ?? {}));
});

// GET /security/events
router.get("/security/events", requirePermission("security", "view"), async (req: AuthRequest, res) => {
  const limit = req.query.limit ? parseInt(String(req.query.limit)) : 100;
  res.json(await security.listEvents(req.user!, limit));
});

export default router;
