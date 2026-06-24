import { Router } from "express";
import { requireAuth, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateLeadBody, UpdateLeadBody } from "@workspace/api-zod";
import * as leads from "../services/leads.service.js";

const router = Router();
router.use(requireAuth);
router.use("/leads", blockReadOnlyMutations);
router.use("/leads", auditMutations("leads"));

// GET /leads
router.get("/leads", async (req: AuthRequest, res) => {
  res.json(await leads.listLeads(req.user!, req.query as leads.ListLeadsParams));
});

// POST /leads
router.post("/leads", requirePermission("leads", "create"), validateBody(CreateLeadBody), async (req: AuthRequest, res) => {
  const result = await leads.createLead(req.user!, req.body ?? {});
  if (result.conflict) {
    res.status(409).json({ error: "Contact already has an open pipeline opportunity", existingId: result.existingId });
    return;
  }
  res.status(201).json(result.lead);
});

// GET /leads/pipeline
router.get("/leads/pipeline", async (req: AuthRequest, res) => {
  res.json(await leads.getPipeline(req.user!));
});

// GET /leads/:id
router.get("/leads/:id", async (req: AuthRequest, res) => {
  res.json(await leads.getLead(req.user!, parseInt(String(req.params.id))));
});

// PATCH /leads/:id
router.patch("/leads/:id", requirePermission("leads", "edit"), validateBody(UpdateLeadBody), async (req: AuthRequest, res) => {
  res.json(await leads.updateLead(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /leads/:id
router.delete("/leads/:id", requirePermission("leads", "delete"), async (req: AuthRequest, res) => {
  res.json(await leads.deleteLead(req.user!, parseInt(String(req.params.id))));
});

export default router;
