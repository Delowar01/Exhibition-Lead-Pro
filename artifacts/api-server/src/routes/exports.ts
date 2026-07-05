import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateExportBody, CreateExportScheduleBody, UpdateExportScheduleBody } from "@workspace/api-zod";
import * as exports from "../services/export.service.js";

const router = Router();
router.use(requireAuth);
// Path-scoped terminating guards to the module base. platform_owner is blocked
// from all customer CRM data by requireTenantUser (403). Exporting filtered
// contact/lead data is a reporting capability, so it is gated by reports:view
// (primary_admin bypasses; admin default-on; employee opt-in) — consistent with
// the analytics module. A path-less router.use would leak onto every request
// flowing through the shared parent.
router.use("/exports", requireTenantUser);
router.use("/exports", blockReadOnlyMutations);
router.use("/exports", auditMutations("exports"));

// ── Export run history (static sub-paths BEFORE any /:id) ─────────────────────

// GET /exports/runs
router.get("/exports/runs", requirePermission("reports", "view"), async (req: AuthRequest, res) => {
  res.json(await exports.listRuns(req.user!, req.query as Record<string, string>));
});

// GET /exports/runs/:id/download
router.get("/exports/runs/:id/download", requirePermission("reports", "view"), async (req: AuthRequest, res) => {
  res.json(await exports.getRunDownloadUrl(req.user!, parseInt(String(req.params.id))));
});

// ── Schedules (static sub-paths BEFORE /exports/schedules/:id) ────────────────

// GET /exports/schedules
router.get("/exports/schedules", requirePermission("reports", "view"), async (req: AuthRequest, res) => {
  res.json(await exports.listSchedules(req.user!, req.query as Record<string, string>));
});

// POST /exports/schedules
router.post("/exports/schedules", requirePermission("reports", "view"), validateBody(CreateExportScheduleBody), async (req: AuthRequest, res) => {
  res.status(201).json(await exports.createSchedule(req.user!, req.body ?? {}));
});

// POST /exports/schedules/:id/run
router.post("/exports/schedules/:id/run", requirePermission("reports", "view"), async (req: AuthRequest, res) => {
  res.status(201).json(await exports.runScheduleNow(req.user!, parseInt(String(req.params.id))));
});

// PATCH /exports/schedules/:id
router.patch("/exports/schedules/:id", requirePermission("reports", "view"), validateBody(UpdateExportScheduleBody), async (req: AuthRequest, res) => {
  res.json(await exports.updateSchedule(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /exports/schedules/:id
router.delete("/exports/schedules/:id", requirePermission("reports", "view"), async (req: AuthRequest, res) => {
  res.json(await exports.deleteSchedule(req.user!, parseInt(String(req.params.id))));
});

// ── On-demand export ─────────────────────────────────────────────────────────

// POST /exports
router.post("/exports", requirePermission("reports", "view"), validateBody(CreateExportBody), async (req: AuthRequest, res) => {
  res.status(201).json(await exports.createExport(req.user!, req.body ?? {}));
});

export default router;
