import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, companiesTable } from "@workspace/db";
import { eq, ilike, and, count, inArray } from "drizzle-orm";
import { requireAuth, blockReadOnlyMutations, requirePermission, canAccessCompany, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { hashPassword } from "../lib/auth.js";

// Role ranks for escalation checks: a caller may never create or promote a user
// to a role higher than their own.
const ROLE_RANK: Record<string, number> = { employee: 1, admin: 2, primary_admin: 3, platform_owner: 4 };
const roleRank = (r: string): number => ROLE_RANK[r] ?? 0;

const router = Router();
router.use(requireAuth);
router.use("/users", blockReadOnlyMutations);
router.use("/users", auditMutations("team"));

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
    // Only platform_owner may filter by an arbitrary companyId; everyone else is
    // hard-scoped to their own company regardless of any caller-supplied companyId.
    if (req.user!.role === "platform_owner") {
      if (companyId && !isNaN(parseInt(companyId))) conditions.push(eq(usersTable.companyId, parseInt(companyId)));
    } else {
      conditions.push(inArray(usersTable.companyId, req.user!.accessibleCompanies));
    }

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
router.post("/users", requirePermission("team", "create"), async (req: AuthRequest, res) => {
  try {
    const { email, name, role, companyId, password } = req.body;
    if (!email || !name || !role) { res.status(400).json({ error: "email, name, role required" }); return; }
    if (!ROLE_RANK[role]) { res.status(400).json({ error: "Invalid role" }); return; }
    // No privilege escalation: a caller may not create a user with a role higher than their own.
    if (roleRank(role) > roleRank(req.user!.role)) {
      res.status(403).json({ error: "Cannot assign a role higher than your own" }); return;
    }
    // Non-platform admins can only create users within their own company.
    const isPlatform = req.user!.role === "platform_owner";
    const cid = isPlatform ? (companyId ?? req.user!.companyId ?? null) : req.user!.companyId ?? null;
    if (!isPlatform && companyId != null && companyId !== req.user!.companyId) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    // Tenant invariant: only platform_owner accounts may be company-less.
    if (role !== "platform_owner" && cid == null) {
      res.status(400).json({ error: "companyId is required for non-platform roles" }); return;
    }
    const pw = password ?? "Welcome123!";
    const passwordHash = hashPassword(pw);
    const [user] = await db.insert(usersTable).values({ email, passwordHash, name, role, companyId: cid, isActive: true }).returning();
    const company = cid ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, cid)).then(r => r[0]) : null;
    res.status(201).json(formatUser(user, company?.name));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /users/me — authenticated user updates their OWN profile (avatar, name).
// Registered before /users/:id so the static "me" path is not swallowed by :id.
router.patch("/users/me", async (req: AuthRequest, res) => {
  try {
    const id = req.user!.id;
    const { name, avatarUrl } = req.body as { name?: string; avatarUrl?: string | null };
    const patch: { name?: string; avatarUrl?: string | null } = {};
    if (typeof name === "string" && name.trim().length > 0) patch.name = name.trim();
    if (avatarUrl === null || typeof avatarUrl === "string") patch.avatarUrl = avatarUrl;
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: "Nothing to update" }); return; }
    const [user] = await db.update(usersTable).set(patch).where(eq(usersTable.id, id)).returning();
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    const company = user.companyId ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, user.companyId)).then(r => r[0]) : null;
    res.json(formatUser(user, company?.name));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /users/:id
router.get("/users/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!user || !canAccessCompany(req.user, user.companyId)) { res.status(404).json({ error: "User not found" }); return; }
    const company = user.companyId ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, user.companyId)).then(r => r[0]) : null;
    res.json(formatUser(user, company?.name));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /users/:id
router.patch("/users/:id", requirePermission("team", "edit"), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [target] = await db.select({ companyId: usersTable.companyId }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!target || !canAccessCompany(req.user, target.companyId)) { res.status(404).json({ error: "User not found" }); return; }
    const { name, role, isActive } = req.body;
    // No privilege escalation: cannot promote a user to a role higher than your own.
    if (role !== undefined && (!ROLE_RANK[role] || roleRank(role) > roleRank(req.user!.role))) {
      res.status(403).json({ error: "Cannot assign a role higher than your own" }); return;
    }
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
router.delete("/users/:id", requirePermission("team", "delete"), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [target] = await db.select({ companyId: usersTable.companyId }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!target || !canAccessCompany(req.user, target.companyId)) { res.status(404).json({ error: "User not found" }); return; }
    await db.delete(usersTable).where(eq(usersTable.id, id));
    res.json({ success: true, message: "User deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
