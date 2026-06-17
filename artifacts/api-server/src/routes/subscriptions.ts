import { Router } from "express";
import { db } from "@workspace/db";
import { subscriptionsTable, companiesTable, plansTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAuth, requireWritable, blockReadOnlyMutations, type AuthRequest } from "../middlewares/requireAuth.js";
import { writeAudit } from "../lib/audit.js";

const router = Router();
router.use(requireAuth);
router.use("/subscriptions", blockReadOnlyMutations);

// GET /subscriptions/current
router.get("/subscriptions/current", async (req: AuthRequest, res) => {
  try {
    const companyId = req.user!.companyId;
    if (!companyId) { res.status(400).json({ error: "No company context" }); return; }
    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId)).limit(1);
    if (!sub) {
      // Create a default free subscription seeded from the free plan defaults.
      const [freePlan] = await db.select().from(plansTable).where(eq(plansTable.id, "free")).limit(1);
      const [newSub] = await db.insert(subscriptionsTable).values({
        companyId, plan: "free", status: "active", scansUsed: 0,
        scansLimit: 50, usersLimit: 1,
        adminsLimit: freePlan?.adminsLimit ?? 1, employeesLimit: freePlan?.employeesLimit ?? 0,
        contactsLimit: freePlan?.contactsLimit ?? 50, eventsLimit: freePlan?.eventsLimit ?? 1,
        storageLimitMb: freePlan?.storageLimitMb ?? 100, apiLimit: freePlan?.apiLimit ?? 0,
      }).returning();
      res.json(newSub);
      return;
    }
    res.json(sub);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /subscriptions/plans
router.get("/subscriptions/plans", async (req: AuthRequest, res) => {
  try {
    const plans = await db.select().from(plansTable).where(eq(plansTable.isActive, true)).orderBy(asc(plansTable.sortOrder));
    res.json(plans.map((p) => ({
      id: p.id, name: p.name, description: p.description, priceMonthly: Number(p.priceMonthly),
      currency: p.currency, adminsLimit: p.adminsLimit, employeesLimit: p.employeesLimit,
      contactsLimit: p.contactsLimit, eventsLimit: p.eventsLimit, storageLimitMb: p.storageLimitMb,
      apiLimit: p.apiLimit, trialDays: p.trialDays, features: p.features, sortOrder: p.sortOrder, isActive: p.isActive,
    })));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /subscriptions/upgrade
router.post("/subscriptions/upgrade", requireWritable, async (req: AuthRequest, res) => {
  try {
    const companyId = req.user!.companyId;
    if (!companyId) { res.status(400).json({ error: "No company context" }); return; }
    const { plan } = req.body;
    const [planConfig] = await db.select().from(plansTable).where(eq(plansTable.id, plan)).limit(1);
    if (!planConfig) { res.status(400).json({ error: "Invalid plan" }); return; }

    const renewalDate = new Date();
    renewalDate.setMonth(renewalDate.getMonth() + 1);

    const [sub] = await db.update(subscriptionsTable).set({
      plan, status: "active",
      adminsLimit: planConfig.adminsLimit, employeesLimit: planConfig.employeesLimit,
      contactsLimit: planConfig.contactsLimit, eventsLimit: planConfig.eventsLimit,
      storageLimitMb: planConfig.storageLimitMb, apiLimit: planConfig.apiLimit,
      renewalDate: renewalDate.toISOString().slice(0, 10), updatedAt: new Date(),
    }).where(eq(subscriptionsTable.companyId, companyId)).returning();
    await db.update(companiesTable).set({ plan, status: "active", updatedAt: new Date() }).where(eq(companiesTable.id, companyId));
    await writeAudit(req, { action: "subscription.upgrade", entityType: "subscription", entityId: companyId, metadata: { plan } });
    res.json(sub);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
