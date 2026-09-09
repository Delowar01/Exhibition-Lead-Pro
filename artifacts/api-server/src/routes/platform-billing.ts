import { Router } from "express";
import { requireAuth, requireRole, type AuthRequest } from "../middlewares/requireAuth.js";
import { validateBody } from "../middlewares/validate.js";
import {
  PlatformSetSubscriptionPlanBody,
  PlatformStartTrialBody,
  PlatformSuspendSubscriptionBody,
  PlatformSetSubscriptionLimitsBody,
  PlatformRegisterPriceBody,
  PlatformUpdatePriceBody,
} from "@workspace/api-zod";
import { getClientIp } from "../lib/security.js";
import { AppError } from "../middlewares/errorHandler.js";
import * as lifecycle from "../services/subscription-lifecycle.service.js";
import * as platformBilling from "../services/platform-billing.service.js";
import { projectSubscription } from "../services/subscriptions.service.js";

// Batch 20 — platform-owner manual subscription lifecycle + provider price
// mappings. Explicit-company routes behind the existing platform firewall
// (requireRole("platform_owner")); every mutation goes through the transactional
// lifecycle service (row lock + transition table + mirror + before/after audit).
// Tenant users never reach these routes (403 without existence leakage).
const router = Router();
router.use(requireAuth);
router.use("/platform/subscriptions", requireRole("platform_owner"));
router.use("/platform/billing", requireRole("platform_owner"));

function actorOf(req: AuthRequest) {
  return { userId: req.user!.id, userName: req.user!.email, ipAddress: getClientIp(req) };
}
function companyIdParam(req: AuthRequest): number {
  const id = Number.parseInt(String(req.params.companyId), 10);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, "Invalid company id");
  return id;
}
async function respond(res: import("express").Response, companyId: number) {
  res.json(await platformBilling.getSubscriptionDetail(companyId));
}

// ── read ────────────────────────────────────────────────────────────────────
router.get("/platform/subscriptions", async (req: AuthRequest, res) => {
  res.json(await platformBilling.listSubscriptions(req.query as platformBilling.ListParams));
});
router.get("/platform/subscriptions/metrics", async (_req: AuthRequest, res) => {
  res.json({ ...(await platformBilling.subscriptionMetrics()), revenue: await platformBilling.revenueSnapshot() });
});
router.get("/platform/subscriptions/:companyId", async (req: AuthRequest, res) => {
  await respond(res, companyIdParam(req));
});
router.get("/platform/subscriptions/:companyId/events", async (req: AuthRequest, res) => {
  res.json({ events: await platformBilling.listRecentProviderEvents(companyIdParam(req)) });
});

// ── manual lifecycle ────────────────────────────────────────────────────────
router.post("/platform/subscriptions/:companyId/plan", validateBody(PlatformSetSubscriptionPlanBody), async (req: AuthRequest, res) => {
  await lifecycle.setPlan(companyIdParam(req), actorOf(req), req.body ?? {});
  await respond(res, companyIdParam(req));
});
router.post("/platform/subscriptions/:companyId/trial", validateBody(PlatformStartTrialBody), async (req: AuthRequest, res) => {
  await lifecycle.startTrial(companyIdParam(req), actorOf(req), req.body ?? {});
  await respond(res, companyIdParam(req));
});
router.post("/platform/subscriptions/:companyId/activate", async (req: AuthRequest, res) => {
  await lifecycle.activate(companyIdParam(req), actorOf(req));
  await respond(res, companyIdParam(req));
});
router.post("/platform/subscriptions/:companyId/past-due", async (req: AuthRequest, res) => {
  await lifecycle.markPastDue(companyIdParam(req), actorOf(req));
  await respond(res, companyIdParam(req));
});
router.post("/platform/subscriptions/:companyId/cancel", async (req: AuthRequest, res) => {
  await lifecycle.cancel(companyIdParam(req), actorOf(req));
  await respond(res, companyIdParam(req));
});
router.post("/platform/subscriptions/:companyId/expire", async (req: AuthRequest, res) => {
  await lifecycle.expire(companyIdParam(req), actorOf(req));
  await respond(res, companyIdParam(req));
});
router.post("/platform/subscriptions/:companyId/suspend", validateBody(PlatformSuspendSubscriptionBody), async (req: AuthRequest, res) => {
  await lifecycle.suspend(companyIdParam(req), actorOf(req), req.body ?? {});
  await respond(res, companyIdParam(req));
});
router.post("/platform/subscriptions/:companyId/reactivate", async (req: AuthRequest, res) => {
  await lifecycle.reactivate(companyIdParam(req), actorOf(req));
  await respond(res, companyIdParam(req));
});
router.put("/platform/subscriptions/:companyId/limits", validateBody(PlatformSetSubscriptionLimitsBody), async (req: AuthRequest, res) => {
  await lifecycle.setLimitOverrides(companyIdParam(req), actorOf(req), req.body ?? {});
  await respond(res, companyIdParam(req));
});
router.post("/platform/subscriptions/:companyId/convert-to-manual", async (req: AuthRequest, res) => {
  await lifecycle.convertToManual(companyIdParam(req), actorOf(req));
  await respond(res, companyIdParam(req));
});
router.post("/platform/subscriptions/:companyId/sync", async (req: AuthRequest, res) => {
  const result = await lifecycle.syncFromProvider(companyIdParam(req), actorOf(req));
  res.json({ outcome: result.outcome, subscription: await projectSubscription(result.subscription) });
});

// ── provider status + price mappings ────────────────────────────────────────
router.get("/platform/billing/status", async (_req: AuthRequest, res) => {
  res.json(platformBilling.providerStatus());
});
router.get("/platform/billing/prices", async (_req: AuthRequest, res) => {
  res.json({ prices: await platformBilling.listPrices() });
});
router.post("/platform/billing/prices", validateBody(PlatformRegisterPriceBody), async (req: AuthRequest, res) => {
  res.status(201).json(await platformBilling.registerPrice(actorOf(req), req.body ?? {}));
});
router.patch("/platform/billing/prices/:id", validateBody(PlatformUpdatePriceBody), async (req: AuthRequest, res) => {
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) throw new AppError(400, "Invalid price id");
  res.json(await platformBilling.setPriceActive(actorOf(req), id, (req.body as { active: boolean }).active));
});

export default router;
