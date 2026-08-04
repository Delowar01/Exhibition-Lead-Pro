import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requireRole, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { microCache } from "../middlewares/microCache.js";
import * as ai from "../services/ai.service.js";
import * as insights from "../services/ai-insights.service.js";
import * as aiBatch from "../services/ai-batch.service.js";
import * as copilot from "../services/ai-copilot.service.js";
import * as copilotBatch from "../services/ai-copilot-batch.service.js";
import * as workflow from "../services/ai-workflow.service.js";
import * as workflowBatch from "../services/ai-workflow-batch.service.js";
import { runWorkflowAlertsForCompany } from "../lib/workflow-alerts.js";
import * as assistant from "../services/ai-assistant.service.js";

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
// Batch 6: usage & cost visibility is an ADMIN surface (primary_admin + admin), not
// an all-tenant-users read — employees have no budget/cost management duties.
router.use("/ai/usage", requireRole("primary_admin", "admin"));
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
  const body = (req.body ?? {}) as {
    language?: unknown;
    tone?: unknown;
    messageType?: unknown;
    variant?: unknown;
    instructions?: unknown;
    regenerate?: unknown;
  };
  res.json(
    await copilot.generateOutput(req.user!, entityType, id, outputType, {
      language: body.language,
      tone: body.tone,
      messageType: body.messageType,
      variant: body.variant,
      instructions: body.instructions,
      regenerate: body.regenerate === true,
    }),
  );
});

// GET /ai/copilot/:entityType/:id — list stored copilot outputs for one entity.
router.get("/ai/copilot/:entityType/:id", requirePermission("ai_copilot", "view"), async (req: AuthRequest, res) => {
  const entityType = copilot.assertEntityType(String(req.params.entityType));
  const id = parseInt(String(req.params.id));
  res.json({ outputs: await copilot.getOutputs(req.user!, entityType, id) });
});

// ── Stage 5F — Enterprise AI Workflow & Automation Intelligence ────────────────
//
// ADVISORY workflow layer: reviewable per-entity recommendations (next action, follow-up,
// routing/owner, progression, reminder, task, priority, due date), org-scoped health/SLA
// risk/bottleneck rollups, and what-if simulation. Everything is read-only intelligence —
// the engine NEVER assigns, routes, changes a stage, sends, or writes back to the CRM; it
// only persists its own reviewable ai_workflow_recommendations rows. Guards mirror
// /ai/copilot: tenant-only (platform_owner blocked), cancelled-company read-only respected,
// every non-GET audited. Permission matrix: view (read), generate (analyze/batch), accept
// (accept/dismiss a recommendation).
router.use("/ai/workflow", requireTenantUser);
router.use("/ai/workflow", blockReadOnlyMutations);
router.use("/ai/workflow", auditMutations("ai_workflow"));

// 30s TTL micro-cache for the COMPUTED org-scoped rollups (same pattern as
// analytics/reports). Key includes userId + full URL (scope id varies the key);
// any successful write bumps the global write epoch and busts these immediately.
// Only applied to the always-fresh computed reads — NOT to batch polling or the
// per-entity persisted-row list.
const workflowCache = microCache(30_000);

// GET /ai/workflow/overview — tenant-wide review summary (static path before /:entityType).
router.get("/ai/workflow/overview", requirePermission("ai_workflow", "view"), workflowCache, async (req: AuthRequest, res) => {
  res.json(await workflow.getOverview(req.user!));
});

// Org-scoped read-only rollups (scope selector: scopeType=company|department|team|employee & id).
router.get("/ai/workflow/health", requirePermission("ai_workflow", "view"), workflowCache, async (req: AuthRequest, res) => {
  const q = req.query as Record<string, unknown>;
  res.json(await workflow.getHealth(req.user!, { scopeType: q.scopeType ? String(q.scopeType) : undefined, id: q.id != null ? parseInt(String(q.id)) : undefined }));
});

router.get("/ai/workflow/sla-risks", requirePermission("ai_workflow", "view"), workflowCache, async (req: AuthRequest, res) => {
  const q = req.query as Record<string, unknown>;
  res.json(await workflow.getSlaRisks(req.user!, {
    scopeType: q.scopeType ? String(q.scopeType) : undefined,
    id: q.id != null ? parseInt(String(q.id)) : undefined,
    category: q.category ? String(q.category) : undefined,
  }));
});

router.get("/ai/workflow/bottlenecks", requirePermission("ai_workflow", "view"), workflowCache, async (req: AuthRequest, res) => {
  const q = req.query as Record<string, unknown>;
  res.json(await workflow.getBottlenecks(req.user!, { scopeType: q.scopeType ? String(q.scopeType) : undefined, id: q.id != null ? parseInt(String(q.id)) : undefined }));
});

// POST /ai/workflow/simulate — what-if outcome prediction for a lead (writes NOTHING).
router.post("/ai/workflow/simulate", requirePermission("ai_workflow", "view"), async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { leadId?: unknown; scenario?: unknown; candidateUserId?: unknown; delayDays?: unknown };
  res.json(await workflow.simulateScenario(req.user!, {
    leadId: parseInt(String(body.leadId)),
    scenario: String(body.scenario ?? ""),
    candidateUserId: body.candidateUserId != null ? parseInt(String(body.candidateUserId)) : undefined,
    delayDays: body.delayDays != null ? parseInt(String(body.delayDays)) : undefined,
  }));
});

// Batch (re)analysis: static "/batch" paths BEFORE /:entityType/:id so "batch" is not an entityType.
router.post("/ai/workflow/batch", requirePermission("ai_workflow", "generate"), async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { entityType?: unknown };
  res.status(202).json(await workflowBatch.startBatch(req.user!, String(body.entityType ?? "")));
});

router.get("/ai/workflow/batch", requirePermission("ai_workflow", "view"), async (req: AuthRequest, res) => {
  res.json({ jobs: workflowBatch.listBatches(req.user!) });
});

// POST /ai/workflow/alerts/run — manual trigger of the workflow risk alert sweep for the
// caller's OWN company only (the recurring scheduler covers all tenants). Advisory:
// dispatches notifications, never writes the source CRM. Deduped per user per local day.
router.post("/ai/workflow/alerts/run", requirePermission("ai_workflow", "generate"), async (req: AuthRequest, res) => {
  res.json(await runWorkflowAlertsForCompany(req.user!.companyId!));
});

router.get("/ai/workflow/batch/:jobId", requirePermission("ai_workflow", "view"), async (req: AuthRequest, res) => {
  res.json(workflowBatch.getBatch(req.user!, String(req.params.jobId)));
});

// Recommendation review lifecycle: static "/recommendations" paths BEFORE /:entityType/:id.
router.post("/ai/workflow/recommendations/:id/accept", requirePermission("ai_workflow", "accept"), async (req: AuthRequest, res) => {
  res.json(await workflow.setRecommendationStatus(req.user!, parseInt(String(req.params.id)), "accepted"));
});

router.post("/ai/workflow/recommendations/:id/dismiss", requirePermission("ai_workflow", "accept"), async (req: AuthRequest, res) => {
  res.json(await workflow.setRecommendationStatus(req.user!, parseInt(String(req.params.id)), "dismissed"));
});

// POST /ai/workflow/:entityType/:id/analyze — (re)compute all applicable recommendations.
router.post("/ai/workflow/:entityType/:id/analyze", requirePermission("ai_workflow", "generate"), async (req: AuthRequest, res) => {
  const entityType = workflow.assertEntityType(String(req.params.entityType));
  const id = parseInt(String(req.params.id));
  const body = (req.body ?? {}) as { language?: unknown };
  res.json({ recommendations: await workflow.analyzeEntity(req.user!, entityType, id, { language: body.language === "ar" ? "ar" : "en" }) });
});

// GET /ai/workflow/:entityType/:id — list stored recommendations for one entity.
router.get("/ai/workflow/:entityType/:id", requirePermission("ai_workflow", "view"), async (req: AuthRequest, res) => {
  const entityType = workflow.assertEntityType(String(req.params.entityType));
  const id = parseInt(String(req.params.id));
  res.json({ recommendations: await workflow.listEntityRecommendations(req.user!, entityType, id) });
});

// ── Stage 5D: Enterprise AI Command Center (conversational assistant) ──────────
// Tenant-only (requireTenantUser blocks platform_owner — the assistant operates
// ONLY on a tenant's own CRM data), cancelled-company read-only respected
// (blockReadOnlyMutations), every non-GET audited (auditMutations). The assistant
// is ADVISORY ONLY: sending a message never writes the CRM, never sends anything —
// answers are grounded read-only orchestrations of the existing AI engines, and
// each underlying module's permission is re-checked inside the service.
// Reads gate on ai_assistant.view; conversation/message writes gate on ai_assistant.use.
router.use("/ai/assistant", requireTenantUser);
router.use("/ai/assistant", blockReadOnlyMutations);
router.use("/ai/assistant", auditMutations("ai_assistant"));

router.get("/ai/assistant/conversations", requirePermission("ai_assistant", "view"), async (req: AuthRequest, res) => {
  const q = req.query.q != null ? String(req.query.q) : undefined;
  res.json(await assistant.listConversations(req.user!, q));
});

router.post("/ai/assistant/conversations", requirePermission("ai_assistant", "use"), async (req: AuthRequest, res) => {
  res.status(201).json(await assistant.createConversation(req.user!, (req.body ?? {}) as Record<string, unknown>));
});

// Static "suggestions" path BEFORE the /conversations/:id params.
router.get("/ai/assistant/suggestions", requirePermission("ai_assistant", "view"), async (req: AuthRequest, res) => {
  res.json(await assistant.getSuggestions(req.user!, { contextType: req.query.contextType, contextId: req.query.contextId }));
});

router.get("/ai/assistant/conversations/:id", requirePermission("ai_assistant", "view"), async (req: AuthRequest, res) => {
  res.json(await assistant.getConversation(req.user!, parseInt(String(req.params.id))));
});

router.delete("/ai/assistant/conversations/:id", requirePermission("ai_assistant", "use"), async (req: AuthRequest, res) => {
  res.json(await assistant.deleteConversation(req.user!, parseInt(String(req.params.id))));
});

router.post("/ai/assistant/conversations/:id/messages", requirePermission("ai_assistant", "use"), async (req: AuthRequest, res) => {
  res.json(await assistant.sendMessage(req.user!, parseInt(String(req.params.id)), (req.body ?? {}) as Record<string, unknown>));
});

export default router;
