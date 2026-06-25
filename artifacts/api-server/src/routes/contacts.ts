import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateContactBody, UpdateContactBody, MakeContactOriginalBody, MergeContactsBody } from "@workspace/api-zod";
import * as contacts from "../services/contacts.service.js";

const router = Router();
router.use(requireAuth);
router.use("/contacts", requireTenantUser);
router.use("/contacts", blockReadOnlyMutations);
router.use("/contacts", auditMutations("contacts"));

// GET /contacts
router.get("/contacts", async (req: AuthRequest, res) => {
  res.json(await contacts.listContacts(req.user!, req.query as contacts.ListContactsParams));
});

// POST /contacts
router.post("/contacts", requirePermission("contacts", "create"), validateBody(CreateContactBody), async (req: AuthRequest, res) => {
  res.status(201).json(await contacts.createContact(req.user!, req.body ?? {}));
});

// GET /contacts/stats
router.get("/contacts/stats", async (req: AuthRequest, res) => {
  res.json(await contacts.contactStats(req.user!));
});

// GET /contacts/duplicates — group likely-duplicate contacts within the tenant
router.get("/contacts/duplicates", async (req: AuthRequest, res) => {
  res.json(await contacts.listDuplicates(req.user!));
});

// POST /contacts/make-original — promote a linked duplicate to be the original
router.post("/contacts/make-original", requirePermission("contacts", "edit"), validateBody(MakeContactOriginalBody), async (req: AuthRequest, res) => {
  res.json(await contacts.makeOriginal(req.user!, req.body ?? {}));
});

// POST /contacts/merge — consolidate duplicates into a primary contact
router.post("/contacts/merge", requirePermission("contacts", "delete"), validateBody(MergeContactsBody), async (req: AuthRequest, res) => {
  res.json(await contacts.mergeContacts(req.user!, req.body ?? {}));
});

// GET /contacts/:id
router.get("/contacts/:id", async (req: AuthRequest, res) => {
  res.json(await contacts.getContact(req.user!, parseInt(String(req.params.id))));
});

// PATCH /contacts/:id
router.patch("/contacts/:id", requirePermission("contacts", "edit"), validateBody(UpdateContactBody), async (req: AuthRequest, res) => {
  res.json(await contacts.updateContact(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /contacts/:id
router.delete("/contacts/:id", requirePermission("contacts", "delete"), async (req: AuthRequest, res) => {
  res.json(await contacts.deleteContact(req.user!, parseInt(String(req.params.id))));
});

// POST /contacts/:id/enrich — AI enrichment (industry, seniority, summary, talking points)
router.post("/contacts/:id/enrich", requirePermission("contacts", "edit"), async (req: AuthRequest, res) => {
  res.json(await contacts.enrichContact(req.user!, parseInt(String(req.params.id))));
});

// GET /contacts/:id/status-history — lead status change history
router.get("/contacts/:id/status-history", async (req: AuthRequest, res) => {
  res.json(await contacts.statusHistory(req.user!, parseInt(String(req.params.id))));
});

export default router;
