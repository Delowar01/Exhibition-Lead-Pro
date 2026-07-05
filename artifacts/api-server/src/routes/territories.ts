import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateTerritoryBody, UpdateTerritoryBody } from "@workspace/api-zod";
import * as territories from "../services/territories.service.js";

const router = Router();
router.use(requireAuth);
// Path-scoped terminating guards to the module base. platform_owner is blocked
// from all customer territory data by requireTenantUser (403). A path-less
// router.use would leak onto every request flowing through the shared parent.
router.use("/territories", requireTenantUser);
router.use("/territories", blockReadOnlyMutations);
router.use("/territories", auditMutations("territories"));

// GET /territories
router.get("/territories", async (req: AuthRequest, res) => {
  res.json(await territories.listTerritories(req.user!));
});

// POST /territories
router.post("/territories", requirePermission("territories", "create"), validateBody(CreateTerritoryBody), async (req: AuthRequest, res) => {
  res.status(201).json(await territories.createTerritory(req.user!, req.body ?? {}));
});

// GET /territories/:id
router.get("/territories/:id", async (req: AuthRequest, res) => {
  res.json(await territories.getTerritory(req.user!, parseInt(String(req.params.id))));
});

// PATCH /territories/:id
router.patch("/territories/:id", requirePermission("territories", "edit"), validateBody(UpdateTerritoryBody), async (req: AuthRequest, res) => {
  res.json(await territories.updateTerritory(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /territories/:id
router.delete("/territories/:id", requirePermission("territories", "delete"), async (req: AuthRequest, res) => {
  res.json(await territories.deleteTerritory(req.user!, parseInt(String(req.params.id))));
});

export default router;
