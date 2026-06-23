import { usersTable } from "@workspace/db";
import { normalizeRole, type AuthUser } from "../middlewares/requireAuth.js";
import { AppError } from "../middlewares/errorHandler.js";
import { hashPassword } from "../lib/auth.js";
import * as usersRepo from "../repositories/users.repository.js";

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

  const { rows, total } = await usersRepo.list(user, { search, role, companyId, limit: limitNum, offset });

  const enriched = await Promise.all(rows.map(async (u) => {
    const name = u.companyId ? await usersRepo.companyName(u.companyId) : null;
    return formatUser(u, name);
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
  const created = await usersRepo.insert({ email, passwordHash, name, role, companyId: cid, isActive: true });
  const name2 = cid ? await usersRepo.companyName(cid) : null;
  return formatUser(created, name2);
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
  const updated = await usersRepo.update(id, patch);
  if (!updated) throw new AppError(404, "User not found");
  const companyName = updated.companyId ? await usersRepo.companyName(updated.companyId) : null;
  return formatUser(updated, companyName);
}

export async function getUser(user: AuthUser, id: number) {
  const found = await usersRepo.findById(user, id);
  if (!found) throw new AppError(404, "User not found");
  const companyName = found.companyId ? await usersRepo.companyName(found.companyId) : null;
  return formatUser(found, companyName);
}

export interface UpdateUserInput {
  name?: string;
  role?: string;
  isActive?: boolean;
}

export async function updateUser(user: AuthUser, id: number, input: UpdateUserInput) {
  const target = await usersRepo.findById(user, id);
  if (!target) throw new AppError(404, "User not found");
  const { name, role, isActive } = input;
  // No privilege escalation: cannot promote a user to a role higher than your own.
  if (role !== undefined && (!ROLE_RANK[role] || roleRank(role) > roleRank(user.role))) {
    throw new AppError(403, "Cannot assign a role higher than your own");
  }
  const updated = await usersRepo.update(id, { name, role, isActive });
  if (!updated) throw new AppError(404, "User not found");
  const companyName = updated.companyId ? await usersRepo.companyName(updated.companyId) : null;
  return formatUser(updated, companyName);
}

export async function deleteUser(user: AuthUser, id: number) {
  const target = await usersRepo.findById(user, id);
  if (!target) throw new AppError(404, "User not found");
  await usersRepo.remove(id);
  return { success: true, message: "User deleted" };
}
