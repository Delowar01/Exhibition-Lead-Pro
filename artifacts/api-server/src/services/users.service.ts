import { usersTable } from "@workspace/db";
import { normalizeRole, type AuthUser } from "../middlewares/requireAuth.js";
import { AppError } from "../middlewares/errorHandler.js";
import { hashPassword } from "../lib/auth.js";
import { revokeOtherSessions } from "../lib/sessions.js";
import * as usersRepo from "../repositories/users.repository.js";
import * as rbacRepo from "../repositories/rbac.repository.js";
import * as securityRepo from "../repositories/security.repository.js";
import * as deptRepo from "../repositories/departments.repository.js";
import * as teamsRepo from "../repositories/teams.repository.js";
import { refInCompany } from "../lib/tenant.js";
import { parseListQuery } from "../lib/list-query.js";

type UserRow = typeof usersTable.$inferSelect;

// Role ranks for escalation checks: a caller may never create or promote a user
// to a role higher than their own.
const ROLE_RANK: Record<string, number> = { employee: 1, admin: 2, primary_admin: 3, platform_owner: 4 };
const roleRank = (r: string): number => ROLE_RANK[r] ?? 0;

const EMPLOYMENT_STATUSES = ["active", "probation", "on_leave", "suspended", "offboarded"];

function formatUser(user: UserRow, companyName?: string | null) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: normalizeRole(user.role),
    companyId: user.companyId,
    companyName: companyName ?? null,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    isActive: user.isActive,
    employeeId: user.employeeId,
    jobTitle: user.jobTitle,
    employmentStatus: user.employmentStatus,
    joiningDate: user.joiningDate,
    managerId: user.managerId,
    departmentId: user.departmentId,
    teamId: user.teamId,
    createdAt: user.createdAt,
  };
}

// Batch-enriches a set of user rows with company/manager/department/team names
// for directory + team-member listings. One query per reference table.
export async function enrichUsers(rows: UserRow[]) {
  const uniq = (xs: Array<number | null>) => Array.from(new Set(xs.filter((x): x is number => x != null)));
  const [companyMap, deptMap, teamMap, mgrMap] = await Promise.all([
    usersRepo.companyNamesByIds(uniq(rows.map((r) => r.companyId))),
    deptRepo.namesByIds(uniq(rows.map((r) => r.departmentId))),
    teamsRepo.namesByIds(uniq(rows.map((r) => r.teamId))),
    usersRepo.userNamesByIds(uniq(rows.map((r) => r.managerId))),
  ]);
  return rows.map((r) => ({
    ...formatUser(r, r.companyId != null ? companyMap.get(r.companyId) ?? null : null),
    managerName: r.managerId != null ? mgrMap.get(r.managerId) ?? null : null,
    departmentName: r.departmentId != null ? deptMap.get(r.departmentId) ?? null : null,
    teamName: r.teamId != null ? teamMap.get(r.teamId) ?? null : null,
  }));
}

export interface ListUsersParams {
  search?: string;
  role?: string;
  companyId?: string;
  page?: string;
  limit?: string;
}

export async function listUsers(user: AuthUser, params: ListUsersParams) {
  const { role, companyId } = params;
  const { search, page: pageNum, limit: limitNum, offset } = parseListQuery(params, { defaultPageSize: 20, maxPageSize: 100 });

  const { rows, total } = await usersRepo.list(user, { search, role, companyId, limit: limitNum, offset });

  const enriched = await Promise.all(rows.map(async (u) => {
    const name = u.companyId ? await usersRepo.companyName(u.companyId) : null;
    return formatUser(u, name);
  }));

  return { users: enriched, total, page: pageNum, limit: limitNum };
}

export interface OrgProfileInput {
  employeeId?: string | null;
  jobTitle?: string | null;
  employmentStatus?: string;
  joiningDate?: string | null;
  managerId?: number | null;
  departmentId?: number | null;
  teamId?: number | null;
}

// Validates the org-profile FK refs + employmentStatus enum for a create/update.
// `selfId` (on update) blocks a user from becoming their own manager.
async function validateOrgProfile(user: AuthUser, cid: number | null, input: OrgProfileInput, selfId?: number) {
  if (input.employmentStatus !== undefined && !EMPLOYMENT_STATUSES.includes(input.employmentStatus)) {
    throw new AppError(400, "Invalid employmentStatus");
  }
  if (input.managerId !== undefined && input.managerId !== null) {
    if (selfId != null && input.managerId === selfId) throw new AppError(400, "A user cannot be their own manager");
    if (!(await refInCompany("users", cid, input.managerId))) throw new AppError(400, "Invalid managerId");
  }
  if (input.departmentId !== undefined && input.departmentId !== null && !(await refInCompany("departments", cid, input.departmentId))) {
    throw new AppError(400, "Invalid departmentId");
  }
  if (input.teamId !== undefined && input.teamId !== null && !(await refInCompany("teams", cid, input.teamId))) {
    throw new AppError(400, "Invalid teamId");
  }
  if (input.employeeId !== undefined && input.employeeId !== null && input.employeeId.trim() !== "") {
    if (await usersRepo.employeeIdExists(cid, input.employeeId.trim(), selfId)) {
      throw new AppError(400, "employeeId already in use");
    }
  }
}

// Builds the org-profile slice of an insert/update patch from validated input.
function orgProfilePatch(input: OrgProfileInput): Partial<typeof usersTable.$inferInsert> {
  const patch: Partial<typeof usersTable.$inferInsert> = {};
  if (input.employeeId !== undefined) patch.employeeId = input.employeeId ? input.employeeId.trim() : null;
  if (input.jobTitle !== undefined) patch.jobTitle = input.jobTitle;
  if (input.employmentStatus !== undefined) patch.employmentStatus = input.employmentStatus;
  if (input.joiningDate !== undefined) patch.joiningDate = input.joiningDate;
  if (input.managerId !== undefined) patch.managerId = input.managerId;
  if (input.departmentId !== undefined) patch.departmentId = input.departmentId;
  if (input.teamId !== undefined) patch.teamId = input.teamId;
  return patch;
}

export interface CreateUserInput extends OrgProfileInput {
  email?: string;
  name?: string;
  role?: string;
  companyId?: number | null;
  password?: string;
  phone?: string | null;
}

export async function createUser(user: AuthUser, input: CreateUserInput) {
  const { email, name, role, companyId, password, phone } = input;
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
  await validateOrgProfile(user, cid, input);
  const pw = password ?? "Welcome123!";
  const passwordHash = hashPassword(pw);
  const created = await usersRepo.insert({
    email,
    passwordHash,
    name,
    role,
    companyId: cid,
    isActive: true,
    ...(phone !== undefined ? { phone } : {}),
    ...orgProfilePatch(input),
  });
  const name2 = cid ? await usersRepo.companyName(cid) : null;
  return formatUser(created, name2);
}

export interface UpdateMeInput {
  name?: string;
  avatarUrl?: string | null;
  phone?: string | null;
  language?: string;
  timezone?: string | null;
}

export async function updateMe(user: AuthUser, input: UpdateMeInput) {
  const id = user.id;
  const { name, avatarUrl, phone, language, timezone } = input;
  const patch: Partial<typeof usersTable.$inferInsert> = {};
  if (typeof name === "string" && name.trim().length > 0) patch.name = name.trim();
  if (avatarUrl === null || typeof avatarUrl === "string") patch.avatarUrl = avatarUrl;
  if (phone === null || typeof phone === "string") patch.phone = phone;
  if (typeof language === "string" && language.trim().length > 0) patch.language = language.trim();
  if (timezone === null || typeof timezone === "string") patch.timezone = timezone;
  if (Object.keys(patch).length === 0) throw new AppError(400, "Nothing to update");
  patch.updatedAt = new Date();
  const updated = await usersRepo.update(id, patch);
  if (!updated) throw new AppError(404, "User not found");
  const companyName = updated.companyId ? await usersRepo.companyName(updated.companyId) : null;
  return formatUser(updated, companyName);
}

export async function getUser(user: AuthUser, id: number) {
  const found = await usersRepo.findById(user, id);
  if (!found) throw new AppError(404, "User not found");
  const companyName = found.companyId ? await usersRepo.companyName(found.companyId) : null;
  const roles = await rbacRepo.rolesForUser(found.id);
  const [departmentName, teamName, managerName] = await Promise.all([
    found.departmentId ? deptRepo.nameById(found.departmentId) : Promise.resolve(null),
    found.teamId ? teamsRepo.nameById(found.teamId) : Promise.resolve(null),
    found.managerId ? usersRepo.nameById(found.managerId) : Promise.resolve(null),
  ]);
  return {
    ...formatUser(found, companyName),
    language: found.language,
    timezone: found.timezone,
    departmentName,
    teamName,
    managerName,
    permissions: found.permissions ?? {},
    roleIds: roles.map((r) => r.id),
    roles: roles.map((r) => ({ id: r.id, name: r.name })),
  };
}

export interface UpdateUserInput extends OrgProfileInput {
  name?: string;
  role?: string;
  isActive?: boolean;
  phone?: string | null;
}

export async function updateUser(user: AuthUser, id: number, input: UpdateUserInput) {
  const target = await usersRepo.findById(user, id);
  if (!target) throw new AppError(404, "User not found");
  const { name, role, isActive, phone } = input;
  // No privilege escalation: cannot promote a user to a role higher than your own.
  if (role !== undefined && (!ROLE_RANK[role] || roleRank(role) > roleRank(user.role))) {
    throw new AppError(403, "Cannot assign a role higher than your own");
  }
  await validateOrgProfile(user, target.companyId, input, id);
  const patch: Partial<typeof usersTable.$inferInsert> = { ...orgProfilePatch(input) };
  if (name !== undefined) patch.name = name;
  if (role !== undefined) patch.role = role;
  if (isActive !== undefined) patch.isActive = isActive;
  if (phone !== undefined) patch.phone = phone;
  if (Object.keys(patch).length === 0) throw new AppError(400, "No valid fields to update");
  patch.updatedAt = new Date();
  const updated = await usersRepo.update(id, patch);
  if (!updated) throw new AppError(404, "User not found");
  const companyName = updated.companyId ? await usersRepo.companyName(updated.companyId) : null;
  return formatUser(updated, companyName);
}

export interface DirectoryParams {
  search?: string;
  departmentId?: string;
  teamId?: string;
  managerId?: string;
  employmentStatus?: string;
  role?: string;
  sort?: string;
  order?: string;
  page?: string;
  limit?: string;
}

const toId = (s?: string) => (s && !isNaN(parseInt(s)) ? parseInt(s) : undefined);

// Tenant-scoped employee directory with org filters, sorting + name enrichment.
export async function listDirectory(user: AuthUser, params: DirectoryParams) {
  const { search, page: pageNum, limit: limitNum, offset } = parseListQuery(params, { defaultPageSize: 50, maxPageSize: 200 });
  const { rows, total } = await usersRepo.directory(user, {
    search,
    departmentId: toId(params.departmentId),
    teamId: toId(params.teamId),
    managerId: toId(params.managerId),
    employmentStatus: params.employmentStatus,
    role: params.role,
    sort: params.sort,
    order: params.order,
    limit: limitNum,
    offset,
  });
  const users = await enrichUsers(rows);
  return { users, total, page: pageNum, limit: limitNum };
}

// Builds the reporting-manager tree (roots = users with no in-tenant manager).
export async function getOrgHierarchy(user: AuthUser) {
  const rows = await usersRepo.allForHierarchy(user);
  const uniq = (xs: Array<number | null>) => Array.from(new Set(xs.filter((x): x is number => x != null)));
  const [deptMap, teamMap] = await Promise.all([
    deptRepo.namesByIds(uniq(rows.map((r) => r.departmentId))),
    teamsRepo.namesByIds(uniq(rows.map((r) => r.teamId))),
  ]);
  type Node = {
    id: number;
    name: string;
    email: string;
    role: string;
    jobTitle: string | null;
    departmentName: string | null;
    teamName: string | null;
    managerId: number | null;
    reports: Node[];
  };
  const nodes = new Map<number, Node>();
  for (const r of rows) {
    nodes.set(r.id, {
      id: r.id,
      name: r.name,
      email: r.email,
      role: normalizeRole(r.role),
      jobTitle: r.jobTitle,
      departmentName: r.departmentId != null ? deptMap.get(r.departmentId) ?? null : null,
      teamName: r.teamId != null ? teamMap.get(r.teamId) ?? null : null,
      managerId: r.managerId,
      reports: [],
    });
  }
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    if (node.managerId != null && nodes.has(node.managerId) && node.managerId !== node.id) {
      nodes.get(node.managerId)!.reports.push(node);
    } else {
      roots.push(node);
    }
  }
  return { roots, total: rows.length };
}

// Soft-delete (Phase 2.4): mark deletedAt, deactivate, and force-logout all the
// target's sessions. Non-destructive — preserves their authored records.
export async function deleteUser(user: AuthUser, id: number) {
  const target = await usersRepo.findById(user, id);
  if (!target) throw new AppError(404, "User not found");
  if (target.id === user.id) throw new AppError(400, "You cannot delete your own account");
  await usersRepo.softDelete(id);
  await revokeOtherSessions(id, -1, "user_deleted");
  await recordUserEvent(user, target, "user_deleted", `User deleted: ${target.email}`);
  return { success: true, message: "User deleted" };
}

// Enable/disable a user account. Disabling also revokes all active sessions so
// access is cut immediately (requireAuth already rejects inactive accounts).
export async function setUserActive(user: AuthUser, id: number, active: boolean) {
  const target = await usersRepo.findById(user, id);
  if (!target) throw new AppError(404, "User not found");
  if (target.id === user.id && !active) throw new AppError(400, "You cannot disable your own account");
  const updated = await usersRepo.update(id, { isActive: active, updatedAt: new Date() });
  if (!updated) throw new AppError(404, "User not found");
  if (!active) await revokeOtherSessions(id, -1, "user_disabled");
  await recordUserEvent(user, target, active ? "user_enabled" : "user_disabled", `User ${active ? "enabled" : "disabled"}: ${target.email}`);
  const companyName = updated.companyId ? await usersRepo.companyName(updated.companyId) : null;
  return formatUser(updated, companyName);
}

// Force-logout: revoke every active session for the target user.
export async function forceLogout(user: AuthUser, id: number) {
  const target = await usersRepo.findById(user, id);
  if (!target) throw new AppError(404, "User not found");
  const count = await revokeOtherSessions(id, -1, "force_logout");
  await recordUserEvent(user, target, "user_force_logout", `Forced logout: ${target.email}`);
  return { success: true, terminated: count };
}

// Password-reset trigger. Record-only for now — the actual reset email is wired
// in Phase 2.5 (Email/Notifications). Records a security event so the request is
// auditable; no token is minted here.
export async function requestPasswordReset(user: AuthUser, id: number) {
  const target = await usersRepo.findById(user, id);
  if (!target) throw new AppError(404, "User not found");
  await recordUserEvent(user, target, "password_reset_requested", `Password reset requested for: ${target.email}`);
  return { success: true, message: "Password reset requested" };
}

export async function loginHistory(user: AuthUser, id: number, limit = 50) {
  const target = await usersRepo.findById(user, id);
  if (!target) throw new AppError(404, "User not found");
  const history = await usersRepo.loginHistory(id, Math.min(200, Math.max(1, limit)));
  return { history };
}

// Assigns a set of custom/system roles to a user (replaces the existing set).
// Validates each role is assignable by the caller (own tenant or a system
// template). RBAC grants are ADDITIVE on top of the user's legacy permissions.
export async function setUserRoles(user: AuthUser, id: number, roleIds: number[]) {
  const target = await usersRepo.findById(user, id);
  if (!target) throw new AppError(404, "User not found");
  const ids = Array.from(new Set(roleIds.filter((n) => Number.isInteger(n))));
  const bad = await rbacRepo.firstInaccessibleRole(user, ids);
  if (bad !== null) throw new AppError(400, `Role ${bad} is not assignable`);

  // Anti-escalation: a caller may not grant authority they do not themselves
  // hold. platform_owner/primary_admin bypass all permission checks, so they may
  // grant anything within their accessible tenants. Everyone else can only assign
  // roles whose permissions are a subset of their own effective permissions —
  // otherwise an actor with team/roles edit could self-assign a powerful custom
  // role and escalate past the base-role rank guard.
  if (user.role !== "platform_owner" && user.role !== "primary_admin") {
    const granted = await rbacRepo.permissionsForRoles(ids);
    const held = user.permissions ?? {};
    for (const [module, actions] of Object.entries(granted)) {
      const owned = new Set(held[module] ?? []);
      for (const action of actions) {
        if (!owned.has(action)) {
          throw new AppError(403, `Cannot grant ${module}:${action} — you do not hold this permission`);
        }
      }
    }
  }

  await rbacRepo.setUserRoles(id, ids);
  await recordUserEvent(user, target, "user_roles_changed", `Roles updated for: ${target.email}`);
  return getUser(user, id);
}

async function recordUserEvent(
  actor: AuthUser,
  target: typeof usersTable.$inferSelect,
  type: string,
  description: string,
) {
  await securityRepo.insertEvent({
    companyId: target.companyId,
    userId: target.id,
    type,
    description,
    metadata: { actorId: actor.id, actorEmail: actor.email },
  });
}
