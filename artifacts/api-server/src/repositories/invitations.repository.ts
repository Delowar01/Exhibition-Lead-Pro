import { db, invitationsTable, type Invitation } from "@workspace/db";
import { and, or, eq, inArray, asc, desc, ilike, sql, type SQL, type AnyColumn } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";

export type { Invitation };

// Sortable columns for listInvitations (allowlist → real columns). Default createdAt desc.
const INVITATION_SORT: Record<string, AnyColumn> = {
  createdAt: invitationsTable.createdAt,
  updatedAt: invitationsTable.updatedAt,
  email: invitationsTable.email,
  status: invitationsTable.status,
};

export interface ListInvitationsOpts {
  search?: string;
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
  paginated?: boolean;
}

export async function insert(values: typeof invitationsTable.$inferInsert): Promise<Invitation> {
  const [row] = await db.insert(invitationsTable).values(values).returning();
  return row;
}

// Tenant-scoped list. platform_owner sees all; everyone else only their accessible
// companies (never scope by a single companyId that could be null).
export async function list(
  user: AuthUser,
  companyId?: number,
  opts: ListInvitationsOpts = {},
): Promise<{ rows: Invitation[]; total: number }> {
  const filters: SQL[] = [];
  if (user.role !== "platform_owner") {
    filters.push(inArray(invitationsTable.companyId, user.accessibleCompanies));
  }
  if (companyId != null) filters.push(eq(invitationsTable.companyId, companyId));
  if (opts.search) {
    const term = `%${opts.search}%`;
    filters.push(or(ilike(invitationsTable.email, term), ilike(invitationsTable.name, term))!);
  }
  const where = filters.length > 0 ? and(...filters) : undefined;
  const sortCol = INVITATION_SORT[opts.sort ?? "createdAt"] ?? invitationsTable.createdAt;
  const orderExpr = opts.order === "asc" ? asc(sortCol) : desc(sortCol);
  // Opt-in pagination: callers that pass no page/limit keep the full result set.
  let query = db.select().from(invitationsTable).where(where).orderBy(orderExpr, desc(invitationsTable.id)).$dynamic();
  if (opts.paginated) query = query.limit(opts.limit ?? 50).offset(opts.offset ?? 0);
  const rows = await query;
  const total = opts.paginated
    ? Number((await db.select({ c: sql<number>`count(*)::int` }).from(invitationsTable).where(where))[0]?.c ?? 0)
    : rows.length;
  return { rows, total };
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

// Records the delivery outcome of the last invitation email (Batch 3). Called from
// the email worker/sync-send path; never throws (a status write must not break a
// send or retry loop). `error` must already be sanitized (no tokens/secrets).
export async function recordEmailOutcome(
  id: number,
  emailStatus: "queued" | "sent" | "failed" | "skipped",
  error?: string | null,
): Promise<void> {
  await db
    .update(invitationsTable)
    .set({ emailStatus, emailError: error ?? null, emailUpdatedAt: new Date(), updatedAt: new Date() })
    .where(eq(invitationsTable.id, id));
}

export async function update(id: number, data: Partial<typeof invitationsTable.$inferInsert>): Promise<Invitation | undefined> {
  const [row] = await db
    .update(invitationsTable)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(invitationsTable.id, id))
    .returning();
  return row;
}
