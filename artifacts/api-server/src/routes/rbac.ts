import { Router } from "express";
import { requireAuth, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import * as rbac from "../services/rbac.service.js";

const router = Router();
router.use(requireAuth);
// Path-scoped guards (see the router-guard-leak gotcha): terminating middleware
// must be bound to the module base so it does not fire on unrelated routes.
router.use("/rbac", blockReadOnlyMutations);
router.use("/rbac", auditMutations("roles"));

// GET /rbac/permissions — the permission catalog (modules × actions).
router.get("/rbac/permissions", requirePermission("roles", "view"), async (_req: AuthRequest, res) => {
  res.json(rbac.getCatalog());
});

// GET /rbac/roles
router.get("/rbac/roles", requirePermission("roles", "view"), async (req: AuthRequest, res) => {
  res.json(await rbac.listRoles(req.user!));
});

// POST /rbac/roles
router.post("/rbac/roles", requirePermission("roles", "create"), async (req: AuthRequest, res) => {
  res.status(201).json(await rbac.createRole(req.user!, req.body ?? {}));
});

// GET /rbac/roles/:id
router.get("/rbac/roles/:id", requirePermission("roles", "view"), async (req: AuthRequest, res) => {
  res.json(await rbac.getRole(req.user!, parseInt(String(req.params.id))));
});

// PATCH /rbac/roles/:id
router.patch("/rbac/roles/:id", requirePermission("roles", "edit"), async (req: AuthRequest, res) => {
  res.json(await rbac.updateRole(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /rbac/roles/:id
router.delete("/rbac/roles/:id", requirePermission("roles", "delete"), async (req: AuthRequest, res) => {
  res.json(await rbac.deleteRole(req.user!, parseInt(String(req.params.id))));
});

export default router;
