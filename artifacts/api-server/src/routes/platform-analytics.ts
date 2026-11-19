import { Router } from "express";
import {
  GetPlatformAnalyticsOverviewQueryParams,
  GetPlatformAnalyticsGrowthQueryParams,
  GetPlatformAnalyticsSubscriptionsQueryParams,
  GetPlatformAnalyticsRevenueQueryParams,
  GetPlatformAnalyticsActivityQueryParams,
  GetPlatformAnalyticsAiQueryParams,
  GetPlatformAnalyticsOperationsQueryParams,
} from "@workspace/api-zod";
import { requireAuth, requireRole, type AuthRequest } from "../middlewares/requireAuth.js";
import { AppError } from "../middlewares/errorHandler.js";
import * as analytics from "../services/platform-analytics.service.js";

// G-7 — Platform Owner Analytics. Read-only aggregates across all tenants.
//
// Path-scoped behind the platform firewall, like every /platform router: a tenant user
// (primary_admin, admin, employee) receives 403 before any query runs, and an
// unauthenticated caller 401. The handlers return counts, sums, plan ids and company
// ids/names only — never a tenant CRM record — so the Platform Owner tenant-data firewall
// is not widened by this module.
const router = Router();
router.use(requireAuth);
router.use("/platform/analytics", requireRole("platform_owner"));

type QuerySchema = { safeParse: (v: unknown) => { success: true; data: analytics.WindowQuery } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } };

// Validates the query with the generated Zod schema (contract-first). Repeated parameters
// arrive as arrays and are refused here rather than coerced.
function windowQuery(schema: QuerySchema, req: AuthRequest): analytics.WindowQuery {
  const raw = (req.query ?? {}) as Record<string, unknown>;
  for (const key of ["from", "to", "granularity"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") throw new AppError(400, `Invalid ${key}`, { code: "INVALID_ANALYTICS_WINDOW" });
  }
  const parsed = schema.safeParse({ from: raw.from, to: raw.to, granularity: raw.granularity === "" ? undefined : raw.granularity });
  if (!parsed.success) {
    throw new AppError(400, "Invalid analytics query", {
      code: "INVALID_ANALYTICS_WINDOW",
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) },
    });
  }
  return parsed.data;
}

router.get("/platform/analytics/overview", async (req: AuthRequest, res) => {
  res.json(await analytics.getOverview(windowQuery(GetPlatformAnalyticsOverviewQueryParams, req)));
});
router.get("/platform/analytics/growth", async (req: AuthRequest, res) => {
  res.json(await analytics.getGrowth(windowQuery(GetPlatformAnalyticsGrowthQueryParams, req)));
});
router.get("/platform/analytics/subscriptions", async (req: AuthRequest, res) => {
  res.json(await analytics.getSubscriptions(windowQuery(GetPlatformAnalyticsSubscriptionsQueryParams, req)));
});
router.get("/platform/analytics/revenue", async (req: AuthRequest, res) => {
  res.json(await analytics.getRevenue(windowQuery(GetPlatformAnalyticsRevenueQueryParams, req)));
});
router.get("/platform/analytics/activity", async (req: AuthRequest, res) => {
  res.json(await analytics.getActivity(windowQuery(GetPlatformAnalyticsActivityQueryParams, req)));
});
router.get("/platform/analytics/ai", async (req: AuthRequest, res) => {
  res.json(await analytics.getAi(windowQuery(GetPlatformAnalyticsAiQueryParams, req)));
});
router.get("/platform/analytics/operations", async (req: AuthRequest, res) => {
  res.json(await analytics.getOperations(windowQuery(GetPlatformAnalyticsOperationsQueryParams, req)));
});

export default router;
