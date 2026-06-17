import { Router } from "express";
import { db } from "@workspace/db";
import { subscriptionsTable, companiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/requireAuth.js";

const router = Router();
router.use(requireAuth);

const PLANS = [
  { id: "free", name: "Free", price: 0, scansLimit: 50, usersLimit: 1, features: ["50 scans/month", "1 user", "Basic contact management"] },
  { id: "starter", name: "Starter", price: 29, scansLimit: 500, usersLimit: 5, features: ["500 scans/month", "5 users", "CRM pipeline", "Event management", "CSV export"] },
  { id: "professional", name: "Professional", price: 99, scansLimit: 5000, usersLimit: 25, features: ["5,000 scans/month", "25 users", "AI data cleaning", "Advanced analytics", "API access", "Priority support"] },
  { id: "enterprise", name: "Enterprise", price: 299, scansLimit: null, usersLimit: null, features: ["Unlimited scans", "Unlimited users", "Custom integrations", "Dedicated account manager", "SLA guarantee", "White labeling"] },
];

// GET /subscriptions/current
router.get("/subscriptions/current", async (req: AuthRequest, res) => {
  try {
    const companyId = req.user!.companyId;
    if (!companyId) { res.status(400).json({ error: "No company context" }); return; }
    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId)).limit(1);
    if (!sub) {
      // Create default subscription
      const [newSub] = await db.insert(subscriptionsTable).values({ companyId, plan: "free", status: "active", scansUsed: 0, scansLimit: 50, usersLimit: 1 }).returning();
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
router.get("/subscriptions/plans", (_req, res) => {
  res.json(PLANS);
});

// POST /subscriptions/upgrade
router.post("/subscriptions/upgrade", async (req: AuthRequest, res) => {
  try {
    const companyId = req.user!.companyId;
    if (!companyId) { res.status(400).json({ error: "No company context" }); return; }
    const { plan } = req.body;
    const planConfig = PLANS.find(p => p.id === plan);
    if (!planConfig) { res.status(400).json({ error: "Invalid plan" }); return; }

    const renewalDate = new Date();
    renewalDate.setMonth(renewalDate.getMonth() + 1);

    const [sub] = await db.update(subscriptionsTable).set({ plan, scansLimit: planConfig.scansLimit, usersLimit: planConfig.usersLimit, renewalDate: renewalDate.toISOString().slice(0, 10) }).where(eq(subscriptionsTable.companyId, companyId)).returning();
    await db.update(companiesTable).set({ plan }).where(eq(companiesTable.id, companyId));
    res.json(sub);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
