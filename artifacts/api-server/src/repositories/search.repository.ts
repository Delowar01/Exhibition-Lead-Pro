import { db, contactsTable } from "@workspace/db";
import { and, or, not, eq, ilike, isNull, isNotNull, count, desc, asc, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope } from "./base.js";
import type { ContactRow } from "./contacts.repository.js";

// Fields the advanced contact search can query. Text fields may span several
// columns (a positive match on any column matches the row); integer fields are
// single-column equality/presence checks.
const TEXT_FIELDS: Record<string, PgColumn[]> = {
  name: [contactsTable.firstName, contactsTable.lastName, contactsTable.fullName, contactsTable.arabicName],
  company: [contactsTable.contactCompany],
  email: [contactsTable.email],
  phone: [contactsTable.mobile, contactsTable.officePhone],
  industry: [contactsTable.industry],
  country: [contactsTable.country],
  tags: [contactsTable.tags],
  notes: [contactsTable.notes],
};
const INT_FIELDS: Record<string, PgColumn> = {
  event: contactsTable.eventId,
  employee: contactsTable.assignedToId,
};

export const SEARCH_FIELDS = [...Object.keys(TEXT_FIELDS), ...Object.keys(INT_FIELDS)];
export const TEXT_OPERATORS = ["contains", "notContains", "equals", "notEquals", "startsWith", "endsWith", "isEmpty", "isNotEmpty"];
export const INT_OPERATORS = ["equals", "notEquals", "isEmpty", "isNotEmpty"];

export interface SearchCondition {
  field: string;
  operator: string;
  value?: string | number | null;
}

export interface SearchQuery {
  combinator: "AND" | "OR";
  conditions: SearchCondition[];
  sort?: string;
  limit: number;
  offset: number;
}

function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function textCondition(cols: PgColumn[], operator: string, raw: unknown): SQL | undefined {
  const value = typeof raw === "string" ? raw.trim() : "";
  switch (operator) {
    case "isEmpty":
      return and(...cols.map((c) => sql`(${c} IS NULL OR ${c} = '')`));
    case "isNotEmpty":
      return or(...cols.map((c) => sql`(${c} IS NOT NULL AND ${c} <> '')`));
    default:
      break;
  }
  if (!value) return undefined; // value-bearing operators need a value
  const esc = escapeLike(value);
  switch (operator) {
    case "contains":
      return or(...cols.map((c) => ilike(c, `%${esc}%`)));
    case "notContains":
      return and(...cols.map((c) => sql`(${c} IS NULL OR ${c} NOT ILIKE ${`%${esc}%`})`));
    case "equals":
      return or(...cols.map((c) => ilike(c, esc)));
    case "notEquals":
      return and(...cols.map((c) => sql`(${c} IS NULL OR ${c} NOT ILIKE ${esc})`));
    case "startsWith":
      return or(...cols.map((c) => ilike(c, `${esc}%`)));
    case "endsWith":
      return or(...cols.map((c) => ilike(c, `%${esc}`)));
    default:
      return undefined;
  }
}

function intCondition(col: PgColumn, operator: string, raw: unknown): SQL | undefined {
  if (operator === "isEmpty") return isNull(col);
  if (operator === "isNotEmpty") return isNotNull(col);
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(n)) return undefined;
  if (operator === "equals") return eq(col, n);
  if (operator === "notEquals") return or(isNull(col), not(eq(col, n)));
  return undefined;
}

// Translate a single condition into a SQL fragment (or undefined when the
// condition is incomplete, e.g. a value-bearing operator with no value).
export function buildCondition(cond: SearchCondition): SQL | undefined {
  if (TEXT_FIELDS[cond.field]) return textCondition(TEXT_FIELDS[cond.field], cond.operator, cond.value);
  if (INT_FIELDS[cond.field]) return intCondition(INT_FIELDS[cond.field], cond.operator, cond.value);
  return undefined;
}

// Tenant-scoped, soft-delete-excluding, originals-only advanced contact search.
export async function searchContacts(user: AuthUser, query: SearchQuery): Promise<{ rows: ContactRow[]; total: number }> {
  const frags = query.conditions.map(buildCondition).filter((f): f is SQL => f !== undefined);
  const group = frags.length === 0 ? undefined : query.combinator === "OR" ? or(...frags) : and(...frags);

  const where = activeScope(user, contactsTable.companyId, contactsTable.deletedAt, {
    extra: [isNull(contactsTable.duplicateOfId), group],
  });
  const orderBy =
    query.sort === "oldest" ? asc(contactsTable.createdAt) : query.sort === "name" ? asc(contactsTable.fullName) : desc(contactsTable.createdAt);

  const [{ total }] = await db.select({ total: count() }).from(contactsTable).where(where);
  const rows = await db.select().from(contactsTable).where(where).limit(query.limit).offset(query.offset).orderBy(orderBy);
  return { rows, total };
}
