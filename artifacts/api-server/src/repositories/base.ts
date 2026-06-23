import { db } from "@workspace/db";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { tenantScope, type AuthUser } from "../middlewares/requireAuth.js";

// A Drizzle executor: either the shared connection pool (`db`) or an open
// transaction handle. Repository functions accept an optional `tx` so callers
// can compose several writes atomically; when omitted they run on `db`.
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export function exec(tx?: Executor): Executor {
  return tx ?? db;
}

// Combines several WHERE fragments, dropping undefined ones. Returns undefined
// when nothing is left (matches Drizzle's "no filter" contract).
export function combine(...conds: Array<SQL | undefined>): SQL | undefined {
  const present = conds.filter((c): c is SQL => c !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return and(...present);
}

// Tenant-scoped WHERE for tables that do NOT have a soft-delete column.
// Applies tenantScope(companyId) + any extra conditions.
export function tenantOnly(user: AuthUser | undefined, companyColumn: PgColumn, ...extra: Array<SQL | undefined>): SQL | undefined {
  return combine(tenantScope(user, companyColumn), ...extra);
}

// Tenant-scoped WHERE for soft-delete tables: tenantScope(companyId) +
// deletedAt IS NULL (default exclusion) + any extra conditions. Pass
// includeDeleted=true to keep soft-deleted rows in the result.
export function activeScope(
  user: AuthUser | undefined,
  companyColumn: PgColumn,
  deletedAtColumn: PgColumn,
  opts?: { includeDeleted?: boolean; extra?: Array<SQL | undefined> },
): SQL | undefined {
  const conds: Array<SQL | undefined> = [tenantScope(user, companyColumn)];
  if (!opts?.includeDeleted) conds.push(isNull(deletedAtColumn));
  if (opts?.extra) conds.push(...opts.extra);
  return combine(...conds);
}

// deletedAt IS NULL fragment for soft-delete tables, for use inside bespoke
// queries (joins, subqueries) where the full activeScope helper does not fit.
export function notDeleted(deletedAtColumn: PgColumn): SQL {
  return isNull(deletedAtColumn);
}

// Scoped existence check used by refAccessible: returns the row's companyId when
// the row exists (and is not soft-deleted, when a deletedAt column is given),
// else undefined. Tenant authorization is applied by the caller via canAccessCompany.
export async function findCompanyIdById(
  table: PgTable,
  idColumn: PgColumn,
  companyColumn: PgColumn,
  id: number,
  deletedAtColumn?: PgColumn,
  tx?: Executor,
): Promise<number | null | undefined> {
  const where = deletedAtColumn ? and(eq(idColumn, id), isNull(deletedAtColumn)) : eq(idColumn, id);
  const [row] = await exec(tx).select({ companyId: companyColumn }).from(table).where(where).limit(1);
  return row?.companyId as number | null | undefined;
}
