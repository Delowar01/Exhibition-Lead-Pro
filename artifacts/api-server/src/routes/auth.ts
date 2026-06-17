import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, companiesTable, subscriptionsTable, activityLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hashPassword, comparePassword, signToken } from "../lib/auth.js";
import { requireAuth, type AuthRequest } from "../middlewares/requireAuth.js";

const router = Router();

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
    const token = signToken({ id: user.id, email: user.email, role: user.role, companyId: user.companyId });
    const company = user.companyId ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, user.companyId)).then(r => r[0]) : null;
    res.json({
      token,
      user: {
        id: user.id, email: user.email, name: user.name, role: user.role,
        companyId: user.companyId, companyName: company?.name ?? null,
        avatarUrl: user.avatarUrl, isActive: user.isActive, createdAt: user.createdAt,
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
    // Create company
    const [company] = await db.insert(companiesTable).values({ name: companyName, industry: industry ?? null, country: country ?? null, plan: "free", status: "active" }).returning();
    // Create subscription
    await db.insert(subscriptionsTable).values({ companyId: company.id, plan: "free", status: "active", scansUsed: 0, scansLimit: 50, usersLimit: 1 });
    // Create user
    const passwordHash = hashPassword(password);
    const [user] = await db.insert(usersTable).values({ email, passwordHash, name, role: "company_admin", companyId: company.id, isActive: true }).returning();
    // Log activity
    await db.insert(activityLogsTable).values({ type: "company_created", description: `New company registered: ${companyName}`, companyId: company.id, companyName, userId: user.id, userName: name });
    const token = signToken({ id: user.id, email: user.email, role: user.role, companyId: user.companyId });
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, companyId: user.companyId, companyName: company.name, avatarUrl: null, isActive: user.isActive, createdAt: user.createdAt },
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
    res.json({ id: user.id, email: user.email, name: user.name, role: user.role, companyId: user.companyId, companyName: company?.name ?? null, avatarUrl: user.avatarUrl, isActive: user.isActive, createdAt: user.createdAt });
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
