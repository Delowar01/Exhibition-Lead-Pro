import type { AuthUser } from "../middlewares/requireAuth.js";
import * as auditRepo from "../repositories/audit.repository.js";
import { parseListQuery } from "../lib/list-query.js";

function str(v: unknown): string | undefined {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? undefined : s;
}

function num(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? undefined : n;
}

function parseStartDate(v: unknown): Date | undefined {
  const s = str(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// endDate is inclusive: a date-only value (YYYY-MM-DD) is extended to the end of that day
// so "to: 2026-06-24" includes rows logged at 2026-06-24 14:00, not just 00:00.
function parseEndDate(v: unknown): Date | undefined {
  const s = str(v);
  if (!s) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59.999` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function listAuditLogs(user: AuthUser, query: Record<string, unknown>) {
  const lq = parseListQuery(query, { defaultPageSize: 25, maxPageSize: 100 });
  const { items, total } = await auditRepo.listAuditLogs(user, {
    companyId: num(query.companyId),
    userId: num(query.userId),
    action: str(query.action),
    entityType: str(query.entityType),
    entityId: str(query.entityId),
    search: lq.search,
    startDate: parseStartDate(query.startDate),
    endDate: parseEndDate(query.endDate),
    limit: lq.limit,
    offset: lq.offset,
  });
  return { items, total, page: lq.page, pageSize: lq.pageSize };
}
