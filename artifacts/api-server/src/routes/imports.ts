import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { PreviewImportBody, ValidateImportBody, CommitImportBody } from "@workspace/api-zod";
import * as imports from "../services/import.service.js";

const router = Router();
router.use(requireAuth);
// Path-scoped terminating guard to the module base. platform_owner is blocked
// from all customer CRM data by requireTenantUser (403). A path-less router.use
// would leak onto every request flowing through the shared parent.
router.use("/imports", requireTenantUser);

// The write module for permission checks depends on the payload's entityType.
// The whole import flow is gated on the target module's create permission: even
// preview/validate are non-persisting, validate runs duplicate detection that
// reveals which contacts/leads already exist in the tenant, so all three
// endpoints require the same create permission as commit.
function requireImportCreate(req: AuthRequest, res: import("express").Response, next: import("express").NextFunction) {
  const module = req.body?.entityType === "lead" ? "leads" : "contacts";
  return requirePermission(module, "create")(req, res, next);
}

// POST /imports/preview — parse an uploaded CSV/Excel file, return its columns,
// a sample of rows, an auto-mapping to standard + custom fields, and the field
// catalog. Stateless (nothing persisted).
router.post("/imports/preview", validateBody(PreviewImportBody), requireImportCreate, async (req: AuthRequest, res) => {
  res.json(await imports.preview(req.user!, req.body ?? {}));
});

// POST /imports/validate — apply a column→field mapping and return per-row
// errors + detected duplicates. Stateless (nothing persisted).
router.post("/imports/validate", validateBody(ValidateImportBody), requireImportCreate, async (req: AuthRequest, res) => {
  res.json(await imports.validate(req.user!, req.body ?? {}));
});

// POST /imports/commit — transactionally bulk-insert the mapped rows. Blocked for
// read-only (cancelled) companies; audited; gated on create permission.
router.post("/imports/commit", blockReadOnlyMutations, validateBody(CommitImportBody), requireImportCreate, auditMutations("imports"), async (req: AuthRequest, res) => {
  res.json(await imports.commit(req.user!, req.body ?? {}));
});

export default router;
