import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateCrmOrganizationBody, UpdateCrmOrganizationBody } from "@workspace/api-zod";
import * as organizations from "../services/organizations.service.js";

const router = Router();
router.use(requireAuth);
router.use("/organizations", requireTenantUser);
router.use("/organizations", blockReadOnlyMutations);
router.use("/organizations", auditMutations("organizations"));

// GET /organizations
router.get("/organizations", requirePermission("organizations", "view"), async (req: AuthRequest, res) => {
  res.json(await organizations.listOrganizations(req.user!, req.query as organizations.ListOrganizationsParams));
});

// POST /organizations
router.post("/organizations", requirePermission("organizations", "create"), validateBody(CreateCrmOrganizationBody), async (req: AuthRequest, res) => {
  res.status(201).json(await organizations.createOrganization(req.user!, req.body ?? {}));
});

// Static sub-paths MUST be registered before /:id or the :id param swallows them.
// GET /organizations/:id/contacts
router.get("/organizations/:id/contacts", requirePermission("organizations", "view"), async (req: AuthRequest, res) => {
  res.json(await organizations.listOrganizationContacts(req.user!, parseInt(String(req.params.id))));
});

// GET /organizations/:id/leads
router.get("/organizations/:id/leads", requirePermission("organizations", "view"), async (req: AuthRequest, res) => {
  res.json(await organizations.listOrganizationLeads(req.user!, parseInt(String(req.params.id))));
});

// POST /organizations/:id/archive
router.post("/organizations/:id/archive", requirePermission("organizations", "edit"), async (req: AuthRequest, res) => {
  res.json(await organizations.archiveOrganization(req.user!, parseInt(String(req.params.id))));
});

// POST /organizations/:id/restore
router.post("/organizations/:id/restore", requirePermission("organizations", "edit"), async (req: AuthRequest, res) => {
  res.json(await organizations.restoreOrganization(req.user!, parseInt(String(req.params.id))));
});

// GET /organizations/:id
router.get("/organizations/:id", requirePermission("organizations", "view"), async (req: AuthRequest, res) => {
  res.json(await organizations.getOrganization(req.user!, parseInt(String(req.params.id))));
});

// PATCH /organizations/:id
router.patch("/organizations/:id", requirePermission("organizations", "edit"), validateBody(UpdateCrmOrganizationBody), async (req: AuthRequest, res) => {
  res.json(await organizations.updateOrganization(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /organizations/:id
router.delete("/organizations/:id", requirePermission("organizations", "delete"), async (req: AuthRequest, res) => {
  res.json(await organizations.deleteOrganization(req.user!, parseInt(String(req.params.id))));
});

export default router;
