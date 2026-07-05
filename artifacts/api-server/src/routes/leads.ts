import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import {
  CreateLeadBody,
  UpdateLeadBody,
  CreateLeadActivityBody,
  UpdateLeadActivityBody,
  CreateLeadNoteBody,
  UpdateLeadNoteBody,
  AttachLeadTagBody,
  AssignLeadBody,
  BulkAssignLeadsBody,
  RecommendLeadAssigneeBody,
  SetLeadCustomFieldsBody,
  LogLeadCommunicationBody,
} from "@workspace/api-zod";
import * as leads from "../services/leads.service.js";
import * as activities from "../services/lead_activities.service.js";
import * as notes from "../services/lead_notes.service.js";
import * as timeline from "../services/timeline.service.js";
import * as comms from "../services/communications.service.js";

const router = Router();
router.use(requireAuth);
// Path-scoped terminating guards. `/activities` and `/notes` are separate
// top-level paths on this router (their :id routes are addressed directly), so
// they each need their own guard chain — a path-less `router.use` would leak
// onto every request flowing through the shared parent router.
for (const base of ["/leads", "/activities", "/notes"]) {
  router.use(base, requireTenantUser);
  router.use(base, blockReadOnlyMutations);
  router.use(base, auditMutations("leads"));
}

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

// POST /leads/bulk-assign — assign many leads at once (static path before /:id)
router.post("/leads/bulk-assign", requirePermission("leads", "edit"), validateBody(BulkAssignLeadsBody), async (req: AuthRequest, res) => {
  res.json(await leads.bulkAssign(req.user!, req.body ?? {}));
});

// ── Lead activities (timeline events)
router.get("/leads/:id/activities", async (req: AuthRequest, res) => {
  res.json(await activities.listActivities(req.user!, parseInt(String(req.params.id))));
});
router.post("/leads/:id/activities", requirePermission("leads", "edit"), validateBody(CreateLeadActivityBody), async (req: AuthRequest, res) => {
  res.status(201).json(await activities.createActivity(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});
router.patch("/activities/:id", requirePermission("leads", "edit"), validateBody(UpdateLeadActivityBody), async (req: AuthRequest, res) => {
  res.json(await activities.updateActivity(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});
router.delete("/activities/:id", requirePermission("leads", "delete"), async (req: AuthRequest, res) => {
  res.json(await activities.deleteActivity(req.user!, parseInt(String(req.params.id))));
});

// ── Lead notes
router.get("/leads/:id/notes", async (req: AuthRequest, res) => {
  res.json(await notes.listNotes(req.user!, parseInt(String(req.params.id))));
});
router.post("/leads/:id/notes", requirePermission("leads", "edit"), validateBody(CreateLeadNoteBody), async (req: AuthRequest, res) => {
  res.status(201).json(await notes.createNote(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});
router.patch("/notes/:id", requirePermission("leads", "edit"), validateBody(UpdateLeadNoteBody), async (req: AuthRequest, res) => {
  res.json(await notes.updateNote(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});
router.delete("/notes/:id", requirePermission("leads", "delete"), async (req: AuthRequest, res) => {
  res.json(await notes.deleteNote(req.user!, parseInt(String(req.params.id))));
});

// ── Lead tags
router.get("/leads/:id/tags", async (req: AuthRequest, res) => {
  res.json(await leads.listLeadTags(req.user!, parseInt(String(req.params.id))));
});
router.post("/leads/:id/tags", requirePermission("leads", "edit"), validateBody(AttachLeadTagBody), async (req: AuthRequest, res) => {
  res.json(await leads.attachLeadTag(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});
router.delete("/leads/:id/tags/:tagId", requirePermission("leads", "edit"), async (req: AuthRequest, res) => {
  res.json(await leads.detachLeadTag(req.user!, parseInt(String(req.params.id)), parseInt(String(req.params.tagId))));
});

// ── Lead custom-field values
router.get("/leads/:id/custom-fields", async (req: AuthRequest, res) => {
  res.json(await leads.getLeadCustomFields(req.user!, parseInt(String(req.params.id))));
});
router.put("/leads/:id/custom-fields", requirePermission("leads", "edit"), validateBody(SetLeadCustomFieldsBody), async (req: AuthRequest, res) => {
  res.json(await leads.setLeadCustomFields(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// ── Lead timeline (aggregated activities + notes)
router.get("/leads/:id/timeline", async (req: AuthRequest, res) => {
  res.json(await timeline.leadTimeline(req.user!, parseInt(String(req.params.id))));
});

// ── Lead communications (email/phone/whatsapp/calendar quick actions)
router.get("/leads/:id/communications", async (req: AuthRequest, res) => {
  res.json(await comms.listLeadCommunications(req.user!, parseInt(String(req.params.id))));
});
router.post("/leads/:id/communications", requirePermission("leads", "edit"), validateBody(LogLeadCommunicationBody), async (req: AuthRequest, res) => {
  res.status(201).json(await comms.logLeadCommunication(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// ── Lead assignment
router.post("/leads/:id/assign", requirePermission("leads", "edit"), validateBody(AssignLeadBody), async (req: AuthRequest, res) => {
  res.json(await leads.assignLead(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});
router.post("/leads/:id/auto-assign", requirePermission("leads", "edit"), async (req: AuthRequest, res) => {
  res.json(await leads.autoAssignLead(req.user!, parseInt(String(req.params.id))));
});
router.post("/leads/:id/recommend-assignee", requirePermission("leads", "edit"), validateBody(RecommendLeadAssigneeBody), async (req: AuthRequest, res) => {
  res.json(await leads.recommendAssignee(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
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
