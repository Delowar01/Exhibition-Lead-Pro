import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requireRole, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import * as ai from "../services/ai.service.js";
import * as insights from "../services/ai-insights.service.js";

const router = Router();
router.use(requireAuth);

// Tenant-scoped AI endpoints. platform_owner (no company) is blocked by
// requireTenantUser (403) — the platform operator uses /ai/platform/usage instead.
// Guards are path-scoped to each sub-path (NOT "/ai"), because /ai/platform/usage
// has DIFFERENT access rules and a "/ai" prefix guard would also match it.
router.use("/ai/settings", requireTenantUser);
router.use("/ai/settings", blockReadOnlyMutations);
router.use("/ai/settings", auditMutations("ai"));
router.use("/ai/usage", requireTenantUser);
router.use("/ai/health", requireTenantUser);
// Platform-wide AI visibility — platform_owner only.
router.use("/ai/platform", requireRole("platform_owner"));

// GET /ai/settings — effective settings for the caller's tenant
router.get("/ai/settings", async (req: AuthRequest, res) => {
  res.json(await ai.getSettings(req.user!));
});

// PATCH /ai/settings — primary_admin only (validated inside the service)
router.patch("/ai/settings", requireRole("primary_admin"), async (req: AuthRequest, res) => {
  res.json(await ai.updateSettings(req.user!, req.body ?? {}));
});

// GET /ai/usage — usage & estimated cost for the caller's tenant
router.get("/ai/usage", async (req: AuthRequest, res) => {
  res.json(await ai.getUsage(req.user!, req.query as Record<string, unknown>));
});

// GET /ai/health — provider configuration & recent reliability
router.get("/ai/health", async (req: AuthRequest, res) => {
  res.json(await ai.getHealth(req.user!));
});

// GET /ai/platform/usage — platform-wide usage across all tenants
router.get("/ai/platform/usage", async (req: AuthRequest, res) => {
  res.json(await ai.getPlatformUsage(req.query as Record<string, unknown>));
});

// ── Stage 5A — Enterprise AI Intelligence (per-entity reviewable insights) ─────
//
// Guards are path-scoped to /ai/insights so they never leak onto /ai/settings|usage|
// health|platform (which have different rules). platform_owner is blocked here
// (requireTenantUser) — AI intelligence operates ONLY on a tenant's own CRM data.
// blockReadOnlyMutations makes generate/accept/dismiss respect the cancelled-company
// read-only lifecycle; auditMutations records every non-GET as an audited action.
router.use("/ai/insights", requireTenantUser);
router.use("/ai/insights", blockReadOnlyMutations);
router.use("/ai/insights", auditMutations("ai_insights"));

// GET /ai/insights/overview — tenant-wide review summary (static path before /:entityType).
router.get("/ai/insights/overview", requirePermission("ai_insights", "view"), async (req: AuthRequest, res) => {
  res.json(await insights.getOverview(req.user!));
});

// POST /ai/insights/:entityType/:id/analyze — (re)generate all applicable insights.
router.post("/ai/insights/:entityType/:id/analyze", requirePermission("ai_insights", "generate"), async (req: AuthRequest, res) => {
  const entityType = insights.assertEntityType(String(req.params.entityType));
  const id = parseInt(String(req.params.id));
  res.json(await insights.analyzeEntity(req.user!, entityType, id));
});

// GET /ai/insights/:entityType/:id — list stored insights for one entity.
router.get("/ai/insights/:entityType/:id", requirePermission("ai_insights", "view"), async (req: AuthRequest, res) => {
  const entityType = insights.assertEntityType(String(req.params.entityType));
  const id = parseInt(String(req.params.id));
  res.json({ insights: await insights.getInsights(req.user!, entityType, id) });
});

// POST /ai/insights/:id/accept — record an audited user acceptance of a recommendation.
router.post("/ai/insights/:id/accept", requirePermission("ai_insights", "accept"), async (req: AuthRequest, res) => {
  res.json(await insights.acceptInsight(req.user!, parseInt(String(req.params.id))));
});

// POST /ai/insights/:id/dismiss — dismiss a recommendation (audited review action).
router.post("/ai/insights/:id/dismiss", requirePermission("ai_insights", "accept"), async (req: AuthRequest, res) => {
  res.json(await insights.dismissInsight(req.user!, parseInt(String(req.params.id))));
});

export default router;
