import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { refInCompany } from "../lib/tenant.js";
import * as repo from "../repositories/territories.repository.js";
import type { TerritoryRow } from "../repositories/territories.repository.js";

interface MatchCriteria {
  countries?: string[];
  regions?: string[];
  industries?: string[];
  cities?: string[];
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function formatTerritory(t: TerritoryRow, assignedToName: string | null, teamName: string | null) {
  return {
    id: t.id,
    companyId: t.companyId,
    name: t.name,
    description: t.description ?? null,
    matchCriteria: parseJson<MatchCriteria>(t.matchCriteria),
    assignedToId: t.assignedToId ?? null,
    assignedToName,
    teamId: t.teamId ?? null,
    teamName,
    sortOrder: t.sortOrder,
    createdById: t.createdById ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt ? t.updatedAt.toISOString() : null,
  };
}

async function namesFor(rows: TerritoryRow[]) {
  const userIds = [...new Set(rows.map((t) => t.assignedToId).filter((v): v is number => v != null))];
  const teamIds = [...new Set(rows.map((t) => t.teamId).filter((v): v is number => v != null))];
  const [users, teams] = await Promise.all([repo.usersByIds(userIds), repo.teamsByIds(teamIds)]);
  return {
    userNameById: new Map(users.map((u) => [u.id, u.name])),
    teamNameById: new Map(teams.map((t) => [t.id, t.name])),
  };
}

function normalizeMatchCriteria(raw: unknown): MatchCriteria | null {
  if (raw == null) return null;
  if (typeof raw !== "object") throw new AppError(400, "matchCriteria must be an object");
  const v = raw as Record<string, unknown>;
  const arr = (k: string): string[] | undefined => {
    if (v[k] == null) return undefined;
    if (!Array.isArray(v[k]) || (v[k] as unknown[]).some((x) => typeof x !== "string")) {
      throw new AppError(400, `matchCriteria.${k} must be an array of strings`);
    }
    return (v[k] as string[]).map((s) => s.trim()).filter((s) => s !== "");
  };
  const out: MatchCriteria = {};
  const countries = arr("countries"); if (countries) out.countries = countries;
  const regions = arr("regions"); if (regions) out.regions = regions;
  const industries = arr("industries"); if (industries) out.industries = industries;
  const cities = arr("cities"); if (cities) out.cities = cities;
  return out;
}

export async function listTerritories(user: AuthUser) {
  const { rows, total } = await repo.list(user);
  const { userNameById, teamNameById } = await namesFor(rows);
  return {
    territories: rows.map((t) =>
      formatTerritory(
        t,
        t.assignedToId != null ? (userNameById.get(t.assignedToId) ?? null) : null,
        t.teamId != null ? (teamNameById.get(t.teamId) ?? null) : null,
      ),
    ),
    total,
  };
}

export async function getTerritory(user: AuthUser, id: number) {
  const t = await repo.findById(user, id);
  if (!t) throw new AppError(404, "Territory not found");
  const { userNameById, teamNameById } = await namesFor([t]);
  return formatTerritory(
    t,
    t.assignedToId != null ? (userNameById.get(t.assignedToId) ?? null) : null,
    t.teamId != null ? (teamNameById.get(t.teamId) ?? null) : null,
  );
}

export async function createTerritory(user: AuthUser, body: Record<string, unknown>) {
  const companyId = user.companyId ?? null;
  if (!companyId) throw new AppError(400, "No company context");

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") throw new AppError(400, "name is required");

  const assignedToId = typeof body.assignedToId === "number" ? body.assignedToId : null;
  const teamId = typeof body.teamId === "number" ? body.teamId : null;
  // Target-company-scoped FK checks: the owner/team must belong to THIS company,
  // not merely a company the caller can reach (refInCompany, not refAccessible).
  if (!(await refInCompany("users", companyId, assignedToId))) throw new AppError(400, "Invalid assignedToId");
  if (!(await refInCompany("teams", companyId, teamId))) throw new AppError(400, "Invalid teamId");

  const matchCriteria = normalizeMatchCriteria(body.matchCriteria);

  const created = await repo.insert({
    companyId,
    name,
    description: typeof body.description === "string" ? body.description : null,
    matchCriteria: matchCriteria ? JSON.stringify(matchCriteria) : null,
    assignedToId,
    teamId,
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
    createdById: user.id,
  });
  return getTerritory(user, created.id);
}

export async function updateTerritory(user: AuthUser, id: number, body: Record<string, unknown>) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Territory not found");

  const updateData: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "") throw new AppError(400, "name cannot be empty");
    updateData.name = name;
  }
  if (body.description !== undefined) updateData.description = typeof body.description === "string" ? body.description : null;
  if (body.matchCriteria !== undefined) {
    const mc = normalizeMatchCriteria(body.matchCriteria);
    updateData.matchCriteria = mc ? JSON.stringify(mc) : null;
  }
  if (body.assignedToId !== undefined) {
    const assignedToId = typeof body.assignedToId === "number" ? body.assignedToId : null;
    if (!(await refInCompany("users", existing.companyId, assignedToId))) throw new AppError(400, "Invalid assignedToId");
    updateData.assignedToId = assignedToId;
  }
  if (body.teamId !== undefined) {
    const teamId = typeof body.teamId === "number" ? body.teamId : null;
    if (!(await refInCompany("teams", existing.companyId, teamId))) throw new AppError(400, "Invalid teamId");
    updateData.teamId = teamId;
  }
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== "number") throw new AppError(400, "sortOrder must be a number");
    updateData.sortOrder = body.sortOrder;
  }

  if (Object.keys(updateData).length === 0) throw new AppError(400, "No valid fields to update");
  updateData.updatedAt = new Date();

  const updated = await repo.update(id, updateData);
  if (!updated) throw new AppError(404, "Territory not found");
  return getTerritory(user, updated.id);
}

export async function deleteTerritory(user: AuthUser, id: number) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Territory not found");
  await repo.softDelete(id);
  return { success: true, message: "Territory deleted" };
}
