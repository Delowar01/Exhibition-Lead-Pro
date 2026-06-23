import { eventsTable, usersTable, contactsTable } from "@workspace/db";
import { canAccessCompany, type AuthUser } from "../middlewares/requireAuth.js";
import { findCompanyIdById } from "../repositories/base.js";

// Per-table existence config: id/company columns plus an optional deletedAt column
// so soft-deleted FK targets (contacts, events) are treated as non-existent.
const REF_TABLES = {
  events: { table: eventsTable, idColumn: eventsTable.id, companyColumn: eventsTable.companyId, deletedAtColumn: eventsTable.deletedAt },
  users: { table: usersTable, idColumn: usersTable.id, companyColumn: usersTable.companyId, deletedAtColumn: undefined },
  contacts: { table: contactsTable, idColumn: contactsTable.id, companyColumn: contactsTable.companyId, deletedAtColumn: contactsTable.deletedAt },
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
