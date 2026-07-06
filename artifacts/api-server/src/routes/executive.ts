import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { microCache } from "../middlewares/microCache.js";
import * as exec from "../services/executive-intelligence.service.js";

// Stage 5C — Enterprise AI Executive Intelligence Center.
//
// Read-only dashboard + reviewable, persisted AI artifacts (summaries, alerts, forecasts,
// reports). Guards mirror the rest of the AI surface and are path-scoped to /ai/executive
// so they never widen the platform-owner firewall or the tenant boundary:
// - requireAuth (global, applied in the barrel) loads the live user.
// - requireTenantUser blocks platform_owner — executive intelligence is tenant CRM only.
// - blockReadOnlyMutations respects the cancelled-company read-only lifecycle on writes.
// - auditMutations records every non-GET as an audited "ai_executive" action.
// - requirePermission("ai_executive", <action>) enforces the writes-only permissions matrix.
// Read GETs additionally serve through the 30s micro-cache. Nothing here auto-executes a
// recommendation or writes the source CRM.

const router = Router();

router.use("/ai/executive", requireAuth);
router.use("/ai/executive", requireTenantUser);
router.use("/ai/executive", blockReadOnlyMutations);
router.use("/ai/executive", auditMutations("ai_executive"));

const execCache = microCache(30_000);

function parseId(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = parseInt(String(v));
  return Number.isNaN(n) ? undefined : n;
}

// ── Dashboard (read-only rollup) ──────────────────────────────────────────────
router.get("/ai/executive/dashboard", requirePermission("ai_executive", "view"), execCache, async (req: AuthRequest, res) => {
  const q = req.query;
  res.json(
    await exec.getExecutiveDashboard(req.user!, {
      scopeType: q.scopeType ? String(q.scopeType) : undefined,
      id: parseId(q.id),
      dateFrom: q.dateFrom ? String(q.dateFrom) : undefined,
      dateTo: q.dateTo ? String(q.dateTo) : undefined,
    }),
  );
});

// ── Summaries ─────────────────────────────────────────────────────────────────
router.get("/ai/executive/summaries", requirePermission("ai_executive", "view"), execCache, async (req: AuthRequest, res) => {
  const q = req.query;
  res.json({ summaries: await exec.listSummaries(req.user!, q.periodType ? String(q.periodType) : null, parseId(q.limit) ?? 20) });
});

router.post("/ai/executive/summaries", requirePermission("ai_executive", "generate"), async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { scopeType?: unknown; id?: unknown; periodType?: unknown; language?: unknown };
  res.json(
    await exec.generateSummary(req.user!, {
      scopeType: body.scopeType ? String(body.scopeType) : undefined,
      id: parseId(body.id),
      periodType: body.periodType ? String(body.periodType) : undefined,
      appLanguage: body.language === "ar" ? "ar" : "en",
    }),
  );
});

// Static "/summaries/:id/..." lifecycle paths registered before the bare "/:id" getter.
router.post("/ai/executive/summaries/:id/accept", requirePermission("ai_executive", "accept"), async (req: AuthRequest, res) => {
  res.json(await exec.setSummaryStatus(req.user!, parseInt(String(req.params.id)), "accepted"));
});

router.post("/ai/executive/summaries/:id/dismiss", requirePermission("ai_executive", "accept"), async (req: AuthRequest, res) => {
  res.json(await exec.setSummaryStatus(req.user!, parseInt(String(req.params.id)), "dismissed"));
});

router.get("/ai/executive/summaries/:id", requirePermission("ai_executive", "view"), async (req: AuthRequest, res) => {
  res.json(await exec.getSummary(req.user!, parseInt(String(req.params.id))));
});

// ── Alerts ──────────────────────────────────────────────────────────────────--
router.get("/ai/executive/alerts", requirePermission("ai_executive", "view"), execCache, async (req: AuthRequest, res) => {
  const q = req.query;
  res.json({ alerts: await exec.listAlerts(req.user!, q.status ? String(q.status) : null, parseId(q.limit) ?? 50) });
});

router.post("/ai/executive/alerts/generate", requirePermission("ai_executive", "generate"), async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { scopeType?: unknown; id?: unknown };
  res.json({ alerts: await exec.generateAlerts(req.user!, { scopeType: body.scopeType ? String(body.scopeType) : undefined, id: parseId(body.id) }) });
});

router.post("/ai/executive/alerts/:id/accept", requirePermission("ai_executive", "accept"), async (req: AuthRequest, res) => {
  res.json(await exec.setAlertStatus(req.user!, parseInt(String(req.params.id)), "accepted"));
});

router.post("/ai/executive/alerts/:id/dismiss", requirePermission("ai_executive", "accept"), async (req: AuthRequest, res) => {
  res.json(await exec.setAlertStatus(req.user!, parseInt(String(req.params.id)), "dismissed"));
});

// ── Forecasts ─────────────────────────────────────────────────────────────────
router.get("/ai/executive/forecasts", requirePermission("ai_executive", "view"), execCache, async (req: AuthRequest, res) => {
  const q = req.query;
  res.json({ forecasts: await exec.listForecasts(req.user!, q.forecastType ? String(q.forecastType) : null, parseId(q.limit) ?? 20) });
});

router.post("/ai/executive/forecasts", requirePermission("ai_executive", "generate"), async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { scopeType?: unknown; id?: unknown; forecastType?: unknown; horizon?: unknown; language?: unknown };
  res.json(
    await exec.generateForecast(req.user!, {
      scopeType: body.scopeType ? String(body.scopeType) : undefined,
      id: parseId(body.id),
      forecastType: body.forecastType ? String(body.forecastType) : undefined,
      horizon: body.horizon ? String(body.horizon) : undefined,
      appLanguage: body.language === "ar" ? "ar" : "en",
    }),
  );
});

// ── Reports (async export job) ────────────────────────────────────────────────
router.get("/ai/executive/reports", requirePermission("ai_executive", "view"), execCache, async (req: AuthRequest, res) => {
  res.json({ reports: await exec.listReports(req.user!, parseId(req.query.limit) ?? 20) });
});

router.post("/ai/executive/reports", requirePermission("ai_executive", "generate"), async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { reportType?: unknown; periodType?: unknown; format?: unknown; scopeType?: unknown; id?: unknown; language?: unknown };
  const report = await exec.generateReport(req.user!, {
    reportType: body.reportType ? String(body.reportType) : undefined,
    periodType: body.periodType ? String(body.periodType) : undefined,
    format: body.format ? String(body.format) : undefined,
    scopeType: body.scopeType ? String(body.scopeType) : undefined,
    id: parseId(body.id),
    language: body.language === "ar" ? "ar" : "en",
  });
  res.status(202).json(report);
});

router.get("/ai/executive/reports/:id", requirePermission("ai_executive", "view"), async (req: AuthRequest, res) => {
  res.json(await exec.getReport(req.user!, parseInt(String(req.params.id))));
});

export default router;
