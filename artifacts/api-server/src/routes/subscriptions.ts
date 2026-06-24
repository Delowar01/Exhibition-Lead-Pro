import { Router } from "express";
import { requireAuth, requireWritable, blockReadOnlyMutations, type AuthRequest } from "../middlewares/requireAuth.js";
import { writeAudit } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { UpgradeSubscriptionBody } from "@workspace/api-zod";
import * as subscriptions from "../services/subscriptions.service.js";

const router = Router();
router.use(requireAuth);
router.use("/subscriptions", blockReadOnlyMutations);

// GET /subscriptions/current
router.get("/subscriptions/current", async (req: AuthRequest, res) => {
  const sub = await subscriptions.getCurrentSubscription(req.user!);
  res.json(sub);
});

// GET /subscriptions/plans
router.get("/subscriptions/plans", async (_req: AuthRequest, res) => {
  const plans = await subscriptions.listPlans();
  res.json(plans);
});

// POST /subscriptions/upgrade
router.post("/subscriptions/upgrade", requireWritable, validateBody(UpgradeSubscriptionBody), async (req: AuthRequest, res) => {
  const { sub, companyId, plan } = await subscriptions.upgradeSubscription(req.user!, req.body ?? {});
  await writeAudit(req, { action: "subscription.upgrade", entityType: "subscription", entityId: companyId, metadata: { plan } });
  res.json(sub);
});

export default router;
