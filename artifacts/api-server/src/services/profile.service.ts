import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { normalizeRole } from "../middlewares/requireAuth.js";
import { listActiveSessions } from "../lib/sessions.js";
import * as authRepo from "../repositories/auth.repository.js";
import * as usersRepo from "../repositories/users.repository.js";
import * as rbacRepo from "../repositories/rbac.repository.js";

// Self-service profile: the authenticated user reading/updating their own record.
export async function getProfile(user: AuthUser) {
  const row = await authRepo.findUserById(user.id);
  if (!row) throw new AppError(404, "User not found");
  const companyName = row.companyId ? await usersRepo.companyName(row.companyId) : null;
  const roles = await rbacRepo.rolesForUser(row.id);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    role: normalizeRole(row.role),
    companyId: row.companyId,
    companyName: companyName ?? null,
    avatarUrl: row.avatarUrl,
    language: row.language,
    timezone: row.timezone,
    mfaEnabled: row.mfaEnabled,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    roles: roles.map((r) => ({ id: r.id, name: r.name })),
  };
}

export interface ProfileInput {
  name?: string;
  phone?: string | null;
  avatarUrl?: string | null;
  language?: string;
  timezone?: string | null;
}

export async function updateProfile(user: AuthUser, input: ProfileInput) {
  const patch: Record<string, unknown> = {};
  if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim();
  if (input.phone === null || typeof input.phone === "string") patch.phone = input.phone;
  if (input.avatarUrl === null || typeof input.avatarUrl === "string") patch.avatarUrl = input.avatarUrl;
  if (typeof input.language === "string" && input.language.trim()) patch.language = input.language.trim();
  if (input.timezone === null || typeof input.timezone === "string") patch.timezone = input.timezone;
  if (Object.keys(patch).length === 0) throw new AppError(400, "Nothing to update");
  patch.updatedAt = new Date();
  await usersRepo.update(user.id, patch);
  return getProfile(user);
}

// Account activity for the profile page: active sessions, login history, and
// trusted devices — all derived from real data, no fabrication.
export async function getActivity(user: AuthUser, sessionId: number | null) {
  const [sessions, history, devices] = await Promise.all([
    listActiveSessions(user.id, sessionId),
    usersRepo.loginHistory(user.id, 50),
    usersRepo.trustedDevices(user.id),
  ]);
  return { sessions, loginHistory: history, devices };
}
