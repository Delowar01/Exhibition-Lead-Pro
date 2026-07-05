import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as repo from "../repositories/pipeline_stages.repository.js";

function slugify(s: string): string {
  const out = s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return out || "stage";
}

// Lazily seed the six default stages the first time a company touches the
// pipeline. Idempotent: only inserts when the company has none.
export async function ensureStages(companyId: number): Promise<void> {
  const n = await repo.countForCompany(companyId);
  if (n > 0) return;
  await repo.insertMany(
    repo.DEFAULT_STAGES.map((s) => ({
      companyId,
      name: s.name,
      key: s.key,
      sortOrder: s.sortOrder,
      isWon: s.isWon,
      isLost: s.isLost,
      isDefault: true,
      color: s.color,
    })),
  );
}

function format(s: repo.PipelineStageRow, leadCount?: number) {
  return {
    id: s.id,
    companyId: s.companyId,
    name: s.name,
    key: s.key,
    sortOrder: s.sortOrder,
    isWon: s.isWon,
    isLost: s.isLost,
    isDefault: s.isDefault,
    color: s.color ?? null,
    leadCount: leadCount ?? 0,
    createdAt: s.createdAt.toISOString(),
  };
}

export async function listStages(user: AuthUser) {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  await ensureStages(companyId);
  const [rows, counts] = await Promise.all([repo.listForCompany(user), repo.leadCountsByStageId(companyId)]);
  return { stages: rows.map((s) => format(s, counts.get(s.id) ?? 0)) };
}

interface StageInput {
  name?: string;
  key?: string | null;
  color?: string | null;
  isWon?: boolean;
  isLost?: boolean;
  sortOrder?: number | null;
}

export async function createStage(user: AuthUser, input: StageInput) {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  await ensureStages(companyId);
  const name = (input.name ?? "").trim();
  if (!name) throw new AppError(400, "name required");
  const key = slugify(input.key ? String(input.key) : name);
  if (await repo.findByKey(companyId, key)) throw new AppError(409, "A stage with this key already exists");
  if (await repo.findByNameActive(companyId, name)) throw new AppError(409, "A stage with this name already exists");
  const sortOrder = input.sortOrder != null ? input.sortOrder : (await repo.maxSortOrder(companyId)) + 1;
  const row = await repo.insert({
    companyId,
    name,
    key,
    sortOrder,
    isWon: input.isWon ?? false,
    isLost: input.isLost ?? false,
    isDefault: false,
    color: input.color ?? null,
  });
  return format(row, 0);
}

export async function updateStage(user: AuthUser, id: number, input: StageInput) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Stage not found");
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new AppError(400, "name cannot be empty");
    const dup = await repo.findByNameActive(existing.companyId, name);
    if (dup && dup.id !== id) throw new AppError(409, "A stage with this name already exists");
    data.name = name;
  }
  if (input.color !== undefined) data.color = input.color;
  if (input.isWon !== undefined) data.isWon = input.isWon;
  if (input.isLost !== undefined) data.isLost = input.isLost;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (Object.keys(data).length === 0) throw new AppError(400, "No valid fields to update");
  const row = await repo.update(id, data);
  if (!row) throw new AppError(404, "Stage not found");
  return format(row);
}

export async function reorderStages(user: AuthUser, input: { order?: Array<{ id: number; sortOrder: number }> }) {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const order = input.order ?? [];
  for (const o of order) {
    const s = await repo.findById(user, o.id);
    if (!s) throw new AppError(400, `Invalid stage id: ${o.id}`);
  }
  await repo.reorder(companyId, order.map((o) => ({ id: o.id, sortOrder: o.sortOrder })));
  return await listStages(user);
}

export async function deleteStage(user: AuthUser, id: number) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Stage not found");
  await repo.softDelete(existing.companyId, id);
  return { success: true, message: "Stage deleted" };
}
