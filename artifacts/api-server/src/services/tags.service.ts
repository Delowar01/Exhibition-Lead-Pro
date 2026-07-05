import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as repo from "../repositories/tags.repository.js";

export function formatTag(t: repo.TagRow) {
  return {
    id: t.id,
    companyId: t.companyId,
    name: t.name,
    color: t.color ?? null,
    category: t.category ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

export async function listTags(user: AuthUser) {
  return { tags: (await repo.listForCompany(user)).map(formatTag) };
}

interface TagInput {
  name?: string;
  color?: string | null;
  category?: string | null;
}

export async function createTag(user: AuthUser, input: TagInput) {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const name = (input.name ?? "").trim();
  if (!name) throw new AppError(400, "name required");
  if (await repo.findByNameActive(companyId, name)) throw new AppError(409, "A tag with this name already exists");
  const row = await repo.insert({ companyId, name, color: input.color ?? null, category: input.category ?? null });
  return formatTag(row);
}

export async function updateTag(user: AuthUser, id: number, input: TagInput) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Tag not found");
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new AppError(400, "name cannot be empty");
    const dup = await repo.findByNameActive(existing.companyId, name);
    if (dup && dup.id !== id) throw new AppError(409, "A tag with this name already exists");
    data.name = name;
  }
  if (input.color !== undefined) data.color = input.color;
  if (input.category !== undefined) data.category = input.category;
  if (Object.keys(data).length === 0) throw new AppError(400, "No valid fields to update");
  const row = await repo.update(id, data);
  if (!row) throw new AppError(404, "Tag not found");
  return formatTag(row);
}

export async function deleteTag(user: AuthUser, id: number) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Tag not found");
  await repo.softDelete(id);
  return { success: true, message: "Tag deleted" };
}
