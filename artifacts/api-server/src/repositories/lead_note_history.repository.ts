import { db, leadNoteHistoryTable, usersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { type Executor, exec } from "./base.js";

export type LeadNoteHistoryRow = typeof leadNoteHistoryTable.$inferSelect;
export type LeadNoteHistoryWithUser = LeadNoteHistoryRow & { editedByName: string | null };

// Append a prior-body snapshot. History is append-only — there is no update or
// delete. Runs inside the caller's transaction when one is supplied.
export async function insert(values: typeof leadNoteHistoryTable.$inferInsert, tx?: Executor): Promise<LeadNoteHistoryRow> {
  const [row] = await exec(tx).insert(leadNoteHistoryTable).values(values).returning();
  return row;
}

// Full revision trail for a note, newest first. Callers must first authorize
// access to the parent note (tenant scope lives on the note).
export async function listForNote(noteId: number): Promise<LeadNoteHistoryWithUser[]> {
  return db
    .select({
      id: leadNoteHistoryTable.id,
      companyId: leadNoteHistoryTable.companyId,
      noteId: leadNoteHistoryTable.noteId,
      body: leadNoteHistoryTable.body,
      mentions: leadNoteHistoryTable.mentions,
      editedById: leadNoteHistoryTable.editedById,
      createdAt: leadNoteHistoryTable.createdAt,
      editedByName: usersTable.name,
    })
    .from(leadNoteHistoryTable)
    .leftJoin(usersTable, eq(leadNoteHistoryTable.editedById, usersTable.id))
    .where(eq(leadNoteHistoryTable.noteId, noteId))
    .orderBy(desc(leadNoteHistoryTable.createdAt), desc(leadNoteHistoryTable.id));
}
