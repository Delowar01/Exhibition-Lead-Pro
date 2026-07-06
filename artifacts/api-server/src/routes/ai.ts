import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requireRole, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import * as ai from "../services/ai.service.js";
import * as insights from "../services/ai-insights.service.js";
import * as aiBatch from "../services/ai-batch.service.js";
import * as copilot from "../services/ai-copilot.service.js";
import * as copilotBatch from "../services/ai-copilot-batch.service.js";

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

// ── Batch processing ──────────────────────────────────────────────────────────
// Static "/batch" paths MUST be registered BEFORE /:entityType/:id so "batch" is not
// captured as an entityType (and /batch/:jobId before /:entityType/:id which is also
// two segments). "generate" gates starting a batch; "view" gates reading progress.
router.post("/ai/insights/batch", requirePermission("ai_insights", "generate"), async (req: AuthRequest, res) => {
  const entityType = String((req.body ?? {}).entityType ?? "");
  res.status(202).json(await aiBatch.startBatch(req.user!, entityType));
});

router.get("/ai/insights/batch", requirePermission("ai_insights", "view"), async (req: AuthRequest, res) => {
  res.json({ jobs: aiBatch.listBatches(req.user!) });
});

router.get("/ai/insights/batch/:jobId", requirePermission("ai_insights", "view"), async (req: AuthRequest, res) => {
  res.json(aiBatch.getBatch(req.user!, String(req.params.jobId)));
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

// ── Stage 5B — Enterprise AI Sales Copilot (reviewable generative drafts) ──────
//
// Guards are path-scoped to /ai/copilot (same rationale as /ai/insights): tenant-only
// (requireTenantUser blocks platform_owner), cancelled-company read-only respected
// (blockReadOnlyMutations), and every non-GET audited (auditMutations). The copilot
// NEVER auto-sends or auto-writes CRM — "use" merely records an audited user action on
// the draft row. Permission matrix: view (read drafts/overview), generate (create/batch),
// use (mark used / edit / dismiss review actions).
router.use("/ai/copilot", requireTenantUser);
router.use("/ai/copilot", blockReadOnlyMutations);
router.use("/ai/copilot", auditMutations("ai_copilot"));

// GET /ai/copilot/overview — tenant-wide review summary (static path before /:entityType).
router.get("/ai/copilot/overview", requirePermission("ai_copilot", "view"), async (req: AuthRequest, res) => {
  res.json(await copilot.getOverview(req.user!));
});

// Static "/batch" + "/outputs" paths MUST be registered BEFORE /:entityType/:id so those
// literals are not captured as an entityType.
router.post("/ai/copilot/batch", requirePermission("ai_copilot", "generate"), async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { entityType?: unknown; outputType?: unknown };
  const job = await copilotBatch.startBatch(req.user!, String(body.entityType ?? ""), String(body.outputType ?? ""));
  res.status(202).json(job);
});

router.get("/ai/copilot/batch", requirePermission("ai_copilot", "view"), async (req: AuthRequest, res) => {
  res.json({ jobs: copilotBatch.listBatches(req.user!) });
});

router.get("/ai/copilot/batch/:jobId", requirePermission("ai_copilot", "view"), async (req: AuthRequest, res) => {
  res.json(copilotBatch.getBatch(req.user!, String(req.params.jobId)));
});

// PATCH /ai/copilot/outputs/:id — save a human edit of a draft (review action).
router.patch("/ai/copilot/outputs/:id", requirePermission("ai_copilot", "use"), async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { editedContent?: unknown };
  if (!body.editedContent || typeof body.editedContent !== "object") {
    res.status(400).json({ error: "editedContent (object) is required" });
    return;
  }
  res.json(await copilot.editOutput(req.user!, parseInt(String(req.params.id)), body.editedContent as Record<string, unknown>));
});

// POST /ai/copilot/outputs/:id/use — record an audited "used" action (does not auto-send).
router.post("/ai/copilot/outputs/:id/use", requirePermission("ai_copilot", "use"), async (req: AuthRequest, res) => {
  res.json(await copilot.useOutput(req.user!, parseInt(String(req.params.id))));
});

// POST /ai/copilot/outputs/:id/dismiss — dismiss a draft (review action).
router.post("/ai/copilot/outputs/:id/dismiss", requirePermission("ai_copilot", "use"), async (req: AuthRequest, res) => {
  res.json(await copilot.dismissOutput(req.user!, parseInt(String(req.params.id))));
});

// GET /ai/copilot/:entityType/:id/panel — aggregated Sales Copilot panel (static 3rd
// segment "panel", registered before the 2-segment list route below).
router.get("/ai/copilot/:entityType/:id/panel", requirePermission("ai_copilot", "view"), async (req: AuthRequest, res) => {
  const entityType = copilot.assertEntityType(String(req.params.entityType));
  const id = parseInt(String(req.params.id));
  res.json(await copilot.getPanel(req.user!, entityType, id));
});

// POST /ai/copilot/:entityType/:id/:outputType — generate one output for a CRM entity.
// MUST be the LAST copilot POST route: the 3-segment :outputType param would otherwise
// swallow /ai/copilot/outputs/:id/use|dismiss (also 3 segments). Options travel in the body.
router.post("/ai/copilot/:entityType/:id/:outputType", requirePermission("ai_copilot", "generate"), async (req: AuthRequest, res) => {
  const entityType = copilot.assertEntityType(String(req.params.entityType));
  const id = parseInt(String(req.params.id));
  const outputType = copilot.assertOutputType(String(req.params.outputType));
  const body = (req.body ?? {}) as { language?: unknown; instructions?: unknown };
  res.json(await copilot.generateOutput(req.user!, entityType, id, outputType, { language: body.language, instructions: body.instructions }));
});

// GET /ai/copilot/:entityType/:id — list stored copilot outputs for one entity.
router.get("/ai/copilot/:entityType/:id", requirePermission("ai_copilot", "view"), async (req: AuthRequest, res) => {
  const entityType = copilot.assertEntityType(String(req.params.entityType));
  const id = parseInt(String(req.params.id));
  res.json({ outputs: await copilot.getOutputs(req.user!, entityType, id) });
});

export default router;
