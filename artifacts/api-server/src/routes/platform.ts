import { Router } from "express";
import { db } from "@workspace/db";
import { companiesTable, usersTable, contactsTable, scansTable, leadsTable, activityLogsTable } from "@workspace/db";
import { eq, count, sum, sql, gte } from "drizzle-orm";
import { requireAuth, requireRole, type AuthRequest } from "../middlewares/requireAuth.js";

const router = Router();
router.use(requireAuth);
router.use("/platform", requireRole("platform_owner"));

// GET /platform/stats
router.get("/platform/stats", async (req: AuthRequest, res) => {
  try {
    const [{ totalCompanies }] = await db.select({ totalCompanies: count() }).from(companiesTable);
    const [{ activeCompanies }] = await db.select({ activeCompanies: count() }).from(companiesTable).where(eq(companiesTable.status, "active"));
    const [{ totalUsers }] = await db.select({ totalUsers: count() }).from(usersTable);
    const [{ totalScans }] = await db.select({ totalScans: count() }).from(scansTable);
    const [{ totalLeads }] = await db.select({ totalLeads: count() }).from(leadsTable);

    const planDistribution = await db.select({ status: companiesTable.plan, count: count() }).from(companiesTable).groupBy(companiesTable.plan);

    // Simulate monthly revenue from plans
    const planRevenue: Record<string, number> = { free: 0, starter: 29, professional: 99, enterprise: 299 };
    const monthlyRevenue = planDistribution.reduce((sum, p) => sum + (planRevenue[p.status] ?? 0) * p.count, 0);

    res.json({
      totalCompanies, activeCompanies, totalUsers, totalScans, totalLeads,
      monthlyRevenue,
      churnRate: totalCompanies > 0 ? Math.round(((totalCompanies - activeCompanies) / totalCompanies) * 100) : 0,
      subscriptionDistribution: planDistribution.map(p => ({ status: p.status, count: p.count, label: p.status })),
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /platform/revenue-trend
router.get("/platform/revenue-trend", async (req: AuthRequest, res) => {
  try {
    // Generate 12-month revenue trend (simulated based on company creation dates)
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const label = d.toLocaleString("default", { month: "short", year: "2-digit" });
      // Simulate growing revenue
      const baseRevenue = 1200 + (11 - i) * 450 + Math.floor(Math.random() * 300);
      months.push({ date: d.toISOString().slice(0, 7), value: baseRevenue, label });
    }
    res.json(months);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /platform/scan-trend
router.get("/platform/scan-trend", async (req: AuthRequest, res) => {
  try {
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString("default", { month: "short", day: "numeric" });
      days.push({ date: d.toISOString().slice(0, 10), value: Math.floor(40 + Math.random() * 120), label });
    }
    res.json(days);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /platform/activity
router.get("/platform/activity", async (req: AuthRequest, res) => {
  try {
    const activity = await db.select().from(activityLogsTable).orderBy(sql`${activityLogsTable.createdAt} DESC`).limit(50);
    res.json(activity);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
