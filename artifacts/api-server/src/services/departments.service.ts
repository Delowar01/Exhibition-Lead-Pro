import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as deptRepo from "../repositories/departments.repository.js";
import * as usersRepo from "../repositories/users.repository.js";
import { refAccessible } from "../lib/tenant.js";
import { parseListQuery } from "../lib/list-query.js";

const STATUSES = ["active", "archived"] as const;

async function enrich(d: deptRepo.DepartmentRow) {
  const { employeeCount, teamCount } = await deptRepo.counts(d.id);
  const headName = d.headId ? await usersRepo.nameById(d.headId) : null;
  const parentDepartmentName = d.parentDepartmentId ? await deptRepo.nameById(d.parentDepartmentId) : null;
  return {
    id: d.id,
    companyId: d.companyId,
    name: d.name,
    description: d.description,
    headId: d.headId,
    headName,
    parentDepartmentId: d.parentDepartmentId,
    parentDepartmentName,
    status: d.status,
    employeeCount,
    teamCount,
    createdAt: d.createdAt,
  };
}

export interface ListDepartmentsParams {
  search?: string;
  status?: string;
  page?: string;
  limit?: string;
}

export async function listDepartments(user: AuthUser, params: ListDepartmentsParams) {
  const { search, page: pageNum, limit: limitNum, offset } = parseListQuery(params, { defaultPageSize: 50, maxPageSize: 200 });
  const { rows, total } = await deptRepo.list(user, { search, status: params.status, limit: limitNum, offset });
  const departments = await Promise.all(rows.map(enrich));
  return { departments, total, page: pageNum, limit: limitNum };
}

export async function getDepartment(user: AuthUser, id: number) {
  const d = await deptRepo.findById(user, id);
  if (!d) throw new AppError(404, "Department not found");
  return enrich(d);
}

export interface DepartmentInput {
  name?: string;
  description?: string | null;
  headId?: number | null;
  parentDepartmentId?: number | null;
  status?: string;
}

export async function createDepartment(user: AuthUser, input: DepartmentInput) {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const { name, description, headId, parentDepartmentId, status } = input;
  if (!name || !name.trim()) throw new AppError(400, "name required");
  if (status !== undefined && !STATUSES.includes(status as (typeof STATUSES)[number])) throw new AppError(400, "Invalid status");
  if (!(await refAccessible(user, "users", headId))) throw new AppError(400, "Invalid headId");
  if (!(await refAccessible(user, "departments", parentDepartmentId))) throw new AppError(400, "Invalid parentDepartmentId");
  const d = await deptRepo.insert({
    companyId,
    name: name.trim(),
    description: description ?? null,
    headId: headId ?? null,
    parentDepartmentId: parentDepartmentId ?? null,
    status: status ?? "active",
    createdById: user.id,
  });
  return enrich(d);
}

export async function updateDepartment(user: AuthUser, id: number, input: DepartmentInput) {
  const existing = await deptRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Department not found");
  const { name, description, headId, parentDepartmentId, status } = input;
  if (status !== undefined && !STATUSES.includes(status as (typeof STATUSES)[number])) throw new AppError(400, "Invalid status");
  if (headId !== undefined && !(await refAccessible(user, "users", headId))) throw new AppError(400, "Invalid headId");
  if (parentDepartmentId !== undefined && parentDepartmentId !== null) {
    if (parentDepartmentId === id) throw new AppError(400, "A department cannot be its own parent");
    if (!(await refAccessible(user, "departments", parentDepartmentId))) throw new AppError(400, "Invalid parentDepartmentId");
    if (await createsCycle(user, id, parentDepartmentId)) throw new AppError(400, "Circular department hierarchy");
  }
  const patch: Record<string, unknown> = {};
  if (name !== undefined) {
    if (!name.trim()) throw new AppError(400, "name cannot be empty");
    patch.name = name.trim();
  }
  if (description !== undefined) patch.description = description;
  if (headId !== undefined) patch.headId = headId;
  if (parentDepartmentId !== undefined) patch.parentDepartmentId = parentDepartmentId;
  if (status !== undefined) patch.status = status;
  if (Object.keys(patch).length === 0) throw new AppError(400, "No valid fields to update");
  patch.updatedAt = new Date();
  const d = await deptRepo.update(id, patch);
  if (!d) throw new AppError(404, "Department not found");
  return enrich(d);
}

// Walks the prospective parent chain upward; a cycle exists if we reach `id`.
async function createsCycle(user: AuthUser, id: number, parentId: number): Promise<boolean> {
  let cursor: number | null = parentId;
  for (let i = 0; i < 50 && cursor != null; i++) {
    if (cursor === id) return true;
    const parent: deptRepo.DepartmentRow | undefined = await deptRepo.findById(user, cursor);
    cursor = parent?.parentDepartmentId ?? null;
  }
  return false;
}

export async function deleteDepartment(user: AuthUser, id: number) {
  const existing = await deptRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Department not found");
  await deptRepo.softDelete(id);
  return { success: true, message: "Department deleted" };
}

export async function archiveDepartment(user: AuthUser, id: number) {
  const existing = await deptRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Department not found");
  const d = await deptRepo.update(id, { status: "archived", updatedAt: new Date() });
  if (!d) throw new AppError(404, "Department not found");
  return enrich(d);
}

export async function restoreDepartment(user: AuthUser, id: number) {
  const existing = await deptRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Department not found");
  const d = await deptRepo.update(id, { status: "active", updatedAt: new Date() });
  if (!d) throw new AppError(404, "Department not found");
  return enrich(d);
}
