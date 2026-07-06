import { db, organizationsTable, contactsTable, leadsTable } from "@workspace/db";
import { eq, ilike, and, count, inArray, notInArray, isNotNull } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, notDeleted } from "./base.js";

export type OrganizationRow = typeof organizationsTable.$inferSelect;

// Tenant-scoped, soft-delete-excluding list with optional name search + status filter.
export async function list(
  user: AuthUser,
  opts: { search?: string; status?: string; limit: number; offset: number },
): Promise<{ rows: OrganizationRow[]; total: number }> {
  const extra = [];
  if (opts.search) extra.push(ilike(organizationsTable.name, `%${opts.search}%`));
  if (opts.status) extra.push(eq(organizationsTable.status, opts.status));
  const where = activeScope(user, organizationsTable.companyId, organizationsTable.deletedAt, { extra });
  const [{ total }] = await db.select({ total: count() }).from(organizationsTable).where(where);
  const rows = await db
    .select()
    .from(organizationsTable)
    .where(where)
    .limit(opts.limit)
    .offset(opts.offset)
    .orderBy(organizationsTable.name);
  return { rows, total };
}

// Tenant-scoped, soft-delete-excluding single fetch. Returns undefined when the
// row does not exist, is soft-deleted, or is not accessible to the caller.
export async function findById(user: AuthUser, id: number): Promise<OrganizationRow | undefined> {
  const where = activeScope(user, organizationsTable.companyId, organizationsTable.deletedAt, { extra: [eq(organizationsTable.id, id)] });
  const [row] = await db.select().from(organizationsTable).where(where).limit(1);
  return row;
}

// Tenant-scoped duplicate check by normalized name (excludes soft-deleted). Used
// to reject creating two CRM companies with the same name in one tenant.
export async function findByNormalizedName(companyId: number, normalizedName: string): Promise<OrganizationRow | undefined> {
  const [row] = await db
    .select()
    .from(organizationsTable)
    .where(and(eq(organizationsTable.companyId, companyId), eq(organizationsTable.normalizedName, normalizedName), notDeleted(organizationsTable.deletedAt)))
    .limit(1);
  return row;
}

export async function insert(values: typeof organizationsTable.$inferInsert): Promise<OrganizationRow> {
  const [row] = await db.insert(organizationsTable).values(values).returning();
  return row;
}

export async function update(id: number, data: Partial<typeof organizationsTable.$inferInsert>): Promise<OrganizationRow | undefined> {
  const [row] = await db.update(organizationsTable).set(data).where(eq(organizationsTable.id, id)).returning();
  return row;
}

// Soft-delete. Hand-replicates the FK onDelete set-null behaviour inside one txn
// so no surviving contact/lead points at a dead organization: contacts.organizationId
// and leads.organizationId are nulled, then deletedAt is stamped.
export async function softDelete(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(contactsTable).set({ organizationId: null }).where(eq(contactsTable.organizationId, id));
    await tx.update(leadsTable).set({ organizationId: null }).where(eq(leadsTable.organizationId, id));
    await tx.update(organizationsTable).set({ deletedAt: new Date() }).where(eq(organizationsTable.id, id));
  });
}

// Live linked-contact + linked-lead counts for an organization (soft-deleted
// contacts/leads excluded).
export async function counts(id: number): Promise<{ contactCount: number; leadCount: number }> {
  const [c] = await db
    .select({ c: count() })
    .from(contactsTable)
    .where(and(eq(contactsTable.organizationId, id), notDeleted(contactsTable.deletedAt)));
  const [l] = await db
    .select({ c: count() })
    .from(leadsTable)
    .where(and(eq(leadsTable.organizationId, id), notDeleted(leadsTable.deletedAt)));
  return { contactCount: c.c, leadCount: l.c };
}

// Value + currency of every OPEN lead (stage not won/lost) linked to an
// organization, so the service can convert-then-sum across currencies.
export async function openLeadValues(id: number): Promise<Array<{ value: string | null; currency: string | null }>> {
  return db
    .select({ value: leadsTable.value, currency: leadsTable.currency })
    .from(leadsTable)
    .where(and(eq(leadsTable.organizationId, id), notDeleted(leadsTable.deletedAt), notInArray(leadsTable.stage, ["won", "lost"])));
}

// Tenant-scoped, soft-delete-excluding IDs of contacts linked to an organization.
export async function contactIds(user: AuthUser, orgId: number): Promise<number[]> {
  const where = activeScope(user, contactsTable.companyId, contactsTable.deletedAt, { extra: [eq(contactsTable.organizationId, orgId)] });
  const rows = await db.select({ id: contactsTable.id }).from(contactsTable).where(where);
  return rows.map((r) => r.id);
}

// Tenant-scoped, soft-delete-excluding IDs of leads linked to an organization.
export async function leadIds(user: AuthUser, orgId: number): Promise<number[]> {
  const where = activeScope(user, leadsTable.companyId, leadsTable.deletedAt, { extra: [eq(leadsTable.organizationId, orgId)] });
  const rows = await db.select({ id: leadsTable.id }).from(leadsTable).where(where);
  return rows.map((r) => r.id);
}

// Distinct, tenant-scoped IDs of events referenced by an org's linked contacts.
// Events have no organizationId, so linkage is transitive via contacts.eventId.
export async function eventIds(user: AuthUser, orgId: number): Promise<number[]> {
  const where = activeScope(user, contactsTable.companyId, contactsTable.deletedAt, {
    extra: [eq(contactsTable.organizationId, orgId), isNotNull(contactsTable.eventId)],
  });
  const rows = await db.selectDistinct({ eventId: contactsTable.eventId }).from(contactsTable).where(where);
  return rows.map((r) => r.eventId).filter((v): v is number => v != null);
}

export async function nameById(id: number): Promise<string | null> {
  const [row] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, id)).limit(1);
  return row?.name ?? null;
}

// Batch name resolution for enrichment (contact/lead lists). Includes
// soft-deleted rows by id so historical references still resolve a label.
export async function namesByIds(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: organizationsTable.id, name: organizationsTable.name }).from(organizationsTable).where(inArray(organizationsTable.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// Distinct free-text company labels used by the one-time backfill: contacts.contactCompany
// and leads.companyName that are non-empty and not yet linked to an organization.
export async function distinctContactCompanies(companyId: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ v: contactsTable.contactCompany })
    .from(contactsTable)
    .where(and(eq(contactsTable.companyId, companyId), notDeleted(contactsTable.deletedAt), isNotNull(contactsTable.contactCompany)));
  return rows.map((r) => r.v).filter((v): v is string => !!v && v.trim().length > 0);
}

export async function distinctLeadCompanies(companyId: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ v: leadsTable.companyName })
    .from(leadsTable)
    .where(and(eq(leadsTable.companyId, companyId), notDeleted(leadsTable.deletedAt), isNotNull(leadsTable.companyName)));
  return rows.map((r) => r.v).filter((v): v is string => !!v && v.trim().length > 0);
}

// Backfill link helpers: point matching un-linked contacts/leads at an organization.
export async function linkContactsByCompany(companyId: number, orgId: number, contactCompany: string): Promise<number> {
  const rows = await db
    .update(contactsTable)
    .set({ organizationId: orgId })
    .where(and(eq(contactsTable.companyId, companyId), eq(contactsTable.contactCompany, contactCompany), notDeleted(contactsTable.deletedAt)))
    .returning({ id: contactsTable.id });
  return rows.length;
}

export async function linkLeadsByCompany(companyId: number, orgId: number, companyName: string): Promise<number> {
  const rows = await db
    .update(leadsTable)
    .set({ organizationId: orgId })
    .where(and(eq(leadsTable.companyId, companyId), eq(leadsTable.companyName, companyName), notDeleted(leadsTable.deletedAt)))
    .returning({ id: leadsTable.id });
  return rows.length;
}
