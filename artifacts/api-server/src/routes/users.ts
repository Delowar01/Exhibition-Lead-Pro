import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateUserBody, UpdateOwnProfileBody, UpdateUserBody, SetUserRolesBody } from "@workspace/api-zod";
import * as users from "../services/users.service.js";

const router = Router();
router.use(requireAuth);
router.use("/users", blockReadOnlyMutations);
router.use("/users", auditMutations("team"));

// GET /users
router.get("/users", requirePermission("team", "view"), async (req: AuthRequest, res) => {
  res.json(await users.listUsers(req.user!, req.query as users.ListUsersParams));
});

// POST /users
router.post("/users", requirePermission("team", "create"), validateBody(CreateUserBody), async (req: AuthRequest, res) => {
  res.status(201).json(await users.createUser(req.user!, req.body ?? {}));
});

// PATCH /users/me — authenticated user updates their OWN profile (avatar, name).
// Registered before /users/:id so the static "me" path is not swallowed by :id.
router.patch("/users/me", validateBody(UpdateOwnProfileBody), async (req: AuthRequest, res) => {
  res.json(await users.updateMe(req.user!, req.body ?? {}));
});

// GET /users/directory — tenant-scoped employee directory with org filters.
// Registered before /users/:id so the static path is not swallowed by :id.
router.get("/users/directory", requirePermission("team", "view"), async (req: AuthRequest, res) => {
  res.json(await users.listDirectory(req.user!, req.query as users.DirectoryParams));
});

// GET /users/hierarchy — reporting-manager org tree.
router.get("/users/hierarchy", requirePermission("team", "view"), async (req: AuthRequest, res) => {
  res.json(await users.getOrgHierarchy(req.user!));
});

// GET /users/:id
router.get("/users/:id", requirePermission("team", "view"), async (req: AuthRequest, res) => {
  res.json(await users.getUser(req.user!, parseInt(String(req.params.id))));
});

// PATCH /users/:id
router.patch("/users/:id", requirePermission("team", "edit"), validateBody(UpdateUserBody), async (req: AuthRequest, res) => {
  res.json(await users.updateUser(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /users/:id — soft-delete + force-logout.
router.delete("/users/:id", requirePermission("team", "delete"), async (req: AuthRequest, res) => {
  res.json(await users.deleteUser(req.user!, parseInt(String(req.params.id))));
});

// POST /users/:id/enable
router.post("/users/:id/enable", requirePermission("team", "edit"), async (req: AuthRequest, res) => {
  res.json(await users.setUserActive(req.user!, parseInt(String(req.params.id)), true));
});

// POST /users/:id/disable
router.post("/users/:id/disable", requirePermission("team", "edit"), async (req: AuthRequest, res) => {
  res.json(await users.setUserActive(req.user!, parseInt(String(req.params.id)), false));
});

// POST /users/:id/force-logout — revoke all of the target user's sessions.
router.post("/users/:id/force-logout", requirePermission("team", "edit"), async (req: AuthRequest, res) => {
  res.json(await users.forceLogout(req.user!, parseInt(String(req.params.id))));
});

// POST /users/:id/reset-password — record-only trigger (email lands in Phase 2.5).
router.post("/users/:id/reset-password", requirePermission("team", "edit"), async (req: AuthRequest, res) => {
  res.json(await users.requestPasswordReset(req.user!, parseInt(String(req.params.id))));
});

// GET /users/:id/login-history
// GAP-04 (Enterprise Privacy): login history exposes IPs / device / browser / timestamps.
// requireTenantUser blocks the platform operator (platform_owner) from this forensic PII
// while company admins keep tenant-scoped access (findById is tenant-scoped → 404 cross-tenant).
// Operational user management (enable/disable/reset-password/force-logout) is intentionally
// left available to platform_owner. A future audited "support access" flow (audit R5) would
// re-grant this deliberately and time-bounded.
router.get("/users/:id/login-history", requireTenantUser, requirePermission("team", "view"), async (req: AuthRequest, res) => {
  const limit = req.query.limit ? parseInt(String(req.query.limit)) : 50;
  res.json(await users.loginHistory(req.user!, parseInt(String(req.params.id)), limit));
});

// PUT /users/:id/roles — replace the user's assigned custom roles.
router.put("/users/:id/roles", requirePermission("team", "edit"), validateBody(SetUserRolesBody), async (req: AuthRequest, res) => {
  const roleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds : [];
  res.json(await users.setUserRoles(req.user!, parseInt(String(req.params.id)), roleIds));
});

export default router;
