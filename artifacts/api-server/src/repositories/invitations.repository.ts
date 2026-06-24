import { db, invitationsTable, type Invitation } from "@workspace/db";
import { and, eq, inArray, desc, type SQL } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";

export type { Invitation };

export async function insert(values: typeof invitationsTable.$inferInsert): Promise<Invitation> {
  const [row] = await db.insert(invitationsTable).values(values).returning();
  return row;
}

// Tenant-scoped list. platform_owner sees all; everyone else only their accessible
// companies (never scope by a single companyId that could be null).
export async function list(user: AuthUser, companyId?: number): Promise<Invitation[]> {
  const filters: SQL[] = [];
  if (user.role !== "platform_owner") {
    filters.push(inArray(invitationsTable.companyId, user.accessibleCompanies));
  }
  if (companyId != null) filters.push(eq(invitationsTable.companyId, companyId));
  const where = filters.length > 0 ? and(...filters) : undefined;
  return db.select().from(invitationsTable).where(where).orderBy(desc(invitationsTable.createdAt));
}

export async function findById(id: number): Promise<Invitation | undefined> {
  const [row] = await db.select().from(invitationsTable).where(eq(invitationsTable.id, id)).limit(1);
  return row;
}

export async function findByTokenHash(tokenHash: string): Promise<Invitation | undefined> {
  const [row] = await db.select().from(invitationsTable).where(eq(invitationsTable.tokenHash, tokenHash)).limit(1);
  return row;
}

// A pending, non-expired invitation already outstanding for this email+company.
export async function findPendingForEmail(companyId: number, email: string): Promise<Invitation | undefined> {
  const [row] = await db
    .select()
    .from(invitationsTable)
    .where(
      and(
        eq(invitationsTable.companyId, companyId),
        eq(invitationsTable.email, email),
        eq(invitationsTable.status, "pending"),
      ),
    )
    .limit(1);
  return row;
}

export async function update(id: number, data: Partial<typeof invitationsTable.$inferInsert>): Promise<Invitation | undefined> {
  const [row] = await db
    .update(invitationsTable)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(invitationsTable.id, id))
    .returning();
  return row;
}
