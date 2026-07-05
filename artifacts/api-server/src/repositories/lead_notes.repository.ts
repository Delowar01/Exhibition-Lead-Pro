import { db, leadNotesTable, usersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, type Executor, exec } from "./base.js";

export type LeadNoteRow = typeof leadNotesTable.$inferSelect;
export type LeadNoteWithUser = Omit<LeadNoteRow, "deletedAt"> & { userName: string | null };

function selectWithUser() {
  return db
    .select({
      id: leadNotesTable.id,
      companyId: leadNotesTable.companyId,
      leadId: leadNotesTable.leadId,
      contactId: leadNotesTable.contactId,
      userId: leadNotesTable.userId,
      userName: usersTable.name,
      body: leadNotesTable.body,
      isPinned: leadNotesTable.isPinned,
      createdAt: leadNotesTable.createdAt,
      updatedAt: leadNotesTable.updatedAt,
    })
    .from(leadNotesTable)
    .leftJoin(usersTable, eq(leadNotesTable.userId, usersTable.id));
}

export async function listForLead(user: AuthUser, leadId: number): Promise<LeadNoteWithUser[]> {
  const where = activeScope(user, leadNotesTable.companyId, leadNotesTable.deletedAt, { extra: [eq(leadNotesTable.leadId, leadId)] });
  return selectWithUser().where(where).orderBy(desc(leadNotesTable.isPinned), desc(leadNotesTable.createdAt), desc(leadNotesTable.id));
}

export async function listForContact(user: AuthUser, contactId: number): Promise<LeadNoteWithUser[]> {
  const where = activeScope(user, leadNotesTable.companyId, leadNotesTable.deletedAt, { extra: [eq(leadNotesTable.contactId, contactId)] });
  return selectWithUser().where(where).orderBy(desc(leadNotesTable.createdAt), desc(leadNotesTable.id));
}

export async function findById(user: AuthUser, id: number): Promise<LeadNoteWithUser | undefined> {
  const where = activeScope(user, leadNotesTable.companyId, leadNotesTable.deletedAt, { extra: [eq(leadNotesTable.id, id)] });
  const [row] = await selectWithUser().where(where).limit(1);
  return row;
}

export async function getByIdWithUser(id: number): Promise<LeadNoteWithUser | undefined> {
  const [row] = await selectWithUser().where(eq(leadNotesTable.id, id)).limit(1);
  return row;
}

export async function insert(values: typeof leadNotesTable.$inferInsert, tx?: Executor): Promise<LeadNoteRow> {
  const [row] = await exec(tx).insert(leadNotesTable).values(values).returning();
  return row;
}

export async function updateRow(id: number, data: Partial<typeof leadNotesTable.$inferInsert>): Promise<void> {
  await db.update(leadNotesTable).set({ ...data, updatedAt: new Date() }).where(eq(leadNotesTable.id, id));
}

export async function softDelete(id: number): Promise<void> {
  await db.update(leadNotesTable).set({ deletedAt: new Date() }).where(eq(leadNotesTable.id, id));
}
