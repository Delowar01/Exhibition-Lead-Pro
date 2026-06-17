import { Router } from "express";
import { db } from "@workspace/db";
import { companiesTable, usersTable, contactsTable, scansTable, activityLogsTable } from "@workspace/db";
import { eq, ilike, and, count, sql } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/requireAuth.js";

const router = Router();
router.use(requireAuth);

// GET /companies
router.get("/companies", async (req: AuthRequest, res) => {
  try {
    const { search, status, plan, page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, parseInt(limit));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    if (search) conditions.push(ilike(companiesTable.name, `%${search}%`));
    if (status) conditions.push(eq(companiesTable.status, status));
    if (plan) conditions.push(eq(companiesTable.plan, plan));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [{ total }] = await db.select({ total: count() }).from(companiesTable).where(whereClause);

    const companies = await db.select().from(companiesTable).where(whereClause).limit(limitNum).offset(offset).orderBy(companiesTable.createdAt);

    // Enrich with counts
    const enriched = await Promise.all(companies.map(async (c) => {
      const [userCount] = await db.select({ count: count() }).from(usersTable).where(eq(usersTable.companyId, c.id));
      const [contactCount] = await db.select({ count: count() }).from(contactsTable).where(eq(contactsTable.companyId, c.id));
      const [scanCount] = await db.select({ count: count() }).from(scansTable).where(eq(scansTable.companyId, c.id));
      return { ...c, userCount: userCount.count, contactCount: contactCount.count, scanCount: scanCount.count };
    }));

    res.json({ companies: enriched, total, page: pageNum, limit: limitNum });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /companies
router.post("/companies", async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== "platform_owner") { res.status(403).json({ error: "Forbidden" }); return; }
    const { name, industry, country, address, vatNumber, website, plan } = req.body;
    if (!name) { res.status(400).json({ error: "name required" }); return; }
    const [company] = await db.insert(companiesTable).values({ name, industry, country, address, vatNumber, website, plan: plan ?? "free" }).returning();
    await db.insert(activityLogsTable).values({ type: "company_created", description: `Company created: ${name}`, companyId: company.id, companyName: name, userId: req.user!.id, userName: req.user!.email });
    res.status(201).json({ ...company, userCount: 0, contactCount: 0, scanCount: 0 });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /companies/:id
router.get("/companies/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, id)).limit(1);
    if (!company) { res.status(404).json({ error: "Company not found" }); return; }
    const [userCount] = await db.select({ count: count() }).from(usersTable).where(eq(usersTable.companyId, id));
    const [contactCount] = await db.select({ count: count() }).from(contactsTable).where(eq(contactsTable.companyId, id));
    const [scanCount] = await db.select({ count: count() }).from(scansTable).where(eq(scansTable.companyId, id));
    res.json({ ...company, userCount: userCount.count, contactCount: contactCount.count, scanCount: scanCount.count });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /companies/:id
router.patch("/companies/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, industry, country, address, vatNumber, website, plan } = req.body;
    const [company] = await db.update(companiesTable).set({ name, industry, country, address, vatNumber, website, plan }).where(eq(companiesTable.id, id)).returning();
    if (!company) { res.status(404).json({ error: "Company not found" }); return; }
    res.json({ ...company, userCount: 0, contactCount: 0, scanCount: 0 });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /companies/:id
router.delete("/companies/:id", async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== "platform_owner") { res.status(403).json({ error: "Forbidden" }); return; }
    const id = parseInt(req.params.id);
    await db.delete(companiesTable).where(eq(companiesTable.id, id));
    res.json({ success: true, message: "Company deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /companies/:id/suspend
router.post("/companies/:id/suspend", async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== "platform_owner") { res.status(403).json({ error: "Forbidden" }); return; }
    const id = parseInt(req.params.id);
    const [company] = await db.update(companiesTable).set({ status: "suspended" }).where(eq(companiesTable.id, id)).returning();
    await db.insert(activityLogsTable).values({ type: "company_suspended", description: `Company suspended: ${company.name}`, companyId: id, companyName: company.name, userId: req.user!.id, userName: req.user!.email });
    res.json({ ...company, userCount: 0, contactCount: 0, scanCount: 0 });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /companies/:id/activate
router.post("/companies/:id/activate", async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== "platform_owner") { res.status(403).json({ error: "Forbidden" }); return; }
    const id = parseInt(req.params.id);
    const [company] = await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, id)).returning();
    await db.insert(activityLogsTable).values({ type: "company_activated", description: `Company activated: ${company.name}`, companyId: id, companyName: company.name, userId: req.user!.id, userName: req.user!.email });
    res.json({ ...company, userCount: 0, contactCount: 0, scanCount: 0 });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
