import { eventsTable, usersTable, contactsTable, departmentsTable, teamsTable, pipelineStagesTable, tagsTable, leadsTable, organizationsTable } from "@workspace/db";
import { canAccessCompany, type AuthUser } from "../middlewares/requireAuth.js";
import { findCompanyIdById } from "../repositories/base.js";

// Per-table existence config: id/company columns plus an optional deletedAt column
// so soft-deleted FK targets (contacts, events, departments, teams) are treated as non-existent.
const REF_TABLES = {
  events: { table: eventsTable, idColumn: eventsTable.id, companyColumn: eventsTable.companyId, deletedAtColumn: eventsTable.deletedAt },
  users: { table: usersTable, idColumn: usersTable.id, companyColumn: usersTable.companyId, deletedAtColumn: usersTable.deletedAt },
  contacts: { table: contactsTable, idColumn: contactsTable.id, companyColumn: contactsTable.companyId, deletedAtColumn: contactsTable.deletedAt },
  departments: { table: departmentsTable, idColumn: departmentsTable.id, companyColumn: departmentsTable.companyId, deletedAtColumn: departmentsTable.deletedAt },
  teams: { table: teamsTable, idColumn: teamsTable.id, companyColumn: teamsTable.companyId, deletedAtColumn: teamsTable.deletedAt },
  pipelineStages: { table: pipelineStagesTable, idColumn: pipelineStagesTable.id, companyColumn: pipelineStagesTable.companyId, deletedAtColumn: pipelineStagesTable.deletedAt },
  tags: { table: tagsTable, idColumn: tagsTable.id, companyColumn: tagsTable.companyId, deletedAtColumn: tagsTable.deletedAt },
  leads: { table: leadsTable, idColumn: leadsTable.id, companyColumn: leadsTable.companyId, deletedAtColumn: leadsTable.deletedAt },
  organizations: { table: organizationsTable, idColumn: organizationsTable.id, companyColumn: organizationsTable.companyId, deletedAtColumn: organizationsTable.deletedAt },
} as const;

// Validates that a referenced foreign-key row (event, user, contact) exists AND
// belongs to a company the caller can access. Returns true when the id is null/
// undefined (nothing to validate). Soft-deleted contacts/events are treated as
// non-existent. Prevents cross-tenant FK injection on writes.
export async function refAccessible(
  user: AuthUser | undefined,
  table: keyof typeof REF_TABLES,
  id: number | null | undefined,
): Promise<boolean> {
  if (id == null) return true;
  const { table: t, idColumn, companyColumn, deletedAtColumn } = REF_TABLES[table];
  const companyId = await findCompanyIdById(t, idColumn, companyColumn, id, deletedAtColumn);
  if (companyId === undefined) return false;
  return canAccessCompany(user, companyId);
}

// Validates that a referenced foreign-key row exists AND belongs to a SPECIFIC
// company (the target record's tenant), not merely a company the caller can access.
// Use this when binding a row to another tenant's record (e.g. assigning a user's
// manager/department/team): `refAccessible` is caller-scoped, so a platform_owner or
// multi-company caller would otherwise be able to point company A's user at company
// B's department. Returns true for a null id (nothing to validate); false when the
// target company is null (an unassigned record cannot carry org FKs) or the FK row
// is missing/soft-deleted/in a different company.
export async function refInCompany(
  table: keyof typeof REF_TABLES,
  companyId: number | null | undefined,
  id: number | null | undefined,
): Promise<boolean> {
  if (id == null) return true;
  if (companyId == null) return false;
  const { table: t, idColumn, companyColumn, deletedAtColumn } = REF_TABLES[table];
  const rowCompanyId = await findCompanyIdById(t, idColumn, companyColumn, id, deletedAtColumn);
  if (rowCompanyId === undefined) return false;
  return rowCompanyId === companyId;
}
