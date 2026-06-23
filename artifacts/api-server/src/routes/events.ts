import { Router } from "express";
import { requireAuth, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import * as events from "../services/events.service.js";

const router = Router();
router.use(requireAuth);
router.use("/events", blockReadOnlyMutations);
router.use("/events", auditMutations("events"));

// GET /events
router.get("/events", async (req: AuthRequest, res) => {
  res.json(await events.listEvents(req.user!, req.query as events.ListEventsParams));
});

// POST /events
router.post("/events", requirePermission("events", "create"), async (req: AuthRequest, res) => {
  res.status(201).json(await events.createEvent(req.user!, req.body ?? {}));
});

// GET /events/:id
router.get("/events/:id", async (req: AuthRequest, res) => {
  res.json(await events.getEvent(req.user!, parseInt(String(req.params.id))));
});

// PATCH /events/:id
router.patch("/events/:id", requirePermission("events", "edit"), async (req: AuthRequest, res) => {
  res.json(await events.updateEvent(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /events/:id
router.delete("/events/:id", requirePermission("events", "delete"), async (req: AuthRequest, res) => {
  res.json(await events.deleteEvent(req.user!, parseInt(String(req.params.id))));
});

// GET /events/:id/stats
router.get("/events/:id/stats", async (req: AuthRequest, res) => {
  res.json(await events.getEventStats(req.user!, parseInt(String(req.params.id))));
});

export default router;
