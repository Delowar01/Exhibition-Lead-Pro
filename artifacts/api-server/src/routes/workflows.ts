import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { validateBody } from "../middlewares/validate.js";
import { writeAudit } from "../lib/audit.js";
import {
  CreateWorkflowDefinitionBody,
  UpdateWorkflowDefinitionBody,
  ValidateWorkflowDefinitionBody,
  PublishWorkflowDefinitionBody,
  UnpublishWorkflowDefinitionBody,
  ArchiveWorkflowDefinitionBody,
  DeleteWorkflowDefinitionBody,
} from "@workspace/api-zod";
import * as wf from "../services/workflow-definitions.service.js";
import * as runs from "../services/workflow-runs.service.js";

// =============================================================================
// /workflows — CRM automation DEFINITIONS (Batch 15). Management API only.
// =============================================================================
// Deterministic CRM automation, deliberately NOT under /ai. Nothing here (and no
// state reachable from here) executes a workflow: there is no run/execute/test-
// execution/history/retry/job endpoint — those belong to the Batch 16 engine.
//
// Guards mirror the tenant CRM modules: requireTenantUser fences the platform
// operator out (403), reads are tenant-scoped (cross-tenant ids answer 404),
// and the RBAC module is `workflows` (view = read/validate/catalog,
// manage = create/update/lifecycle/delete). platform_owner never reaches
// customer workflow data; primary_admin bypasses the matrix as everywhere.

const router = Router();
router.use(requireAuth);
router.use("/workflows", requireTenantUser);
router.use("/workflows", blockReadOnlyMutations);

const canView = requirePermission("workflows", "view");
const canManage = requirePermission("workflows", "manage");

function requestId(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return id === undefined ? undefined : String(id);
}

// Renders the structured validation issues as the API's standard 400 envelope
// (`details: [{ field, message }]`, plus a stable `code`). Everything else goes
// to the global error handler.
function guarded(fn: (req: AuthRequest, res: Response) => Promise<void>) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof wf.WorkflowValidationError) {
        res.status(400).json({
          error: err.message,
          code: err.code,
          details: err.issues.map((i) => ({ field: i.path, message: i.message, code: i.code })),
          requestId: requestId(req),
        });
        return;
      }
      next(err);
    }
  };
}

function idParam(req: Request): number {
  return parseInt(String(req.params.id), 10);
}

// Audit metadata is deliberately shallow: names/types/counters only — never the
// action/trigger configuration (which may name recipients or message bodies).
function auditMeta(d: wf.FormattedDefinition, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const actions = Array.isArray(d.actions) ? (d.actions as Array<{ type?: unknown }>) : [];
  return {
    name: d.name,
    status: d.status,
    revision: d.revision,
    triggerType: (d.trigger as { type?: unknown } | null)?.type ?? null,
    actionTypes: actions.map((a) => a?.type ?? null),
    conditionCount: Array.isArray(d.conditions) ? d.conditions.length : 0,
    ...extra,
  };
}

// ── static paths first (before /workflows/:id) ──────────────────────────────

// GET /workflows/catalog — supported triggers / condition fields+operators / actions.
router.get("/workflows/catalog", canView, (_req: AuthRequest, res) => {
  res.json(wf.getCatalog());
});

// POST /workflows/validate — validate a candidate definition; persists and executes nothing.
router.post(
  "/workflows/validate",
  canView,
  validateBody(ValidateWorkflowDefinitionBody),
  guarded(async (req, res) => {
    res.json(await wf.validateDefinitionBody(req.user!, req.body ?? {}));
  }),
);

// ── run history (Batch 16; read-only; static paths before /workflows/:id) ───

// GET /workflows/runs — the caller's company execution history (newest first).
router.get(
  "/workflows/runs",
  canView,
  guarded(async (req, res) => {
    res.json(await runs.listRuns(req.user!, (req.query ?? {}) as Record<string, unknown>));
  }),
);

// GET /workflows/runs/:id — one run with its ordered action outcomes (404 across tenants).
router.get(
  "/workflows/runs/:id",
  canView,
  guarded(async (req, res) => {
    res.json(await runs.getRun(req.user!, idParam(req)));
  }),
);

// GET /workflows — list the caller's company definitions (archived excluded by default).
router.get(
  "/workflows",
  canView,
  guarded(async (req, res) => {
    res.json(await wf.listDefinitions(req.user!, (req.query ?? {}) as Record<string, unknown>));
  }),
);

// POST /workflows — create a DRAFT definition.
router.post(
  "/workflows",
  canManage,
  validateBody(CreateWorkflowDefinitionBody),
  guarded(async (req, res) => {
    const d = await wf.createDefinition(req.user!, req.body ?? {});
    await writeAudit(req, { action: "workflow.create", entityType: "workflow_definition", entityId: d.id, companyId: d.companyId, metadata: auditMeta(d) });
    res.status(201).json(d);
  }),
);

// GET /workflows/:id
router.get(
  "/workflows/:id",
  canView,
  guarded(async (req, res) => {
    res.json(await wf.getDefinition(req.user!, idParam(req)));
  }),
);

// POST /workflows/:id/validate — re-validate a stored definition (no persistence, no execution).
router.post(
  "/workflows/:id/validate",
  canView,
  guarded(async (req, res) => {
    res.json(await wf.validateStoredDefinition(req.user!, idParam(req)));
  }),
);

// PATCH /workflows/:id — edit a DRAFT (requires the current `revision`; 409 when
// stale). Published definitions are immutable (409 WORKFLOW_READ_ONLY): unpublish,
// edit, publish again.
router.patch(
  "/workflows/:id",
  canManage,
  validateBody(UpdateWorkflowDefinitionBody),
  guarded(async (req, res) => {
    const d = await wf.updateDefinition(req.user!, idParam(req), req.body ?? {});
    await writeAudit(req, { action: "workflow.update", entityType: "workflow_definition", entityId: d.id, companyId: d.companyId, metadata: auditMeta(d) });
    res.json(d);
  }),
);

// Lifecycle transitions — definition management only; NO state executes anything.
router.post(
  "/workflows/:id/publish",
  canManage,
  validateBody(PublishWorkflowDefinitionBody),
  guarded(async (req, res) => {
    const { definition, from } = await wf.transitionDefinition(req.user!, idParam(req), "published", req.body ?? {});
    await writeAudit(req, { action: "workflow.publish", entityType: "workflow_definition", entityId: definition.id, companyId: definition.companyId, metadata: auditMeta(definition, { from, to: "published" }) });
    res.json(definition);
  }),
);

router.post(
  "/workflows/:id/unpublish",
  canManage,
  validateBody(UnpublishWorkflowDefinitionBody),
  guarded(async (req, res) => {
    const { definition, from } = await wf.transitionDefinition(req.user!, idParam(req), "draft", req.body ?? {});
    await writeAudit(req, { action: "workflow.unpublish", entityType: "workflow_definition", entityId: definition.id, companyId: definition.companyId, metadata: auditMeta(definition, { from, to: "draft" }) });
    res.json(definition);
  }),
);

router.post(
  "/workflows/:id/archive",
  canManage,
  validateBody(ArchiveWorkflowDefinitionBody),
  guarded(async (req, res) => {
    const { definition, from } = await wf.transitionDefinition(req.user!, idParam(req), "archived", req.body ?? {});
    await writeAudit(req, { action: "workflow.archive", entityType: "workflow_definition", entityId: definition.id, companyId: definition.companyId, metadata: auditMeta(definition, { from, to: "archived" }) });
    res.json(definition);
  }),
);

// DELETE /workflows/:id — hard delete, DRAFTS ONLY (everything else is archived
// history). The JSON body carries the current `revision` (400 when missing/
// invalid, 409 WORKFLOW_REVISION_CONFLICT when stale) — the same optimistic-
// concurrency contract as PATCH and the publish/unpublish/archive transitions.
router.delete(
  "/workflows/:id",
  canManage,
  validateBody(DeleteWorkflowDefinitionBody),
  guarded(async (req, res) => {
    const id = idParam(req);
    const result = await wf.deleteDefinition(req.user!, id, (req.body ?? {}).revision);
    await writeAudit(req, {
      action: "workflow.delete",
      entityType: "workflow_definition",
      entityId: id,
      companyId: req.user!.companyId,
      metadata: { name: result.name, revision: result.revision },
    });
    res.json({ success: result.success, message: result.message });
  }),
);

export default router;
