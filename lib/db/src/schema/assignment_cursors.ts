import { pgTable, serial, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { teamsTable } from "./teams";

// Persistent round-robin rotation state, one row per assignment pool
// (companyId, teamId). `position` is a monotonic counter: each round-robin
// assignment reads it, picks members[position % memberCount], then increments
// it — all inside the pool's advisory-locked transaction. Unlike deriving the
// cursor from a lead count, this survives reassignment, unassignment, and lead
// deletion, giving true strictly-rotating round-robin.
export const assignmentCursorsTable = pgTable("assignment_cursors", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  teamId: integer("team_id").notNull().references(() => teamsTable.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
}, (t) => [
  uniqueIndex("assignment_cursors_company_team_idx").on(t.companyId, t.teamId),
]);

export type AssignmentCursor = typeof assignmentCursorsTable.$inferSelect;
