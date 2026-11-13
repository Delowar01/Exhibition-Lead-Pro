import { Router } from "express";
import { requireAuth, requireRole, type AuthRequest } from "../middlewares/requireAuth.js";
import { validateBody } from "../middlewares/validate.js";
import { PlatformCreatePlanBody, PlatformDuplicatePlanBody, PlatformCreatePlanDraftBody, PlatformUpdatePlanDraftBody, PlatformMigratePlanVersionTenantsBody } from "@workspace/api-zod";
import { AppError } from "../middlewares/errorHandler.js";
import { getClientIp } from "../lib/security.js";
import * as platformPlans from "../services/platform-plans.service.js";
import * as builder from "../services/plan-builder.service.js";
import { migrateTenants } from "../services/plan-migration.service.js";

// Batch 39 — read-only plan catalog / detail / effective-limit preview.
// Batch 40 — PB-2 Plan Builder lifecycle (drafts → immutable published versions).
//
// Every route is behind the platform firewall: requireRole("platform_owner") is a
// path-scoped guard (403 for every tenant role, 401 anonymous). Every mutation is
// delegated to plan-builder.service.ts (one transaction, plan row locked, audit
// row in the same transaction); no lifecycle logic lives here.
const router = Router();
router.use(requireAuth);
router.use("/platform/plans", requireRole("platform_owner"));

function actorOf(req: AuthRequest) {
  return { userId: req.user!.id, userName: req.user!.email, ipAddress: getClientIp(req) };
}
function planIdParam(req: AuthRequest): string {
  return String(req.params.planId ?? "");
}
function intParam(req: AuthRequest, name: string, code: string): number {
  const raw = String(req.params[name] ?? "");
  const n = /^\d{1,12}$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, `${name} must be a positive integer`, { code });
  return n;
}
const versionIdParam = (req: AuthRequest) => intParam(req, "versionId", "INVALID_VERSION_ID");
const companyIdParam = (req: AuthRequest) => intParam(req, "companyId", "INVALID_COMPANY_ID");

// ── Reads (Batch 39) ─────────────────────────────────────────────────────────
router.get("/platform/plans", async (_req: AuthRequest, res) => {
  res.json(await platformPlans.listPlanCatalog());
});
router.get("/platform/plans/:planId", async (req: AuthRequest, res) => {
  res.json(await platformPlans.getPlanDetail(planIdParam(req)));
});
router.get("/platform/plans/:planId/effective-limits/:companyId", async (req: AuthRequest, res) => {
  res.json(await platformPlans.previewEffectiveLimits(planIdParam(req), companyIdParam(req)));
});

// ── Plan lifecycle (Batch 40) ────────────────────────────────────────────────
router.post("/platform/plans", validateBody(PlatformCreatePlanBody), async (req: AuthRequest, res) => {
  const created = await builder.createPlan(actorOf(req), req.body ?? {});
  res.status(201).json({ plan: await platformPlans.getPlanDetail(created.plan.id), draft: created.draft });
});
router.post("/platform/plans/:planId/duplicate", validateBody(PlatformDuplicatePlanBody), async (req: AuthRequest, res) => {
  const created = await builder.duplicatePlan(actorOf(req), planIdParam(req), req.body ?? {});
  res.status(201).json({ plan: await platformPlans.getPlanDetail(created.plan.id), draft: created.draft });
});
router.post("/platform/plans/:planId/archive", async (req: AuthRequest, res) => {
  const plan = await builder.archivePlan(actorOf(req), planIdParam(req));
  res.json(await platformPlans.getPlanDetail(plan.id));
});

// ── Versions ─────────────────────────────────────────────────────────────────
router.get("/platform/plans/:planId/versions", async (req: AuthRequest, res) => {
  res.json(await builder.listVersions(planIdParam(req)));
});
router.post("/platform/plans/:planId/versions", validateBody(PlatformCreatePlanDraftBody, { requireNonEmpty: false }), async (req: AuthRequest, res) => {
  res.status(201).json(await builder.createDraft(actorOf(req), planIdParam(req), req.body ?? {}));
});
router.get("/platform/plans/:planId/versions/:versionId", async (req: AuthRequest, res) => {
  res.json(await builder.getVersion(planIdParam(req), versionIdParam(req)));
});
router.patch("/platform/plans/:planId/versions/:versionId", validateBody(PlatformUpdatePlanDraftBody), async (req: AuthRequest, res) => {
  res.json(await builder.updateDraft(actorOf(req), planIdParam(req), versionIdParam(req), req.body ?? {}));
});
router.delete("/platform/plans/:planId/versions/:versionId", async (req: AuthRequest, res) => {
  res.json(await builder.deleteDraft(actorOf(req), planIdParam(req), versionIdParam(req)));
});
router.post("/platform/plans/:planId/versions/:versionId/validate", async (req: AuthRequest, res) => {
  res.json(await builder.validateVersion(planIdParam(req), versionIdParam(req)));
});
router.post("/platform/plans/:planId/versions/:versionId/publish", async (req: AuthRequest, res) => {
  res.json(await builder.publishVersion(actorOf(req), planIdParam(req), versionIdParam(req)));
});
router.post("/platform/plans/:planId/versions/:versionId/retire", async (req: AuthRequest, res) => {
  res.json(await builder.retireVersion(actorOf(req), planIdParam(req), versionIdParam(req)));
});
router.get("/platform/plans/:planId/versions/:versionId/impact", async (req: AuthRequest, res) => {
  res.json(await builder.impact(planIdParam(req), versionIdParam(req)));
});
router.get("/platform/plans/:planId/versions/:versionId/compare/:otherVersionId", async (req: AuthRequest, res) => {
  res.json(await builder.compare(planIdParam(req), versionIdParam(req), intParam(req, "otherVersionId", "INVALID_VERSION_ID")));
});
router.get("/platform/plans/:planId/versions/:versionId/effective-limits/:companyId", async (req: AuthRequest, res) => {
  res.json(await platformPlans.previewEffectiveLimits(planIdParam(req), companyIdParam(req), new Date(), versionIdParam(req)));
});
// Batch 42 (PB-4.5): tenant migration to this published version — dry run (read-only) or
// execution confirmed by the dry-run digest; per-tenant transactions and audit rows.
router.post("/platform/plans/:planId/versions/:versionId/migrate", validateBody(PlatformMigratePlanVersionTenantsBody), async (req: AuthRequest, res) => {
  res.json(await migrateTenants(actorOf(req), planIdParam(req), versionIdParam(req), req.body ?? {}));
});

export default router;
