import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as searchRepo from "../repositories/search.repository.js";
import * as savedRepo from "../repositories/saved_searches.repository.js";
import * as recentRepo from "../repositories/recent_searches.repository.js";
import { enrichContactRows } from "./contacts.service.js";

const MAX_CONDITIONS = 20;
const RECENT_KEEP = 15;
const RECENT_LIMIT = 15;

function validateQuery(raw: unknown): searchRepo.SearchQuery & { conditions: searchRepo.SearchCondition[] } {
  const q = (raw ?? {}) as Record<string, unknown>;
  const combinator = q.combinator === "OR" ? "OR" : "AND";
  const rawConditions = Array.isArray(q.conditions) ? q.conditions : [];
  if (rawConditions.length > MAX_CONDITIONS) throw new AppError(400, `A search may have at most ${MAX_CONDITIONS} conditions`);
  const conditions: searchRepo.SearchCondition[] = [];
  for (const c of rawConditions as Record<string, unknown>[]) {
    const field = String(c.field ?? "");
    const operator = String(c.operator ?? "");
    if (!searchRepo.SEARCH_FIELDS.includes(field)) throw new AppError(400, `Unknown search field: ${field}`);
    const validOps = searchRepo.TEXT_OPERATORS.concat(searchRepo.INT_OPERATORS);
    if (!validOps.includes(operator)) throw new AppError(400, `Unknown operator: ${operator}`);
    conditions.push({ field, operator, value: (c.value as string | number | null) ?? null });
  }
  const page = Math.max(1, parseInt(String(q.page ?? "1"), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(q.limit ?? "20"), 10) || 20));
  const sort = typeof q.sort === "string" ? q.sort : undefined;
  return { combinator, conditions, sort, limit, offset: (page - 1) * limit };
}

// Human-readable one-line summary of a query for the recent-searches list.
function summarize(query: searchRepo.SearchQuery): string {
  if (query.conditions.length === 0) return "All contacts";
  const parts = query.conditions.map((c) => {
    const v = c.value === null || c.value === undefined || c.value === "" ? "" : ` "${c.value}"`;
    return `${c.field} ${c.operator}${v}`;
  });
  return parts.join(` ${query.combinator} `);
}

export async function searchContacts(user: AuthUser, rawQuery: unknown, opts: { recordRecent?: boolean } = {}) {
  const query = validateQuery(rawQuery);
  const page = Math.floor(query.offset / query.limit) + 1;
  const { rows, total } = await searchRepo.searchContacts(user, query);
  const contacts = await enrichContactRows(rows);

  // Record the executed search (page 1 only, and only when there is something to
  // remember) so the recent list stays meaningful.
  if (opts.recordRecent !== false && page === 1 && query.conditions.length > 0 && user.companyId != null) {
    try {
      await recentRepo.insert({
        companyId: user.companyId,
        userId: user.id,
        entityType: "contacts",
        label: summarize(query).slice(0, 240),
        payload: { combinator: query.combinator, conditions: query.conditions, sort: query.sort },
      });
      await recentRepo.prune(user, "contacts", RECENT_KEEP);
    } catch {
      // recent-search bookkeeping is best-effort; never fail the search on it
    }
  }

  return { contacts, total, page, limit: query.limit };
}

// ── Saved searches (filters + views) ──────────────────────────────────────

function formatSaved(s: savedRepo.SavedSearchRow) {
  return {
    id: s.id,
    entityType: s.entityType,
    kind: s.kind,
    name: s.name,
    payload: s.payload,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export async function listSaved(user: AuthUser, opts: { entityType?: string; kind?: string }) {
  return { savedSearches: (await savedRepo.listForUser(user, opts)).map(formatSaved) };
}

export async function createSaved(user: AuthUser, input: { name?: string; kind?: string; entityType?: string; payload?: unknown }) {
  const name = (input.name ?? "").trim();
  if (!name) throw new AppError(400, "name required");
  if (user.companyId == null) throw new AppError(400, "No company context");
  const kind = input.kind === "view" ? "view" : "filter";
  const rawEntity = (input.entityType ?? "").trim();
  // Preserve caller-provided entityType so new surfaces (e.g. mobile) can register
  // their own namespaces; validate as a safe bounded slug rather than a hard enum.
  const entityType =
    rawEntity && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(rawEntity) ? rawEntity : "contacts";
  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const row = await savedRepo.insert({ companyId: user.companyId, userId: user.id, name, kind, entityType, payload });
  return formatSaved(row);
}

export async function updateSaved(user: AuthUser, id: number, input: { name?: string; payload?: unknown }) {
  const existing = await savedRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Saved search not found");
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new AppError(400, "name cannot be empty");
    data.name = name;
  }
  if (input.payload !== undefined) data.payload = (input.payload ?? {}) as Record<string, unknown>;
  if (Object.keys(data).length === 0) throw new AppError(400, "No valid fields to update");
  await savedRepo.updateRow(id, user.id, data);
  const updated = await savedRepo.findById(user, id);
  return formatSaved(updated!);
}

export async function deleteSaved(user: AuthUser, id: number) {
  const existing = await savedRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Saved search not found");
  await savedRepo.softDelete(id, user.id);
  return { success: true, message: "Saved search deleted" };
}

// ── Recent searches ────────────────────────────────────────────────────────

function formatRecent(r: recentRepo.RecentSearchRow) {
  return { id: r.id, entityType: r.entityType, label: r.label ?? "", payload: r.payload, createdAt: r.createdAt.toISOString() };
}

export async function listRecent(user: AuthUser, entityType = "contacts") {
  return { recentSearches: (await recentRepo.listForUser(user, entityType, RECENT_LIMIT)).map(formatRecent) };
}

export async function clearRecent(user: AuthUser, entityType = "contacts") {
  await recentRepo.clearForUser(user, entityType);
  return { success: true, message: "Recent searches cleared" };
}
