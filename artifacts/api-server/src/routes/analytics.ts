import { Router } from "express";
import { requireAuth, requireTenantUser, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { microCache } from "../middlewares/microCache.js";
import { AppError } from "../middlewares/errorHandler.js";
import * as analytics from "../services/analytics.service.js";

const router = Router();
router.use(requireAuth);
// Terminating guards — path-scoped to /analytics so they do not fire on the
// shared path-less parent router. platform_owner is blocked (customer business
// data); admin/employee must hold reports:view; primary_admin bypasses.
router.use("/analytics", requireTenantUser);
router.use("/analytics", requirePermission("reports", "view"));

// 30s TTL micro-cache (same pattern as reports). Key includes userId + full URL
// (so scope id + date range vary the key); any write bumps the global write
// epoch and busts these immediately.
const analyticsCache = microCache(30_000);

// Required `id` query param for the scoped endpoints.
function requireId(req: AuthRequest): number {
  const id = parseInt(String(req.query.id));
  if (Number.isNaN(id)) throw new AppError(400, "id query parameter is required");
  return id;
}

function dateParams(req: AuthRequest): { dateFrom?: string; dateTo?: string } {
  const q = req.query as Record<string, string | undefined>;
  return { dateFrom: q.dateFrom, dateTo: q.dateTo };
}

// GET /analytics/scope-options — org scopes the caller may drill into
router.get("/analytics/scope-options", analyticsCache, async (req: AuthRequest, res) => {
  res.json(await analytics.getScopeOptions(req.user!));
});

// GET /analytics/dashboard — Unified Lead Dashboard (superset of the scoped
// analytics shape). Optional scopeType (company|department|team|employee) + id
// drill-down; defaults to company overview for managers, own scope otherwise.
router.get("/analytics/dashboard", analyticsCache, async (req: AuthRequest, res) => {
  const { dateFrom, dateTo } = dateParams(req);
  const q = req.query as Record<string, string | undefined>;
  const idRaw = q.id != null ? parseInt(String(q.id)) : NaN;
  res.json(
    await analytics.getDashboard(req.user!, {
      scopeType: q.scopeType,
      id: Number.isNaN(idRaw) ? undefined : idRaw,
      dateFrom,
      dateTo,
    }),
  );
});

// GET /analytics/overview — company-wide (whole accessible tenant)
router.get("/analytics/overview", analyticsCache, async (req: AuthRequest, res) => {
  const { dateFrom, dateTo } = dateParams(req);
  res.json(await analytics.getOverview(req.user!, dateFrom, dateTo));
});

// GET /analytics/department?id= — department-scoped (incl. descendant departments)
router.get("/analytics/department", analyticsCache, async (req: AuthRequest, res) => {
  const { dateFrom, dateTo } = dateParams(req);
  res.json(await analytics.getDepartment(req.user!, requireId(req), dateFrom, dateTo));
});

// GET /analytics/team?id= — team-scoped
router.get("/analytics/team", analyticsCache, async (req: AuthRequest, res) => {
  const { dateFrom, dateTo } = dateParams(req);
  res.json(await analytics.getTeam(req.user!, requireId(req), dateFrom, dateTo));
});

// GET /analytics/employee?id= — single-employee scoped
router.get("/analytics/employee", analyticsCache, async (req: AuthRequest, res) => {
  const { dateFrom, dateTo } = dateParams(req);
  res.json(await analytics.getEmployee(req.user!, requireId(req), dateFrom, dateTo));
});

export default router;
