import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreatePipelineStageBody, UpdatePipelineStageBody, ReorderPipelineStagesBody } from "@workspace/api-zod";
import * as pipeline from "../services/pipeline.service.js";

const router = Router();
router.use(requireAuth);
router.use("/pipeline", requireTenantUser);
router.use("/pipeline", blockReadOnlyMutations);
router.use("/pipeline", auditMutations("pipeline"));

// GET /pipeline/stages
router.get("/pipeline/stages", async (req: AuthRequest, res) => {
  res.json(await pipeline.listStages(req.user!));
});

// POST /pipeline/stages
router.post("/pipeline/stages", requirePermission("leads", "create"), validateBody(CreatePipelineStageBody), async (req: AuthRequest, res) => {
  res.status(201).json(await pipeline.createStage(req.user!, req.body ?? {}));
});

// POST /pipeline/stages/reorder — must precede /pipeline/stages/:id
router.post("/pipeline/stages/reorder", requirePermission("leads", "edit"), validateBody(ReorderPipelineStagesBody), async (req: AuthRequest, res) => {
  res.json(await pipeline.reorderStages(req.user!, req.body ?? {}));
});

// PATCH /pipeline/stages/:id
router.patch("/pipeline/stages/:id", requirePermission("leads", "edit"), validateBody(UpdatePipelineStageBody), async (req: AuthRequest, res) => {
  res.json(await pipeline.updateStage(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /pipeline/stages/:id
router.delete("/pipeline/stages/:id", requirePermission("leads", "delete"), async (req: AuthRequest, res) => {
  res.json(await pipeline.deleteStage(req.user!, parseInt(String(req.params.id))));
});

export default router;
