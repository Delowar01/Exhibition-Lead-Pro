import { db } from "@workspace/db";
import { usersTable, companiesTable } from "@workspace/db";
import { eq, ilike, and, count, inArray } from "drizzle-orm";
import { canAccessCompany, normalizeRole, type AuthUser } from "../middlewares/requireAuth.js";
import { AppError } from "../middlewares/errorHandler.js";
import { hashPassword } from "../lib/auth.js";

// Role ranks for escalation checks: a caller may never create or promote a user
// to a role higher than their own.
const ROLE_RANK: Record<string, number> = { employee: 1, admin: 2, primary_admin: 3, platform_owner: 4 };
const roleRank = (r: string): number => ROLE_RANK[r] ?? 0;

function formatUser(user: typeof usersTable.$inferSelect, companyName?: string | null) {
  return { id: user.id, email: user.email, name: user.name, role: normalizeRole(user.role), companyId: user.companyId, companyName: companyName ?? null, avatarUrl: user.avatarUrl, isActive: user.isActive, createdAt: user.createdAt };
}

export interface ListUsersParams {
  search?: string;
  role?: string;
  companyId?: string;
  page?: string;
  limit?: string;
}

export async function listUsers(user: AuthUser, params: ListUsersParams) {
  const { search, role, companyId, page = "1", limit = "20" } = params;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (search) conditions.push(ilike(usersTable.name, `%${search}%`));
  if (role) conditions.push(eq(usersTable.role, role));
  // Only platform_owner may filter by an arbitrary companyId; everyone else is
  // hard-scoped to their own company regardless of any caller-supplied companyId.
  if (user.role === "platform_owner") {
    if (companyId && !isNaN(parseInt(companyId))) conditions.push(eq(usersTable.companyId, parseInt(companyId)));
  } else {
    conditions.push(inArray(usersTable.companyId, user.accessibleCompanies));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [{ total }] = await db.select({ total: count() }).from(usersTable).where(whereClause);
  const users = await db.select().from(usersTable).where(whereClause).limit(limitNum).offset(offset).orderBy(usersTable.createdAt);

  const enriched = await Promise.all(users.map(async (u) => {
    const company = u.companyId ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, u.companyId)).then(r => r[0]) : null;
    return formatUser(u, company?.name);
  }));

  return { users: enriched, total, page: pageNum, limit: limitNum };
}

export interface CreateUserInput {
  email?: string;
  name?: string;
  role?: string;
  companyId?: number | null;
  password?: string;
}

export async function createUser(user: AuthUser, input: CreateUserInput) {
  const { email, name, role, companyId, password } = input;
  if (!email || !name || !role) throw new AppError(400, "email, name, role required");
  if (!ROLE_RANK[role]) throw new AppError(400, "Invalid role");
  // No privilege escalation: a caller may not create a user with a role higher than their own.
  if (roleRank(role) > roleRank(user.role)) {
    throw new AppError(403, "Cannot assign a role higher than your own");
  }
  // Non-platform admins can only create users within their own company.
  const isPlatform = user.role === "platform_owner";
  const cid = isPlatform ? (companyId ?? user.companyId ?? null) : user.companyId ?? null;
  if (!isPlatform && companyId != null && companyId !== user.companyId) {
    throw new AppError(403, "Forbidden");
  }
  // Tenant invariant: only platform_owner accounts may be company-less.
  if (role !== "platform_owner" && cid == null) {
    throw new AppError(400, "companyId is required for non-platform roles");
  }
  const pw = password ?? "Welcome123!";
  const passwordHash = hashPassword(pw);
  const [created] = await db.insert(usersTable).values({ email, passwordHash, name, role, companyId: cid, isActive: true }).returning();
  const company = cid ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, cid)).then(r => r[0]) : null;
  return formatUser(created, company?.name);
}

export interface UpdateMeInput {
  name?: string;
  avatarUrl?: string | null;
}

export async function updateMe(user: AuthUser, input: UpdateMeInput) {
  const id = user.id;
  const { name, avatarUrl } = input;
  const patch: { name?: string; avatarUrl?: string | null } = {};
  if (typeof name === "string" && name.trim().length > 0) patch.name = name.trim();
  if (avatarUrl === null || typeof avatarUrl === "string") patch.avatarUrl = avatarUrl;
  if (Object.keys(patch).length === 0) throw new AppError(400, "Nothing to update");
  const [updated] = await db.update(usersTable).set(patch).where(eq(usersTable.id, id)).returning();
  if (!updated) throw new AppError(404, "User not found");
  const company = updated.companyId ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, updated.companyId)).then(r => r[0]) : null;
  return formatUser(updated, company?.name);
}

export async function getUser(user: AuthUser, id: number) {
  const [found] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!found || !canAccessCompany(user, found.companyId)) throw new AppError(404, "User not found");
  const company = found.companyId ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, found.companyId)).then(r => r[0]) : null;
  return formatUser(found, company?.name);
}

export interface UpdateUserInput {
  name?: string;
  role?: string;
  isActive?: boolean;
}

export async function updateUser(user: AuthUser, id: number, input: UpdateUserInput) {
  const [target] = await db.select({ companyId: usersTable.companyId }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!target || !canAccessCompany(user, target.companyId)) throw new AppError(404, "User not found");
  const { name, role, isActive } = input;
  // No privilege escalation: cannot promote a user to a role higher than your own.
  if (role !== undefined && (!ROLE_RANK[role] || roleRank(role) > roleRank(user.role))) {
    throw new AppError(403, "Cannot assign a role higher than your own");
  }
  const [updated] = await db.update(usersTable).set({ name, role, isActive }).where(eq(usersTable.id, id)).returning();
  if (!updated) throw new AppError(404, "User not found");
  const company = updated.companyId ? await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, updated.companyId)).then(r => r[0]) : null;
  return formatUser(updated, company?.name);
}

export async function deleteUser(user: AuthUser, id: number) {
  const [target] = await db.select({ companyId: usersTable.companyId }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!target || !canAccessCompany(user, target.companyId)) throw new AppError(404, "User not found");
  await db.delete(usersTable).where(eq(usersTable.id, id));
  return { success: true, message: "User deleted" };
}
