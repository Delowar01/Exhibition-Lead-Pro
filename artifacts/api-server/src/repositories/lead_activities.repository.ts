import { db, leadActivitiesTable, usersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, exec, type Executor } from "./base.js";

export type LeadActivityRow = typeof leadActivitiesTable.$inferSelect;
export type LeadActivityWithUser = Omit<LeadActivityRow, "updatedAt" | "deletedAt"> & { userName: string | null };

function selectWithUser() {
  return db
    .select({
      id: leadActivitiesTable.id,
      companyId: leadActivitiesTable.companyId,
      leadId: leadActivitiesTable.leadId,
      contactId: leadActivitiesTable.contactId,
      userId: leadActivitiesTable.userId,
      userName: usersTable.name,
      type: leadActivitiesTable.type,
      source: leadActivitiesTable.source,
      subject: leadActivitiesTable.subject,
      body: leadActivitiesTable.body,
      outcome: leadActivitiesTable.outcome,
      metadata: leadActivitiesTable.metadata,
      occurredAt: leadActivitiesTable.occurredAt,
      createdAt: leadActivitiesTable.createdAt,
    })
    .from(leadActivitiesTable)
    .leftJoin(usersTable, eq(leadActivitiesTable.userId, usersTable.id));
}

export async function listForLead(user: AuthUser, leadId: number): Promise<LeadActivityWithUser[]> {
  const where = activeScope(user, leadActivitiesTable.companyId, leadActivitiesTable.deletedAt, { extra: [eq(leadActivitiesTable.leadId, leadId)] });
  return selectWithUser().where(where).orderBy(desc(leadActivitiesTable.occurredAt), desc(leadActivitiesTable.id));
}

export async function listForContact(user: AuthUser, contactId: number): Promise<LeadActivityWithUser[]> {
  const where = activeScope(user, leadActivitiesTable.companyId, leadActivitiesTable.deletedAt, { extra: [eq(leadActivitiesTable.contactId, contactId)] });
  return selectWithUser().where(where).orderBy(desc(leadActivitiesTable.occurredAt), desc(leadActivitiesTable.id));
}

export async function findById(user: AuthUser, id: number): Promise<LeadActivityWithUser | undefined> {
  const where = activeScope(user, leadActivitiesTable.companyId, leadActivitiesTable.deletedAt, { extra: [eq(leadActivitiesTable.id, id)] });
  const [row] = await selectWithUser().where(where).limit(1);
  return row;
}

export async function getByIdWithUser(id: number): Promise<LeadActivityWithUser | undefined> {
  const [row] = await selectWithUser().where(eq(leadActivitiesTable.id, id)).limit(1);
  return row;
}

export async function insert(values: typeof leadActivitiesTable.$inferInsert, tx?: Executor): Promise<LeadActivityRow> {
  const [row] = await exec(tx).insert(leadActivitiesTable).values(values).returning();
  return row;
}

export async function updateRow(id: number, data: Partial<typeof leadActivitiesTable.$inferInsert>): Promise<void> {
  await db.update(leadActivitiesTable).set({ ...data, updatedAt: new Date() }).where(eq(leadActivitiesTable.id, id));
}

export async function softDelete(id: number): Promise<void> {
  await db.update(leadActivitiesTable).set({ deletedAt: new Date() }).where(eq(leadActivitiesTable.id, id));
}
