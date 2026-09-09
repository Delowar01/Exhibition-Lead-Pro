import {
  db,
  subscriptionsTable,
  companiesTable,
  plansTable,
  planPricesTable,
  billingCheckoutSessionsTable,
  billingProviderEventsTable,
  subscriptionUsageReservationsTable,
  contactsTable,
  eventsTable,
  usersTable,
  invitationsTable,
  scansTable,
} from "@workspace/db";
import { and, asc, count, desc, eq, gt, gte, ilike, inArray, isNull, isNotNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { exec, type Executor } from "./base.js";

// Batch 20 — data access for the canonical subscription model. Every function
// accepts an optional transaction executor so the services can compose atomic
// lifecycle changes (subscription + company mirror + audit) in ONE transaction.

export type SubscriptionRow = typeof subscriptionsTable.$inferSelect;
export type PlanRow = typeof plansTable.$inferSelect;
export type PlanPriceRow = typeof planPricesTable.$inferSelect;
export type CheckoutSessionRow = typeof billingCheckoutSessionsTable.$inferSelect;
export type ProviderEventRow = typeof billingProviderEventsTable.$inferSelect;
export type ReservationRow = typeof subscriptionUsageReservationsTable.$inferSelect;
export type CompanyRow = typeof companiesTable.$inferSelect;

// ── subscriptions ────────────────────────────────────────────────────────────

export async function findByCompanyId(companyId: number, tx?: Executor): Promise<SubscriptionRow | undefined> {
  const [row] = await exec(tx).select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId)).limit(1);
  return row;
}

// Row lock for the duration of the caller's transaction: serializes every
// lifecycle / webhook / checkout mutation of one company's subscription.
export async function lockByCompanyId(companyId: number, tx: Executor): Promise<SubscriptionRow | undefined> {
  const [row] = await tx.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId)).for("update");
  return row;
}

export async function lockById(id: number, tx: Executor): Promise<SubscriptionRow | undefined> {
  const [row] = await tx.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, id)).for("update");
  return row;
}

export async function findById(id: number, tx?: Executor): Promise<SubscriptionRow | undefined> {
  const [row] = await exec(tx).select().from(subscriptionsTable).where(eq(subscriptionsTable.id, id)).limit(1);
  return row;
}

export async function findByStripeCustomerId(customerId: string, tx?: Executor): Promise<SubscriptionRow | undefined> {
  const [row] = await exec(tx).select().from(subscriptionsTable).where(eq(subscriptionsTable.stripeCustomerId, customerId)).limit(1);
  return row;
}

export async function findByStripeSubscriptionId(subscriptionId: string, tx?: Executor): Promise<SubscriptionRow | undefined> {
  const [row] = await exec(tx).select().from(subscriptionsTable).where(eq(subscriptionsTable.stripeSubscriptionId, subscriptionId)).limit(1);
  return row;
}

export async function insert(values: typeof subscriptionsTable.$inferInsert, tx?: Executor): Promise<SubscriptionRow> {
  const [row] = await exec(tx).insert(subscriptionsTable).values(values).returning();
  return row;
}

export async function update(id: number, data: Partial<typeof subscriptionsTable.$inferInsert>, tx?: Executor): Promise<SubscriptionRow | undefined> {
  const [row] = await exec(tx)
    .update(subscriptionsTable)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(subscriptionsTable.id, id))
    .returning();
  return row;
}

export interface ListFilters {
  status?: string;
  plan?: string;
  billingSource?: string;
  search?: string;
  limit: number;
  offset: number;
}

export type SubscriptionWithCompany = SubscriptionRow & { companyName: string; companyCreatedAt: Date };

export async function listWithCompanies(f: ListFilters): Promise<{ rows: SubscriptionWithCompany[]; total: number }> {
  const conds: SQL[] = [];
  if (f.status) conds.push(eq(subscriptionsTable.status, f.status));
  if (f.plan) conds.push(eq(subscriptionsTable.plan, f.plan));
  if (f.billingSource) conds.push(eq(subscriptionsTable.billingSource, f.billingSource));
  if (f.search) conds.push(ilike(companiesTable.name, `%${f.search}%`));
  const where = conds.length ? and(...conds) : undefined;
  const base = db.select({ s: subscriptionsTable, companyName: companiesTable.name, companyCreatedAt: companiesTable.createdAt }).from(subscriptionsTable).innerJoin(companiesTable, eq(companiesTable.id, subscriptionsTable.companyId));
  const [{ total }] = await db.select({ total: count() }).from(subscriptionsTable).innerJoin(companiesTable, eq(companiesTable.id, subscriptionsTable.companyId)).where(where);
  const rows = await base.where(where).orderBy(desc(subscriptionsTable.updatedAt), asc(subscriptionsTable.id)).limit(f.limit).offset(f.offset);
  return { rows: rows.map((r) => ({ ...r.s, companyName: r.companyName, companyCreatedAt: r.companyCreatedAt })), total };
}

export async function countsBy(column: "status" | "plan" | "billingSource"): Promise<Array<{ key: string; count: number }>> {
  const col = column === "status" ? subscriptionsTable.status : column === "plan" ? subscriptionsTable.plan : subscriptionsTable.billingSource;
  const rows = await db.select({ key: col, count: count() }).from(subscriptionsTable).groupBy(col);
  return rows.map((r) => ({ key: r.key, count: Number(r.count) }));
}

export async function countTrialsExpiringWithin(days: number, now = new Date()): Promise<number> {
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const [{ n }] = await db
    .select({ n: count() })
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.status, "trialing"), isNotNull(subscriptionsTable.trialExpiresAt), gt(subscriptionsTable.trialExpiresAt, now), lte(subscriptionsTable.trialExpiresAt, until)));
  return Number(n);
}

// Sweep candidates: elapsed MANUAL trials. Locked with SKIP LOCKED so two
// concurrent sweeps (two processes / duplicate delivery) never double-process.
export async function lockElapsedManualTrials(now: Date, limit: number, tx: Executor): Promise<SubscriptionRow[]> {
  return tx
    .select()
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.billingSource, "manual"), eq(subscriptionsTable.status, "trialing"), isNotNull(subscriptionsTable.trialExpiresAt), lte(subscriptionsTable.trialExpiresAt, now)))
    .orderBy(asc(subscriptionsTable.id))
    .limit(limit)
    .for("update", { skipLocked: true });
}

// Stripe-managed subscriptions that still carry an ACTIVE-looking local state
// (used by platform diagnostics only).
export async function listStripeManaged(limit: number): Promise<SubscriptionRow[]> {
  return db.select().from(subscriptionsTable).where(eq(subscriptionsTable.billingSource, "stripe")).orderBy(asc(subscriptionsTable.id)).limit(limit);
}

// ── companies (legacy mirror + reads needed by the services) ─────────────────

export async function findCompany(id: number, tx?: Executor): Promise<CompanyRow | undefined> {
  const [row] = await exec(tx).select().from(companiesTable).where(eq(companiesTable.id, id)).limit(1);
  return row;
}

// Writes the DEPRECATED compatibility mirror. Only the subscription services call
// this, always inside the same transaction as the canonical change.
export async function writeCompanyMirror(
  companyId: number,
  mirror: { plan: string; status: string; trialEndsAt: Date | null },
  tx: Executor,
): Promise<void> {
  await tx.update(companiesTable).set({ plan: mirror.plan, status: mirror.status, trialEndsAt: mirror.trialEndsAt, updatedAt: new Date() }).where(eq(companiesTable.id, companyId));
}

export async function companiesWithoutSubscription(tx?: Executor): Promise<CompanyRow[]> {
  return exec(tx)
    .select({ c: companiesTable })
    .from(companiesTable)
    .leftJoin(subscriptionsTable, eq(subscriptionsTable.companyId, companiesTable.id))
    .where(isNull(subscriptionsTable.id))
    .orderBy(asc(companiesTable.id))
    .then((rows) => rows.map((r) => r.c));
}

export async function allSubscriptionsWithCompanies(tx?: Executor): Promise<Array<{ s: SubscriptionRow; c: CompanyRow }>> {
  return exec(tx).select({ s: subscriptionsTable, c: companiesTable }).from(subscriptionsTable).innerJoin(companiesTable, eq(companiesTable.id, subscriptionsTable.companyId)).orderBy(asc(subscriptionsTable.id));
}

// ── plans / prices ───────────────────────────────────────────────────────────

export async function findPlanById(id: string, tx?: Executor): Promise<PlanRow | undefined> {
  const [plan] = await exec(tx).select().from(plansTable).where(eq(plansTable.id, id)).limit(1);
  return plan;
}

export async function listPlans(activeOnly: boolean, tx?: Executor): Promise<PlanRow[]> {
  return exec(tx)
    .select()
    .from(plansTable)
    .where(activeOnly ? eq(plansTable.isActive, true) : undefined)
    .orderBy(asc(plansTable.sortOrder), asc(plansTable.id));
}

export async function listPlanPrices(opts: { planId?: string; activeOnly?: boolean } = {}, tx?: Executor): Promise<PlanPriceRow[]> {
  const conds: SQL[] = [];
  if (opts.planId) conds.push(eq(planPricesTable.planId, opts.planId));
  if (opts.activeOnly) conds.push(eq(planPricesTable.active, true));
  return exec(tx)
    .select()
    .from(planPricesTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(planPricesTable.planId), asc(planPricesTable.id));
}

export async function findPlanPriceById(id: number, tx?: Executor): Promise<PlanPriceRow | undefined> {
  const [row] = await exec(tx).select().from(planPricesTable).where(eq(planPricesTable.id, id)).limit(1);
  return row;
}

export async function findPlanPriceByProviderId(providerPriceId: string, tx?: Executor): Promise<PlanPriceRow | undefined> {
  const [row] = await exec(tx).select().from(planPricesTable).where(eq(planPricesTable.providerPriceId, providerPriceId)).limit(1);
  return row;
}

export async function insertPlanPrice(values: typeof planPricesTable.$inferInsert, tx?: Executor): Promise<PlanPriceRow> {
  const [row] = await exec(tx).insert(planPricesTable).values(values).returning();
  return row;
}

export async function updatePlanPrice(id: number, data: Partial<typeof planPricesTable.$inferInsert>, tx?: Executor): Promise<PlanPriceRow | undefined> {
  const [row] = await exec(tx)
    .update(planPricesTable)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(planPricesTable.id, id))
    .returning();
  return row;
}

// ── checkout sessions ────────────────────────────────────────────────────────

export async function insertCheckoutSession(values: typeof billingCheckoutSessionsTable.$inferInsert, tx?: Executor): Promise<CheckoutSessionRow> {
  const [row] = await exec(tx).insert(billingCheckoutSessionsTable).values(values).returning();
  return row;
}

export async function findCheckoutSessionByProviderId(providerSessionId: string, tx?: Executor): Promise<CheckoutSessionRow | undefined> {
  const [row] = await exec(tx).select().from(billingCheckoutSessionsTable).where(eq(billingCheckoutSessionsTable.providerSessionId, providerSessionId)).limit(1);
  return row;
}

export async function findOpenCheckoutSession(companyId: number, now: Date, tx?: Executor): Promise<CheckoutSessionRow | undefined> {
  const [row] = await exec(tx)
    .select()
    .from(billingCheckoutSessionsTable)
    .where(and(eq(billingCheckoutSessionsTable.companyId, companyId), eq(billingCheckoutSessionsTable.status, "created"), or(isNull(billingCheckoutSessionsTable.expiresAt), gt(billingCheckoutSessionsTable.expiresAt, now))))
    .orderBy(desc(billingCheckoutSessionsTable.id))
    .limit(1);
  return row;
}

export async function updateCheckoutSession(id: number, data: Partial<typeof billingCheckoutSessionsTable.$inferInsert>, tx?: Executor): Promise<void> {
  await exec(tx)
    .update(billingCheckoutSessionsTable)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(billingCheckoutSessionsTable.id, id));
}

export async function expireOpenCheckoutSessions(companyId: number, exceptId: number | null, tx?: Executor): Promise<void> {
  await exec(tx)
    .update(billingCheckoutSessionsTable)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(eq(billingCheckoutSessionsTable.companyId, companyId), eq(billingCheckoutSessionsTable.status, "created"), exceptId == null ? undefined : ne(billingCheckoutSessionsTable.id, exceptId)));
}

// ── provider events ──────────────────────────────────────────────────────────

export async function findProviderEvent(eventId: string, tx?: Executor): Promise<ProviderEventRow | undefined> {
  const [row] = await exec(tx).select().from(billingProviderEventsTable).where(eq(billingProviderEventsTable.eventId, eventId)).limit(1);
  return row;
}

// Row lock on an existing event (retry of a failed delivery).
export async function lockProviderEvent(eventId: string, tx: Executor): Promise<ProviderEventRow | undefined> {
  const [row] = await tx.select().from(billingProviderEventsTable).where(eq(billingProviderEventsTable.eventId, eventId)).for("update");
  return row;
}

export async function insertProviderEvent(values: typeof billingProviderEventsTable.$inferInsert, tx?: Executor): Promise<ProviderEventRow> {
  const [row] = await exec(tx).insert(billingProviderEventsTable).values(values).returning();
  return row;
}

export async function updateProviderEvent(id: number, data: Partial<typeof billingProviderEventsTable.$inferInsert>, tx?: Executor): Promise<void> {
  await exec(tx).update(billingProviderEventsTable).set(data).where(eq(billingProviderEventsTable.id, id));
}

export async function listProviderEvents(opts: { companyId?: number; limit: number }): Promise<ProviderEventRow[]> {
  return db
    .select()
    .from(billingProviderEventsTable)
    .where(opts.companyId != null ? eq(billingProviderEventsTable.companyId, opts.companyId) : undefined)
    .orderBy(desc(billingProviderEventsTable.id))
    .limit(opts.limit);
}

// ── usage reservations ───────────────────────────────────────────────────────

export async function findReservationByKey(key: string, tx?: Executor): Promise<ReservationRow | undefined> {
  const [row] = await exec(tx).select().from(subscriptionUsageReservationsTable).where(eq(subscriptionUsageReservationsTable.idempotencyKey, key)).limit(1);
  return row;
}

export async function insertReservation(values: typeof subscriptionUsageReservationsTable.$inferInsert, tx?: Executor): Promise<ReservationRow> {
  const [row] = await exec(tx).insert(subscriptionUsageReservationsTable).values(values).returning();
  return row;
}

export async function updateReservation(id: number, data: Partial<typeof subscriptionUsageReservationsTable.$inferInsert>, tx?: Executor): Promise<ReservationRow | undefined> {
  const [row] = await exec(tx).update(subscriptionUsageReservationsTable).set(data).where(eq(subscriptionUsageReservationsTable.id, id)).returning();
  return row;
}

export async function deleteReservationsForCompany(companyId: number, tx?: Executor): Promise<void> {
  await exec(tx).delete(subscriptionUsageReservationsTable).where(eq(subscriptionUsageReservationsTable.companyId, companyId));
}

// ── usage counts (the single calculation used by enforcement AND display) ────

export async function countContacts(companyId: number, tx?: Executor): Promise<number> {
  const [{ n }] = await exec(tx)
    .select({ n: count() })
    .from(contactsTable)
    .where(and(eq(contactsTable.companyId, companyId), isNull(contactsTable.deletedAt), isNull(contactsTable.duplicateOfId)));
  return Number(n);
}

export async function countEvents(companyId: number, tx?: Executor): Promise<number> {
  const [{ n }] = await exec(tx).select({ n: count() }).from(eventsTable).where(and(eq(eventsTable.companyId, companyId), isNull(eventsTable.deletedAt)));
  return Number(n);
}

// Active, not-deleted users by role family. Legacy role aliases are counted with
// their canonical family (company_admin → admin family, team_member → employee).
const ADMIN_ROLES = ["admin", "primary_admin", "company_admin"];
const EMPLOYEE_ROLES = ["employee", "team_member"];

export async function countUsersByFamily(companyId: number, family: "admins" | "employees", tx?: Executor): Promise<number> {
  const roles = family === "admins" ? ADMIN_ROLES : EMPLOYEE_ROLES;
  const [{ n }] = await exec(tx)
    .select({ n: count() })
    .from(usersTable)
    .where(and(eq(usersTable.companyId, companyId), isNull(usersTable.deletedAt), inArray(usersTable.role, roles)));
  return Number(n);
}

export async function countPendingInvitationsByFamily(companyId: number, family: "admins" | "employees", now: Date, excludeId: number | null, tx?: Executor): Promise<number> {
  const roles = family === "admins" ? ADMIN_ROLES : EMPLOYEE_ROLES;
  const conds: SQL[] = [eq(invitationsTable.companyId, companyId), eq(invitationsTable.status, "pending"), gt(invitationsTable.expiresAt, now), inArray(invitationsTable.role, roles)];
  if (excludeId != null) conds.push(ne(invitationsTable.id, excludeId));
  const [{ n }] = await exec(tx).select({ n: count() }).from(invitationsTable).where(and(...conds));
  return Number(n);
}

// Scans consumed in a window: OCR scans (processing/completed, not the synthetic
// "manual" interaction rows written on contact creation) plus counted reservations
// without a linked scan row (batch-analysis items). Pending reservations count only
// while unexpired.
export async function countScansInWindow(companyId: number, startsAt: Date, endsAt: Date, now: Date, tx?: Executor): Promise<{ scans: number; reservations: number }> {
  const e = exec(tx);
  const [{ n: scans }] = await e
    .select({ n: count() })
    .from(scansTable)
    .where(
      and(
        eq(scansTable.companyId, companyId),
        isNull(scansTable.deletedAt),
        inArray(scansTable.status, ["processing", "completed"]),
        or(isNull(scansTable.extractionMethod), ne(scansTable.extractionMethod, "manual")),
        gte(scansTable.createdAt, startsAt),
        lt(scansTable.createdAt, endsAt),
      ),
    );
  const [{ q }] = await e
    .select({ q: sql<number>`coalesce(sum(${subscriptionUsageReservationsTable.quantity}), 0)` })
    .from(subscriptionUsageReservationsTable)
    .where(
      and(
        eq(subscriptionUsageReservationsTable.companyId, companyId),
        eq(subscriptionUsageReservationsTable.resource, "scans"),
        isNull(subscriptionUsageReservationsTable.scanId),
        gte(subscriptionUsageReservationsTable.createdAt, startsAt),
        lt(subscriptionUsageReservationsTable.createdAt, endsAt),
        or(
          eq(subscriptionUsageReservationsTable.status, "consumed"),
          and(eq(subscriptionUsageReservationsTable.status, "pending"), gt(subscriptionUsageReservationsTable.expiresAt, now)),
        ),
      ),
    );
  return { scans: Number(scans), reservations: Number(q) };
}

// Serializes limit checks per tenant+resource for the rest of the transaction.
export async function acquireUsageLock(companyId: number, resource: string, tx: Executor): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`b20:${companyId}:${resource}`}))`);
}

export async function dailyScanCounts(days: number, now = new Date()): Promise<Array<{ date: string; value: number }>> {
  const since = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  since.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .select({ day: sql<string>`to_char(date_trunc('day', ${scansTable.createdAt}), 'YYYY-MM-DD')`, n: count() })
    .from(scansTable)
    .where(and(gte(scansTable.createdAt, since), isNull(scansTable.deletedAt), or(isNull(scansTable.extractionMethod), ne(scansTable.extractionMethod, "manual"))))
    .groupBy(sql`date_trunc('day', ${scansTable.createdAt})`);
  const byDay = new Map(rows.map((r) => [r.day, Number(r.n)]));
  const out: Array<{ date: string; value: number }> = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, value: byDay.get(key) ?? 0 });
  }
  return out;
}
