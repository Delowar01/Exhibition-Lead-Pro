import { db, auditLogsTable } from "@workspace/db";
import { and, desc, eq, gte, lte, ilike, or, sql, inArray, type SQL } from "drizzle-orm";
import { tenantScope, type AuthUser } from "../middlewares/requireAuth.js";

export type AuditLogRow = typeof auditLogsTable.$inferSelect;

export interface AuditLogFilters {
  companyId?: number;
  userId?: number;
  action?: string;
  entityType?: string;
  entityId?: string;
  search?: string;
  startDate?: Date;
  endDate?: Date;
  limit: number;
  offset: number;
}

// Searchable, tenant-scoped read over the append-only audit trail. tenantScope keeps a
// company admin to their accessible companies (and excludes null-company platform rows);
// platform_owner sees everything. An optional companyId narrows within that scope only
// when the caller may access it, so it can never widen a tenant's view.
export async function listAuditLogs(
  user: AuthUser,
  f: AuditLogFilters,
): Promise<{ items: AuditLogRow[]; total: number }> {
  const conds: SQL[] = [];

  const scope = tenantScope(user, auditLogsTable.companyId);
  if (scope) conds.push(scope);

  if (f.companyId != null && (user.role === "platform_owner" || user.accessibleCompanies.includes(f.companyId))) {
    conds.push(eq(auditLogsTable.companyId, f.companyId));
  }
  if (f.userId != null) conds.push(eq(auditLogsTable.userId, f.userId));
  if (f.action) conds.push(eq(auditLogsTable.action, f.action));
  if (f.entityType) conds.push(eq(auditLogsTable.entityType, f.entityType));
  if (f.entityId) conds.push(eq(auditLogsTable.entityId, f.entityId));
  if (f.startDate) conds.push(gte(auditLogsTable.createdAt, f.startDate));
  if (f.endDate) conds.push(lte(auditLogsTable.createdAt, f.endDate));
  if (f.search) {
    const pat = `%${f.search}%`;
    conds.push(
      or(
        ilike(auditLogsTable.userName, pat),
        ilike(auditLogsTable.action, pat),
        ilike(auditLogsTable.entityType, pat),
      )!,
    );
  }

  const where = conds.length ? and(...conds) : undefined;

  const [items, countRows] = await Promise.all([
    db
      .select()
      .from(auditLogsTable)
      .where(where)
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(f.limit)
      .offset(f.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(auditLogsTable).where(where),
  ]);

  return { items, total: countRows[0]?.count ?? 0 };
}

// Batch 21 — platform-owner view of ONE tenant's administrative trail by explicit
// company id, restricted to the given entity types (the service passes the
// platform allow-list: subscription / company / team — never CRM modules).
// Newest first; `limit` rows plus the total for the same filter.
export async function listCompanyAuditByEntityTypes(
  companyId: number,
  entityTypes: readonly string[],
  limit: number,
): Promise<{ items: AuditLogRow[]; total: number }> {
  const where = or(
    and(eq(auditLogsTable.companyId, companyId), inArray(auditLogsTable.entityType, [...entityTypes])),
    // Platform-owner requests on this tenant: the router-level audit rows carry the
    // OWNER's company id (null) and the target company id as the entity id.
    and(eq(auditLogsTable.entityType, "company"), eq(auditLogsTable.entityId, String(companyId))),
  )!;
  const [items, countRows] = await Promise.all([
    db.select().from(auditLogsTable).where(where).orderBy(desc(auditLogsTable.createdAt), desc(auditLogsTable.id)).limit(limit),
    db.select({ count: sql<number>`count(*)::int` }).from(auditLogsTable).where(where),
  ]);
  return { items, total: countRows[0]?.count ?? 0 };
}
