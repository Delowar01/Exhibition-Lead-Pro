import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateTagBody, UpdateTagBody } from "@workspace/api-zod";
import * as tags from "../services/tags.service.js";

const router = Router();
router.use(requireAuth);
router.use("/tags", requireTenantUser);
router.use("/tags", blockReadOnlyMutations);
router.use("/tags", auditMutations("tags"));

// GET /tags
router.get("/tags", async (req: AuthRequest, res) => {
  res.json(await tags.listTags(req.user!));
});

// POST /tags
router.post("/tags", requirePermission("leads", "create"), validateBody(CreateTagBody), async (req: AuthRequest, res) => {
  res.status(201).json(await tags.createTag(req.user!, req.body ?? {}));
});

// PATCH /tags/:id
router.patch("/tags/:id", requirePermission("leads", "edit"), validateBody(UpdateTagBody), async (req: AuthRequest, res) => {
  res.json(await tags.updateTag(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /tags/:id
router.delete("/tags/:id", requirePermission("leads", "delete"), async (req: AuthRequest, res) => {
  res.json(await tags.deleteTag(req.user!, parseInt(String(req.params.id))));
});

export default router;
