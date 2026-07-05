import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateCustomFieldDefinitionBody, UpdateCustomFieldDefinitionBody } from "@workspace/api-zod";
import * as customFields from "../services/custom_fields.service.js";

const router = Router();
router.use(requireAuth);
// Path-scoped terminating guards to the module base. platform_owner is blocked
// from all customer custom-field data by requireTenantUser (403). A path-less
// router.use would leak onto every request flowing through the shared parent.
router.use("/custom-fields", requireTenantUser);
router.use("/custom-fields", blockReadOnlyMutations);
router.use("/custom-fields", auditMutations("custom_fields"));

// GET /custom-fields
router.get("/custom-fields", async (req: AuthRequest, res) => {
  res.json(await customFields.listDefinitions(req.user!, req.query as customFields.ListDefinitionsParams));
});

// POST /custom-fields
router.post("/custom-fields", requirePermission("custom_fields", "create"), validateBody(CreateCustomFieldDefinitionBody), async (req: AuthRequest, res) => {
  res.status(201).json(await customFields.createDefinition(req.user!, req.body ?? {}));
});

// GET /custom-fields/:id
router.get("/custom-fields/:id", async (req: AuthRequest, res) => {
  res.json(await customFields.getDefinition(req.user!, parseInt(String(req.params.id))));
});

// PATCH /custom-fields/:id
router.patch("/custom-fields/:id", requirePermission("custom_fields", "edit"), validateBody(UpdateCustomFieldDefinitionBody), async (req: AuthRequest, res) => {
  res.json(await customFields.updateDefinition(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /custom-fields/:id
router.delete("/custom-fields/:id", requirePermission("custom_fields", "delete"), async (req: AuthRequest, res) => {
  res.json(await customFields.deleteDefinition(req.user!, parseInt(String(req.params.id))));
});

export default router;
