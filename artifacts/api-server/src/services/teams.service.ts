import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as teamsRepo from "../repositories/teams.repository.js";
import * as deptRepo from "../repositories/departments.repository.js";
import * as usersRepo from "../repositories/users.repository.js";
import { enrichUsers } from "./users.service.js";
import { refAccessible } from "../lib/tenant.js";
import { parseListQuery } from "../lib/list-query.js";

const STATUSES = ["active", "archived"] as const;

async function enrich(t: teamsRepo.TeamRow) {
  const memberCount = await teamsRepo.memberCount(t.id);
  const departmentName = t.departmentId ? await deptRepo.nameById(t.departmentId) : null;
  const leaderName = t.leaderId ? await usersRepo.nameById(t.leaderId) : null;
  return {
    id: t.id,
    companyId: t.companyId,
    name: t.name,
    description: t.description,
    departmentId: t.departmentId,
    departmentName,
    leaderId: t.leaderId,
    leaderName,
    status: t.status,
    memberCount,
    createdAt: t.createdAt,
  };
}

export interface ListTeamsParams {
  search?: string;
  status?: string;
  departmentId?: string;
  page?: string;
  limit?: string;
}

export async function listTeams(user: AuthUser, params: ListTeamsParams) {
  const { search, page: pageNum, limit: limitNum, offset } = parseListQuery(params, { defaultPageSize: 50, maxPageSize: 200 });
  const departmentId = params.departmentId && !isNaN(parseInt(params.departmentId)) ? parseInt(params.departmentId) : undefined;
  const { rows, total } = await teamsRepo.list(user, { search, status: params.status, departmentId, limit: limitNum, offset });
  const teams = await Promise.all(rows.map(enrich));
  return { teams, total, page: pageNum, limit: limitNum };
}

export async function getTeam(user: AuthUser, id: number) {
  const t = await teamsRepo.findById(user, id);
  if (!t) throw new AppError(404, "Team not found");
  return enrich(t);
}

export interface TeamInput {
  name?: string;
  description?: string | null;
  departmentId?: number | null;
  leaderId?: number | null;
  status?: string;
}

export async function createTeam(user: AuthUser, input: TeamInput) {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const { name, description, departmentId, leaderId, status } = input;
  if (!name || !name.trim()) throw new AppError(400, "name required");
  if (status !== undefined && !STATUSES.includes(status as (typeof STATUSES)[number])) throw new AppError(400, "Invalid status");
  if (!(await refAccessible(user, "departments", departmentId))) throw new AppError(400, "Invalid departmentId");
  if (!(await refAccessible(user, "users", leaderId))) throw new AppError(400, "Invalid leaderId");
  const t = await teamsRepo.insert({
    companyId,
    name: name.trim(),
    description: description ?? null,
    departmentId: departmentId ?? null,
    leaderId: leaderId ?? null,
    status: status ?? "active",
    createdById: user.id,
  });
  return enrich(t);
}

export async function updateTeam(user: AuthUser, id: number, input: TeamInput) {
  const existing = await teamsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Team not found");
  const { name, description, departmentId, leaderId, status } = input;
  if (status !== undefined && !STATUSES.includes(status as (typeof STATUSES)[number])) throw new AppError(400, "Invalid status");
  if (departmentId !== undefined && !(await refAccessible(user, "departments", departmentId))) throw new AppError(400, "Invalid departmentId");
  if (leaderId !== undefined && !(await refAccessible(user, "users", leaderId))) throw new AppError(400, "Invalid leaderId");
  const patch: Record<string, unknown> = {};
  if (name !== undefined) {
    if (!name.trim()) throw new AppError(400, "name cannot be empty");
    patch.name = name.trim();
  }
  if (description !== undefined) patch.description = description;
  if (departmentId !== undefined) patch.departmentId = departmentId;
  if (leaderId !== undefined) patch.leaderId = leaderId;
  if (status !== undefined) patch.status = status;
  if (Object.keys(patch).length === 0) throw new AppError(400, "No valid fields to update");
  patch.updatedAt = new Date();
  const t = await teamsRepo.update(id, patch);
  if (!t) throw new AppError(404, "Team not found");
  return enrich(t);
}

export async function deleteTeam(user: AuthUser, id: number) {
  const existing = await teamsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Team not found");
  await teamsRepo.softDelete(id);
  return { success: true, message: "Team deleted" };
}

export async function archiveTeam(user: AuthUser, id: number) {
  const existing = await teamsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Team not found");
  const t = await teamsRepo.update(id, { status: "archived", updatedAt: new Date() });
  if (!t) throw new AppError(404, "Team not found");
  return enrich(t);
}

export async function restoreTeam(user: AuthUser, id: number) {
  const existing = await teamsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Team not found");
  const t = await teamsRepo.update(id, { status: "active", updatedAt: new Date() });
  if (!t) throw new AppError(404, "Team not found");
  return enrich(t);
}

export async function listTeamMembers(user: AuthUser, id: number) {
  const team = await teamsRepo.findById(user, id);
  if (!team) throw new AppError(404, "Team not found");
  const rows = await teamsRepo.members(user, id);
  const users = await enrichUsers(rows);
  return { users, total: users.length, page: 1, limit: users.length };
}

export async function assignTeamMembers(user: AuthUser, id: number, userIds: number[]) {
  const team = await teamsRepo.findById(user, id);
  if (!team) throw new AppError(404, "Team not found");
  const ids = Array.from(new Set(userIds.filter((n) => Number.isInteger(n))));
  for (const uid of ids) {
    if (!(await refAccessible(user, "users", uid))) throw new AppError(400, `Invalid userId ${uid}`);
  }
  const assigned = await teamsRepo.assignMembers(id, ids);
  return { success: true, assigned };
}
