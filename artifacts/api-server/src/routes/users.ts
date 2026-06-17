import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, companiesTable } from "@workspace/db";
import { eq, ilike, and, count } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/requireAuth.js";
import { hashPassword } from "../lib/auth.js";

const router = Router();
router.use(requireAuth);

function formatUser(user: typeof usersTable.$inferSelect, companyName?: string | null) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, companyId: user.companyId, companyName: companyName ?? null, avatarUrl: user.avatarUrl, isActive: user.isActive, createdAt: user.createdAt };
}

// GET /users
router.get("/users", async (req: AuthRequest, res) => {
  try {
    const { search, role, companyId, page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, parseInt(limit));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    if (search) conditions.push(ilike(usersTable.name, `%${search}%`));
    if (role) conditions.push(eq(usersTable.role, role));
    if (companyId && !isNaN(parseInt(companyId))) conditions.push(eq(usersTable.companyId, parseInt(companyId)));
    else if (req.user!.role !== "platform_owner" && req.user!.companyId) conditions.push(eq(usersTable.companyId, req.user!.companyId));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [{ total }] = await db.select({ total: count() }).from(usersTable).where(whereClause);
    const users = await db.select().from(usersTable).where(whereClause).limit(limitNum).offset(offset).orderBy(usersTable.createdAt);

    const enriched = await Promise.all(users.map(async (u) => {
      const company = u.companyId ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, u.companyId)).then(r => r[0]) : null;
      return formatUser(u, company?.name);
    }));

    res.json({ users: enriched, total, page: pageNum, limit: limitNum });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /users
router.post("/users", async (req: AuthRequest, res) => {
  try {
    const { email, name, role, companyId, password } = req.body;
    if (!email || !name || !role) { res.status(400).json({ error: "email, name, role required" }); return; }
    const pw = password ?? "Welcome123!";
    const passwordHash = hashPassword(pw);
    const cid = companyId ?? req.user!.companyId ?? null;
    const [user] = await db.insert(usersTable).values({ email, passwordHash, name, role, companyId: cid, isActive: true }).returning();
    const company = cid ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, cid)).then(r => r[0]) : null;
    res.status(201).json(formatUser(user, company?.name));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /users/:id
router.get("/users/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    const company = user.companyId ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, user.companyId)).then(r => r[0]) : null;
    res.json(formatUser(user, company?.name));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /users/:id
router.patch("/users/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, role, isActive } = req.body;
    const [user] = await db.update(usersTable).set({ name, role, isActive }).where(eq(usersTable.id, id)).returning();
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    const company = user.companyId ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, user.companyId)).then(r => r[0]) : null;
    res.json(formatUser(user, company?.name));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /users/:id
router.delete("/users/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(usersTable).where(eq(usersTable.id, id));
    res.json({ success: true, message: "User deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
