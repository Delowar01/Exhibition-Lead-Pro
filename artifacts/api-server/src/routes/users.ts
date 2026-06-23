import { Router } from "express";
import { requireAuth, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import * as users from "../services/users.service.js";

const router = Router();
router.use(requireAuth);
router.use("/users", blockReadOnlyMutations);
router.use("/users", auditMutations("team"));

// GET /users
router.get("/users", async (req: AuthRequest, res) => {
  res.json(await users.listUsers(req.user!, req.query as users.ListUsersParams));
});

// POST /users
router.post("/users", requirePermission("team", "create"), async (req: AuthRequest, res) => {
  res.status(201).json(await users.createUser(req.user!, req.body ?? {}));
});

// PATCH /users/me — authenticated user updates their OWN profile (avatar, name).
// Registered before /users/:id so the static "me" path is not swallowed by :id.
router.patch("/users/me", async (req: AuthRequest, res) => {
  res.json(await users.updateMe(req.user!, req.body ?? {}));
});

// GET /users/:id
router.get("/users/:id", async (req: AuthRequest, res) => {
  res.json(await users.getUser(req.user!, parseInt(String(req.params.id))));
});

// PATCH /users/:id
router.patch("/users/:id", requirePermission("team", "edit"), async (req: AuthRequest, res) => {
  res.json(await users.updateUser(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /users/:id
router.delete("/users/:id", requirePermission("team", "delete"), async (req: AuthRequest, res) => {
  res.json(await users.deleteUser(req.user!, parseInt(String(req.params.id))));
});

export default router;
