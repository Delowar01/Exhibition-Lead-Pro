import { Router } from "express";
import { db } from "@workspace/db";
import { contactsTable, usersTable, eventsTable, scansTable, leadsTable } from "@workspace/db";
import { eq, ilike, and, count, sql, inArray } from "drizzle-orm";
import { requireAuth, blockReadOnlyMutations, requirePermission, canAccessCompany, tenantScope, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { refAccessible } from "../lib/tenant.js";
import { scoreLead, enrichContact as aiEnrichContact, logAiError } from "../lib/ai.js";
import { notifyUser } from "../lib/push.js";

const router = Router();
router.use(requireAuth);
router.use("/contacts", blockReadOnlyMutations);
router.use("/contacts", auditMutations("contacts"));

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try { return JSON.parse(tags); } catch { return []; }
}

function formatContact(c: typeof contactsTable.$inferSelect, eventName?: string | null, assignedToName?: string | null) {
  return {
    ...c,
    fullName: c.fullName ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || null),
    tags: parseTags(c.tags),
    talkingPoints: parseTags(c.talkingPoints),
    eventName: eventName ?? null,
    assignedToName: assignedToName ?? null,
  };
}

function getCompanyId(req: AuthRequest): number | null {
  return req.user!.companyId ?? null;
}

// GET /contacts
router.get("/contacts", async (req: AuthRequest, res) => {
  try {
    const { search, status, eventId, assignedTo, page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, parseInt(limit));
    const offset = (pageNum - 1) * limitNum;
    const conditions = [];
    if (req.user!.role !== "platform_owner") conditions.push(inArray(contactsTable.companyId, req.user!.accessibleCompanies));
    if (search) conditions.push(ilike(contactsTable.fullName, `%${search}%`));
    if (status) conditions.push(eq(contactsTable.status, status));
    if (eventId && !isNaN(parseInt(eventId))) conditions.push(eq(contactsTable.eventId, parseInt(eventId)));
    if (assignedTo && !isNaN(parseInt(assignedTo))) conditions.push(eq(contactsTable.assignedToId, parseInt(assignedTo)));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [{ total }] = await db.select({ total: count() }).from(contactsTable).where(whereClause);
    const contacts = await db.select().from(contactsTable).where(whereClause).limit(limitNum).offset(offset).orderBy(contactsTable.createdAt);

    const enriched = await Promise.all(contacts.map(async (c) => {
      const event = c.eventId ? await db.select({ name: eventsTable.name }).from(eventsTable).where(eq(eventsTable.id, c.eventId)).then(r => r[0]) : null;
      const assignee = c.assignedToId ? await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, c.assignedToId)).then(r => r[0]) : null;
      return formatContact(c, event?.name, assignee?.name);
    }));

    res.json({ contacts: enriched, total, page: pageNum, limit: limitNum });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /contacts
router.post("/contacts", requirePermission("contacts", "create"), async (req: AuthRequest, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) { res.status(400).json({ error: "No company context" }); return; }
    const { firstName, lastName, jobTitle, contactCompany, email, mobile, officePhone, website, country, address, linkedin, notes, tags, status, followUpDate, eventId, assignedToId, cardImageUrl } = req.body;
    if (!(await refAccessible(req.user, "events", eventId))) { res.status(400).json({ error: "Invalid eventId" }); return; }
    if (!(await refAccessible(req.user, "users", assignedToId))) { res.status(400).json({ error: "Invalid assignedToId" }); return; }
    const fullName = [firstName, lastName].filter(Boolean).join(" ") || null;
    const { arabicName } = req.body;

    // AI lead qualification (resilient: contact still saves if AI is unavailable)
    let leadScore: number | null = null;
    let leadTemperature: string | null = null;
    let aiReasoning: string | null = null;
    try {
      let eventName: string | null = null;
      if (eventId) {
        const [ev] = await db.select({ name: eventsTable.name }).from(eventsTable).where(eq(eventsTable.id, eventId)).limit(1);
        eventName = ev?.name ?? null;
      }
      const score = await scoreLead({ firstName, lastName, jobTitle, contactCompany, email, mobile, website, linkedin, country, notes }, eventName);
      leadScore = score.score;
      leadTemperature = score.temperature;
      aiReasoning = score.reasoning;
    } catch (aiErr) {
      logAiError("lead-scoring", aiErr);
    }

    const [contact] = await db.insert(contactsTable).values({ companyId, firstName, lastName, fullName, arabicName: arabicName ?? null, jobTitle, contactCompany, email, mobile, officePhone, website, country, address, linkedin, notes, tags: JSON.stringify(tags ?? []), status: status ?? "new", leadScore, leadTemperature, aiReasoning, followUpDate: followUpDate ?? null, eventId: eventId ?? null, assignedToId: assignedToId ?? null, cardImageUrl: cardImageUrl ?? null }).returning();
    res.status(201).json(formatContact(contact));

    // Notify the owning rep when a freshly captured lead scores "hot" (best-effort, after responding).
    if (contact.leadTemperature === "hot") {
      const target = contact.assignedToId ?? req.user!.id;
      void db.update(contactsTable).set({ hotNotifiedAt: new Date() }).where(eq(contactsTable.id, contact.id)).catch(() => {});
      void notifyUser(target, {
        title: "\uD83D\uDD25 Hot lead captured",
        body: `${contact.fullName ?? "New contact"}${contact.contactCompany ? ` \u00b7 ${contact.contactCompany}` : ""}${contact.leadScore != null ? ` scored ${contact.leadScore}` : ""}`,
        data: { type: "hot_lead", contactId: contact.id },
      });
    }
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /contacts/stats
router.get("/contacts/stats", async (req: AuthRequest, res) => {
  try {
    const whereClause = tenantScope(req.user, contactsTable.companyId);

    const [{ total }] = await db.select({ total: count() }).from(contactsTable).where(whereClause);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayContacts = await db.select({ count: count() }).from(contactsTable).where(and(whereClause, sql`${contactsTable.createdAt} >= ${today}`));
    const byStatus = await db.select({ status: contactsTable.status, count: count() }).from(contactsTable).where(whereClause).groupBy(contactsTable.status);

    const wonCount = byStatus.find(s => s.status === "won")?.count ?? 0;
    const conversionRate = total > 0 ? Math.round((wonCount / total) * 100) : 0;

    res.json({
      total,
      newToday: todayContacts[0]?.count ?? 0,
      byStatus: byStatus.map(s => ({ status: s.status, count: s.count, label: s.status })),
      conversionRate,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

function normEmail(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim().toLowerCase();
  return t.length > 0 ? t : null;
}
function normPhone(v: string | null): string | null {
  if (!v) return null;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
}
function normName(c: typeof contactsTable.$inferSelect): string | null {
  const name = (c.fullName ?? [c.firstName, c.lastName].filter(Boolean).join(" ")).trim().toLowerCase().replace(/\s+/g, " ");
  const company = (c.contactCompany ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!name || !company) return null;
  return `${name}|${company}`;
}

// GET /contacts/duplicates — group likely-duplicate contacts within the tenant
router.get("/contacts/duplicates", async (req: AuthRequest, res) => {
  try {
    const whereClause = tenantScope(req.user, contactsTable.companyId);
    const rows = await db.select().from(contactsTable).where(whereClause).limit(2000);

    const byKey = (extract: (c: typeof contactsTable.$inferSelect) => string | null) => {
      const map = new Map<string, typeof contactsTable.$inferSelect[]>();
      for (const c of rows) {
        const k = extract(c);
        if (!k) continue;
        const arr = map.get(k) ?? [];
        arr.push(c);
        map.set(k, arr);
      }
      return map;
    };

    const sources: { matchType: "email" | "phone" | "name"; map: Map<string, typeof contactsTable.$inferSelect[]> }[] = [
      { matchType: "email", map: byKey((c) => normEmail(c.email)) },
      { matchType: "phone", map: byKey((c) => normPhone(c.mobile) ?? normPhone(c.officePhone)) },
      { matchType: "name", map: byKey(normName) },
    ];

    const seen = new Set<string>();
    const groups: { matchType: string; matchValue: string; contacts: ReturnType<typeof formatContact>[] }[] = [];
    for (const { matchType, map } of sources) {
      for (const [key, members] of map) {
        if (members.length < 2) continue;
        const idKey = members.map((m) => m.id).sort((a, b) => a - b).join(",");
        if (seen.has(idKey)) continue;
        seen.add(idKey);
        groups.push({ matchType, matchValue: key, contacts: members.map((m) => formatContact(m)) });
      }
    }

    res.json({ groups });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const MERGE_BACKFILL_FIELDS = [
  "firstName", "lastName", "fullName", "arabicName", "jobTitle", "contactCompany",
  "email", "mobile", "officePhone", "website", "country", "address", "linkedin",
  "notes", "leadScore", "leadTemperature", "aiReasoning", "industry", "seniority",
  "enrichmentSummary", "talkingPoints", "followUpDate", "cardImageUrl", "eventId", "assignedToId",
] as const;

function isEmpty(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

// POST /contacts/merge — consolidate duplicates into a primary contact
router.post("/contacts/merge", requirePermission("contacts", "delete"), async (req: AuthRequest, res) => {
  try {
    const { primaryId, duplicateIds } = req.body as { primaryId?: number; duplicateIds?: number[] };
    if (typeof primaryId !== "number" || !Array.isArray(duplicateIds) || duplicateIds.length === 0) {
      res.status(400).json({ error: "primaryId and a non-empty duplicateIds array are required" });
      return;
    }
    const dupIds = [...new Set(duplicateIds)].filter((id) => id !== primaryId);
    if (dupIds.length === 0) { res.status(400).json({ error: "No distinct duplicate ids to merge" }); return; }

    const [primary] = await db.select().from(contactsTable).where(eq(contactsTable.id, primaryId)).limit(1);
    if (!primary || !canAccessCompany(req.user, primary.companyId)) { res.status(404).json({ error: "Primary contact not found" }); return; }

    const dups = await db.select().from(contactsTable).where(inArray(contactsTable.id, dupIds));
    if (dups.length !== dupIds.length || dups.some((d) => d.companyId !== primary.companyId)) {
      res.status(400).json({ error: "All duplicates must exist and belong to the same company as the primary contact" });
      return;
    }

    // Backfill empty primary fields from duplicates (in request order), and union tags.
    const updates: Record<string, unknown> = {};
    for (const field of MERGE_BACKFILL_FIELDS) {
      if (!isEmpty(primary[field])) continue;
      for (const d of dups) {
        if (!isEmpty(d[field])) { updates[field] = d[field]; break; }
      }
    }
    const tagSet = new Set<string>(parseTags(primary.tags));
    for (const d of dups) for (const t of parseTags(d.tags)) tagSet.add(t);
    updates.tags = JSON.stringify([...tagSet]);
    updates.updatedAt = new Date();

    const merged = await db.transaction(async (tx) => {
      await tx.update(scansTable).set({ contactId: primaryId }).where(inArray(scansTable.contactId, dupIds));
      await tx.update(leadsTable).set({ contactId: primaryId }).where(inArray(leadsTable.contactId, dupIds));
      const [updated] = await tx.update(contactsTable).set(updates as Partial<typeof contactsTable.$inferInsert>).where(eq(contactsTable.id, primaryId)).returning();
      await tx.delete(contactsTable).where(inArray(contactsTable.id, dupIds));
      return updated;
    });

    const event = merged.eventId ? await db.select({ name: eventsTable.name }).from(eventsTable).where(eq(eventsTable.id, merged.eventId)).then(r => r[0]) : null;
    const assignee = merged.assignedToId ? await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, merged.assignedToId)).then(r => r[0]) : null;
    res.json(formatContact(merged, event?.name, assignee?.name));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /contacts/:id
router.get("/contacts/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [c] = await db.select().from(contactsTable).where(eq(contactsTable.id, id)).limit(1);
    if (!c || !canAccessCompany(req.user, c.companyId)) { res.status(404).json({ error: "Contact not found" }); return; }
    const event = c.eventId ? await db.select({ name: eventsTable.name }).from(eventsTable).where(eq(eventsTable.id, c.eventId)).then(r => r[0]) : null;
    const assignee = c.assignedToId ? await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, c.assignedToId)).then(r => r[0]) : null;
    res.json(formatContact(c, event?.name, assignee?.name));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /contacts/:id
router.patch("/contacts/:id", requirePermission("contacts", "edit"), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [existing] = await db.select({ companyId: contactsTable.companyId }).from(contactsTable).where(eq(contactsTable.id, id)).limit(1);
    if (!existing || !canAccessCompany(req.user, existing.companyId)) { res.status(404).json({ error: "Contact not found" }); return; }
    const { firstName, lastName, jobTitle, contactCompany, email, mobile, officePhone, website, country, address, linkedin, notes, tags, status, followUpDate, eventId, assignedToId } = req.body;
    if (!(await refAccessible(req.user, "events", eventId))) { res.status(400).json({ error: "Invalid eventId" }); return; }
    if (!(await refAccessible(req.user, "users", assignedToId))) { res.status(400).json({ error: "Invalid assignedToId" }); return; }
    const fullName = firstName !== undefined || lastName !== undefined ? [firstName, lastName].filter(Boolean).join(" ") || null : undefined;
    const updateData: Record<string, unknown> = { firstName, lastName, jobTitle, contactCompany, email, mobile, officePhone, website, country, address, linkedin, notes, status, followUpDate, eventId, assignedToId };
    if (fullName !== undefined) updateData.fullName = fullName;
    if (tags !== undefined) updateData.tags = JSON.stringify(tags);
    // Remove undefined
    Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
    const [c] = await db.update(contactsTable).set(updateData as Partial<typeof contactsTable.$inferInsert>).where(eq(contactsTable.id, id)).returning();
    if (!c) { res.status(404).json({ error: "Contact not found" }); return; }
    const event = c.eventId ? await db.select({ name: eventsTable.name }).from(eventsTable).where(eq(eventsTable.id, c.eventId)).then(r => r[0]) : null;
    const assignee = c.assignedToId ? await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, c.assignedToId)).then(r => r[0]) : null;
    res.json(formatContact(c, event?.name, assignee?.name));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /contacts/:id
router.delete("/contacts/:id", requirePermission("contacts", "delete"), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [existing] = await db.select({ companyId: contactsTable.companyId }).from(contactsTable).where(eq(contactsTable.id, id)).limit(1);
    if (!existing || !canAccessCompany(req.user, existing.companyId)) { res.status(404).json({ error: "Contact not found" }); return; }
    await db.delete(contactsTable).where(eq(contactsTable.id, id));
    res.json({ success: true, message: "Contact deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /contacts/:id/enrich — AI enrichment (industry, seniority, summary, talking points)
router.post("/contacts/:id/enrich", requirePermission("contacts", "edit"), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [c] = await db.select().from(contactsTable).where(eq(contactsTable.id, id)).limit(1);
    if (!c || !canAccessCompany(req.user, c.companyId)) { res.status(404).json({ error: "Contact not found" }); return; }

    let result;
    try {
      result = await aiEnrichContact({
        firstName: c.firstName, lastName: c.lastName, jobTitle: c.jobTitle,
        contactCompany: c.contactCompany, email: c.email, website: c.website,
        linkedin: c.linkedin, country: c.country, notes: c.notes,
      });
    } catch (aiErr) {
      logAiError("contact-enrichment", aiErr);
      res.status(502).json({ error: "AI enrichment is temporarily unavailable. Please try again." });
      return;
    }

    const [updated] = await db.update(contactsTable).set({
      industry: result.industry,
      seniority: result.seniority,
      enrichmentSummary: result.summary,
      talkingPoints: JSON.stringify(result.talkingPoints),
      enrichedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(contactsTable.id, id)).returning();

    const event = updated.eventId ? await db.select({ name: eventsTable.name }).from(eventsTable).where(eq(eventsTable.id, updated.eventId)).then(r => r[0]) : null;
    const assignee = updated.assignedToId ? await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, updated.assignedToId)).then(r => r[0]) : null;
    res.json(formatContact(updated, event?.name, assignee?.name));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
