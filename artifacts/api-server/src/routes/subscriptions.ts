import { Router, type Response, type NextFunction } from "express";
import { requireAuth, requireTenantUser, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateCheckoutSessionBody } from "@workspace/api-zod";
import { getClientIp } from "../lib/security.js";
import * as subscriptions from "../services/subscriptions.service.js";

// Batch 20 — tenant subscription routes.
//   • every route requires authentication AND a tenant user (platform operators
//     are fenced out even when their account carries a companyId);
//   • the company is derived from the authenticated context only;
//   • reads need subscriptions:view, self-service billing needs subscriptions:manage;
//   • reads NEVER write (no lazy insert);
//   • Checkout / Portal are the narrowly scoped billing-recovery exceptions:
//     a read-only (past_due / cancelled) tenant may reach them — ordinary CRM
//     mutations stay blocked by blockReadOnlyMutations on their own routers.
//   • POST /subscriptions/upgrade is RETIRED (410, never mutates).
const router = Router();
router.use(requireAuth);
router.use("/subscriptions", requireTenantUser);

function actorOf(req: AuthRequest) {
  return { userId: req.user!.id, userName: req.user!.email, ipAddress: getClientIp(req) };
}

// GET /subscriptions/current — canonical projection + capabilities + limits + usage.
router.get("/subscriptions/current", requirePermission("subscriptions", "view"), async (req: AuthRequest, res) => {
  res.json(await subscriptions.getCurrentSubscription(req.user!));
});

// GET /subscriptions/usage — real usage against effective limits (same calculation as enforcement).
router.get("/subscriptions/usage", requirePermission("subscriptions", "view"), async (req: AuthRequest, res) => {
  res.json(await subscriptions.getUsage(req.user!));
});

// GET /subscriptions/plans — plan catalog with verified provider prices only.
router.get("/subscriptions/plans", requirePermission("subscriptions", "view"), async (_req: AuthRequest, res) => {
  res.json(await subscriptions.listPlans());
});

// POST /subscriptions/checkout — Stripe-hosted Checkout (subscription mode).
router.post("/subscriptions/checkout", requirePermission("subscriptions", "manage"), validateBody(CreateCheckoutSessionBody), async (req: AuthRequest, res) => {
  res.json(await subscriptions.createCheckout(req.user!, req.body ?? {}, actorOf(req)));
});

// POST /subscriptions/portal — Stripe-hosted Billing Portal session.
router.post("/subscriptions/portal", requirePermission("subscriptions", "manage"), async (req: AuthRequest, res) => {
  res.json(await subscriptions.createPortalSession(req.user!, actorOf(req)));
});

// POST /subscriptions/upgrade — compatibility tombstone. The pre-Batch 20 route
// activated any plan without payment or authorization; it is retired and never
// touches state.
function retired(_req: AuthRequest, res: Response, _next: NextFunction) {
  res.status(410).json({ error: "Direct plan upgrades have been retired. Use checkout or contact the platform operator.", code: "BILLING_UPGRADE_RETIRED" });
}
router.post("/subscriptions/upgrade", retired);

export default router;
