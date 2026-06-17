import { db, eventsTable, usersTable, contactsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { canAccessCompany, type AuthUser } from "../middlewares/requireAuth.js";

const REF_TABLES = {
  events: eventsTable,
  users: usersTable,
  contacts: contactsTable,
} as const;

// Validates that a referenced foreign-key row (event, user, contact) exists AND
// belongs to a company the caller can access. Returns true when the id is null/
// undefined (nothing to validate). Prevents cross-tenant FK injection on writes.
export async function refAccessible(
  user: AuthUser | undefined,
  table: keyof typeof REF_TABLES,
  id: number | null | undefined,
): Promise<boolean> {
  if (id == null) return true;
  const t = REF_TABLES[table];
  const [row] = await db.select({ companyId: t.companyId }).from(t).where(eq(t.id, id)).limit(1);
  return !!row && canAccessCompany(user, row.companyId);
}
