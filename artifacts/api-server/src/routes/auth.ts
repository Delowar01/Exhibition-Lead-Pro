import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable,
  companiesTable,
  subscriptionsTable,
  activityLogsTable,
  plansTable,
  userCompanyAccessTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { hashPassword, comparePassword, signToken } from "../lib/auth.js";
import { requireAuth, evaluateCompanyAccess, type AuthRequest } from "../middlewares/requireAuth.js";
import { writeAudit } from "../lib/audit.js";

const router = Router();

async function accessibleCompaniesFor(userId: number, companyId: number | null): Promise<number[]> {
  const rows = await db
    .select({ companyId: userCompanyAccessTable.companyId })
    .from(userCompanyAccessTable)
    .where(eq(userCompanyAccessTable.userId, userId));
  return Array.from(new Set([...(companyId ? [companyId] : []), ...rows.map((r) => r.companyId)]));
}

// POST /auth/login
router.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: "Email and password required" });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user || !comparePassword(password, user.passwordHash)) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    if (!user.isActive) {
      res.status(401).json({ error: "Account is disabled" });
      return;
    }

    let company: { name: string | null } | null = null;
    if (user.companyId) {
      const [c] = await db
        .select({ name: companiesTable.name, status: companiesTable.status, trialEndsAt: companiesTable.trialEndsAt })
        .from(companiesTable)
        .where(eq(companiesTable.id, user.companyId))
        .limit(1);
      if (c) {
        const access = evaluateCompanyAccess(c);
        if (access.blocked) {
          res.status(403).json({ error: access.reason });
          return;
        }
        company = { name: c.name };
      }
    }

    await db.update(usersTable).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(usersTable.id, user.id));
    await writeAudit(req, { action: "user.login", userId: user.id, userName: user.email, companyId: user.companyId, entityType: "user", entityId: user.id });

    const token = signToken({ id: user.id, email: user.email, role: user.role, companyId: user.companyId });
    const accessibleCompanies = await accessibleCompaniesFor(user.id, user.companyId);
    res.json({
      token,
      user: {
        id: user.id, email: user.email, name: user.name, role: user.role, phone: user.phone,
        companyId: user.companyId, companyName: company?.name ?? null, avatarUrl: user.avatarUrl,
        permissions: user.permissions ?? {}, contactVisibility: user.contactVisibility,
        companyVisibility: user.companyVisibility, accessibleCompanies,
        isActive: user.isActive, lastLoginAt: user.lastLoginAt, createdAt: user.createdAt,
      },
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/register
router.post("/auth/register", async (req, res) => {
  try {
    const { email, password, name, companyName, industry, country } = req.body;
    if (!email || !password || !name || !companyName) {
      res.status(400).json({ error: "email, password, name, companyName required" });
      return;
    }
    const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing) {
      res.status(400).json({ error: "Email already registered" });
      return;
    }

    const [freePlan] = await db.select().from(plansTable).where(eq(plansTable.id, "free")).limit(1);
    const trialDays = freePlan?.trialDays ?? 14;
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);

    const [company] = await db
      .insert(companiesTable)
      .values({ name: companyName, industry: industry ?? null, country: country ?? null, plan: "free", status: "trial", trialEndsAt })
      .returning();
    await db.insert(subscriptionsTable).values({
      companyId: company.id, plan: "free", status: "trial",
      scansUsed: 0, scansLimit: 50, usersLimit: 1,
      adminsLimit: freePlan?.adminsLimit ?? 1, employeesLimit: freePlan?.employeesLimit ?? 0,
      contactsLimit: freePlan?.contactsLimit ?? 50, eventsLimit: freePlan?.eventsLimit ?? 1,
      storageLimitMb: freePlan?.storageLimitMb ?? 100, apiLimit: freePlan?.apiLimit ?? 0,
      trialEndsAt: trialEndsAt.toISOString().slice(0, 10),
    });

    const passwordHash = hashPassword(password);
    const [user] = await db
      .insert(usersTable)
      .values({ email, passwordHash, name, role: "primary_admin", companyId: company.id, isActive: true, contactVisibility: "all", companyVisibility: "own" })
      .returning();
    await db.update(companiesTable).set({ createdById: user.id }).where(eq(companiesTable.id, company.id));

    await db.insert(activityLogsTable).values({ type: "company_created", description: `New company registered: ${companyName}`, companyId: company.id, companyName, userId: user.id, userName: name });
    await writeAudit(req, { action: "company.register", userId: user.id, userName: user.email, companyId: company.id, entityType: "company", entityId: company.id, metadata: { companyName } });

    const token = signToken({ id: user.id, email: user.email, role: user.role, companyId: user.companyId });
    res.status(201).json({
      token,
      user: {
        id: user.id, email: user.email, name: user.name, role: user.role, phone: user.phone,
        companyId: user.companyId, companyName: company.name, avatarUrl: null,
        permissions: {}, contactVisibility: user.contactVisibility, companyVisibility: user.companyVisibility,
        accessibleCompanies: [company.id], isActive: user.isActive, lastLoginAt: null, createdAt: user.createdAt,
      },
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/me
router.get("/auth/me", requireAuth, async (req: AuthRequest, res) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    const company = user.companyId ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, user.companyId)).then(r => r[0]) : null;
    res.json({
      id: user.id, email: user.email, name: user.name, role: user.role, phone: user.phone,
      companyId: user.companyId, companyName: company?.name ?? null, avatarUrl: user.avatarUrl,
      permissions: user.permissions ?? {}, contactVisibility: user.contactVisibility,
      companyVisibility: user.companyVisibility, accessibleCompanies: req.user!.accessibleCompanies,
      isActive: user.isActive, lastLoginAt: user.lastLoginAt, createdAt: user.createdAt,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/logout
router.post("/auth/logout", (_req, res) => {
  res.json({ success: true, message: "Logged out" });
});

export default router;
