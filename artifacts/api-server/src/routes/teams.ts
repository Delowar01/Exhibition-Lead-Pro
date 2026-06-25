import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateTeamBody, UpdateTeamBody, AssignTeamMembersBody } from "@workspace/api-zod";
import * as teams from "../services/teams.service.js";

const router = Router();
router.use(requireAuth);
router.use("/teams", requireTenantUser);
router.use("/teams", blockReadOnlyMutations);
router.use("/teams", auditMutations("teams"));

// GET /teams
router.get("/teams", requirePermission("teams", "view"), async (req: AuthRequest, res) => {
  res.json(await teams.listTeams(req.user!, req.query as teams.ListTeamsParams));
});

// POST /teams
router.post("/teams", requirePermission("teams", "create"), validateBody(CreateTeamBody), async (req: AuthRequest, res) => {
  res.status(201).json(await teams.createTeam(req.user!, req.body ?? {}));
});

// GET /teams/:id
router.get("/teams/:id", requirePermission("teams", "view"), async (req: AuthRequest, res) => {
  res.json(await teams.getTeam(req.user!, parseInt(String(req.params.id))));
});

// PATCH /teams/:id
router.patch("/teams/:id", requirePermission("teams", "edit"), validateBody(UpdateTeamBody), async (req: AuthRequest, res) => {
  res.json(await teams.updateTeam(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /teams/:id
router.delete("/teams/:id", requirePermission("teams", "delete"), async (req: AuthRequest, res) => {
  res.json(await teams.deleteTeam(req.user!, parseInt(String(req.params.id))));
});

// POST /teams/:id/archive
router.post("/teams/:id/archive", requirePermission("teams", "edit"), async (req: AuthRequest, res) => {
  res.json(await teams.archiveTeam(req.user!, parseInt(String(req.params.id))));
});

// POST /teams/:id/restore
router.post("/teams/:id/restore", requirePermission("teams", "edit"), async (req: AuthRequest, res) => {
  res.json(await teams.restoreTeam(req.user!, parseInt(String(req.params.id))));
});

// GET /teams/:id/members
router.get("/teams/:id/members", requirePermission("teams", "view"), async (req: AuthRequest, res) => {
  res.json(await teams.listTeamMembers(req.user!, parseInt(String(req.params.id))));
});

// POST /teams/:id/members — assign/move users into this team.
router.post("/teams/:id/members", requirePermission("teams", "edit"), validateBody(AssignTeamMembersBody), async (req: AuthRequest, res) => {
  const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
  res.json(await teams.assignTeamMembers(req.user!, parseInt(String(req.params.id)), userIds));
});

export default router;
