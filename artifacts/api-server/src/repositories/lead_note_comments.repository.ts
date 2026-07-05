import { db, leadNoteCommentsTable, usersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, type Executor, exec } from "./base.js";

export type LeadNoteCommentRow = typeof leadNoteCommentsTable.$inferSelect;
export type LeadNoteCommentWithUser = Omit<LeadNoteCommentRow, "deletedAt"> & { userName: string | null };

function selectWithUser() {
  return db
    .select({
      id: leadNoteCommentsTable.id,
      companyId: leadNoteCommentsTable.companyId,
      noteId: leadNoteCommentsTable.noteId,
      userId: leadNoteCommentsTable.userId,
      userName: usersTable.name,
      body: leadNoteCommentsTable.body,
      mentions: leadNoteCommentsTable.mentions,
      createdAt: leadNoteCommentsTable.createdAt,
      updatedAt: leadNoteCommentsTable.updatedAt,
    })
    .from(leadNoteCommentsTable)
    .leftJoin(usersTable, eq(leadNoteCommentsTable.userId, usersTable.id));
}

export async function listForNote(user: AuthUser, noteId: number): Promise<LeadNoteCommentWithUser[]> {
  const where = activeScope(user, leadNoteCommentsTable.companyId, leadNoteCommentsTable.deletedAt, {
    extra: [eq(leadNoteCommentsTable.noteId, noteId)],
  });
  return selectWithUser().where(where).orderBy(desc(leadNoteCommentsTable.createdAt), desc(leadNoteCommentsTable.id));
}

export async function findById(user: AuthUser, id: number): Promise<LeadNoteCommentWithUser | undefined> {
  const where = activeScope(user, leadNoteCommentsTable.companyId, leadNoteCommentsTable.deletedAt, {
    extra: [eq(leadNoteCommentsTable.id, id)],
  });
  const [row] = await selectWithUser().where(where).limit(1);
  return row;
}

export async function getByIdWithUser(id: number): Promise<LeadNoteCommentWithUser | undefined> {
  const [row] = await selectWithUser().where(eq(leadNoteCommentsTable.id, id)).limit(1);
  return row;
}

export async function insert(values: typeof leadNoteCommentsTable.$inferInsert, tx?: Executor): Promise<LeadNoteCommentRow> {
  const [row] = await exec(tx).insert(leadNoteCommentsTable).values(values).returning();
  return row;
}

export async function updateRow(id: number, data: Partial<typeof leadNoteCommentsTable.$inferInsert>): Promise<void> {
  await db.update(leadNoteCommentsTable).set({ ...data, updatedAt: new Date() }).where(eq(leadNoteCommentsTable.id, id));
}

export async function softDelete(id: number): Promise<void> {
  await db.update(leadNoteCommentsTable).set({ deletedAt: new Date() }).where(eq(leadNoteCommentsTable.id, id));
}
