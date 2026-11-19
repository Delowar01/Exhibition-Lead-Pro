import {
  db,
  companiesTable,
  usersTable,
  scansTable,
  contactsTable,
  leadsTable,
  loginAttemptsTable,
  auditLogsTable,
  securityEventsTable,
  billingProviderEventsTable,
  billingCheckoutSessionsTable,
  subscriptionsTable,
  jobQueueTable,
} from "@workspace/db";
import { and, count, desc, eq, gte, inArray, isNull, lt, ne, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Granularity } from "../lib/analytics-window.js";
import { TENANT_USER, LIVE_CAPTURE, OCR_CARD_SCAN } from "./platform-definitions.js";

// G-7 — Platform Owner Analytics: read-only aggregates.
//
// Platform-owner-only by construction (the routes sit behind requireRole("platform_owner")),
// so — like platform.repository.ts — these queries intentionally span ALL companies and apply
// no tenant scope. They return COUNTS, SUMS and company ids/names only: never a contact, lead,
// scan payload, user e-mail, audit metadata or any other tenant record. Nothing here writes.

export interface Span {
  start: Date;
  endExclusive: Date;
}

function within(col: PgColumn, s: Span): SQL {
  return and(gte(col, s.start), lt(col, s.endExclusive))!;
}

// date_trunc on the stored UTC wall-clock value; the unit is a closed union, never user text.
function bucketOf(col: PgColumn, g: Granularity): SQL<string> {
  const unit = g === "month" ? "month" : g === "week" ? "week" : "day";
  return sql<string>`to_char(date_trunc(${sql.raw(`'${unit}'`)}, ${col}), 'YYYY-MM-DD')`;
}

const n = (v: unknown): number => Number(v ?? 0);

// Captures, card scans and users follow the platform's shared definitions
// (platform-definitions.ts), the same ones the Platform Dashboard uses.
const REAL_SCAN: SQL = OCR_CARD_SCAN;
const LIVE_CONTACT: SQL = isNull(contactsTable.deletedAt);
const LIVE_LEAD: SQL = isNull(leadsTable.deletedAt);

// ── companies and users (creation dates of the rows that exist today) ─────────
export async function countCompaniesCreated(s: Span): Promise<number> {
  const [r] = await db.select({ c: count() }).from(companiesTable).where(within(companiesTable.createdAt, s));
  return n(r?.c);
}
export async function countCompaniesCreatedBefore(end: Date): Promise<number> {
  const [r] = await db.select({ c: count() }).from(companiesTable).where(lt(companiesTable.createdAt, end));
  return n(r?.c);
}
export async function companiesCreatedSeries(s: Span, g: Granularity): Promise<Array<{ bucket: string; value: number }>> {
  const b = bucketOf(companiesTable.createdAt, g);
  const rows = await db.select({ bucket: b, c: count() }).from(companiesTable).where(within(companiesTable.createdAt, s)).groupBy(b);
  return rows.map((r) => ({ bucket: r.bucket, value: n(r.c) }));
}
export async function countUsersCreated(s: Span): Promise<number> {
  const [r] = await db.select({ c: count() }).from(usersTable).where(and(TENANT_USER, within(usersTable.createdAt, s)));
  return n(r?.c);
}
export async function countUsersCreatedBefore(end: Date): Promise<number> {
  const [r] = await db.select({ c: count() }).from(usersTable).where(and(TENANT_USER, lt(usersTable.createdAt, end)));
  return n(r?.c);
}
export async function usersCreatedSeries(s: Span, g: Granularity): Promise<Array<{ bucket: string; value: number }>> {
  const b = bucketOf(usersTable.createdAt, g);
  const rows = await db.select({ bucket: b, c: count() }).from(usersTable).where(and(TENANT_USER, within(usersTable.createdAt, s))).groupBy(b);
  return rows.map((r) => ({ bucket: r.bucket, value: n(r.c) }));
}

// ── capture activity (counts only) ───────────────────────────────────────────
export async function countScans(s: Span): Promise<number> {
  const [r] = await db.select({ c: count() }).from(scansTable).where(and(REAL_SCAN, within(scansTable.createdAt, s)));
  return n(r?.c);
}
export async function countCaptures(s: Span): Promise<number> {
  const [r] = await db.select({ c: count() }).from(scansTable).where(and(LIVE_CAPTURE, within(scansTable.createdAt, s)));
  return n(r?.c);
}
export async function countContacts(s: Span): Promise<number> {
  const [r] = await db.select({ c: count() }).from(contactsTable).where(and(LIVE_CONTACT, within(contactsTable.createdAt, s)));
  return n(r?.c);
}
export async function countLeads(s: Span): Promise<number> {
  const [r] = await db.select({ c: count() }).from(leadsTable).where(and(LIVE_LEAD, within(leadsTable.createdAt, s)));
  return n(r?.c);
}
export async function scansSeries(s: Span, g: Granularity): Promise<Array<{ bucket: string; value: number }>> {
  const b = bucketOf(scansTable.createdAt, g);
  const rows = await db.select({ bucket: b, c: count() }).from(scansTable).where(and(REAL_SCAN, within(scansTable.createdAt, s))).groupBy(b);
  return rows.map((r) => ({ bucket: r.bucket, value: n(r.c) }));
}
export async function contactsSeries(s: Span, g: Granularity): Promise<Array<{ bucket: string; value: number }>> {
  const b = bucketOf(contactsTable.createdAt, g);
  const rows = await db.select({ bucket: b, c: count() }).from(contactsTable).where(and(LIVE_CONTACT, within(contactsTable.createdAt, s))).groupBy(b);
  return rows.map((r) => ({ bucket: r.bucket, value: n(r.c) }));
}
export async function leadsSeries(s: Span, g: Granularity): Promise<Array<{ bucket: string; value: number }>> {
  const b = bucketOf(leadsTable.createdAt, g);
  const rows = await db.select({ bucket: b, c: count() }).from(leadsTable).where(and(LIVE_LEAD, within(leadsTable.createdAt, s))).groupBy(b);
  return rows.map((r) => ({ bucket: r.bucket, value: n(r.c) }));
}
// Every capture by where it came from (camera, qr, vcard, digital_card, email_signature, nfc,
// manual). The values are a closed set written by the API; a row without one is reported
// as "unknown". (A file import creates contacts and writes no capture row.)
export async function capturesBySource(s: Span): Promise<Array<{ source: string; count: number }>> {
  const source = sql<string>`coalesce(${scansTable.captureSource}, 'unknown')`;
  const rows = await db.select({ source, c: count() }).from(scansTable).where(and(LIVE_CAPTURE, within(scansTable.createdAt, s))).groupBy(source).orderBy(desc(count()), source);
  return rows.map((r) => ({ source: r.source, count: n(r.c) }));
}
export async function scansByStatus(s: Span): Promise<Array<{ status: string; count: number }>> {
  const rows = await db
    .select({ status: scansTable.status, c: count() })
    .from(scansTable)
    .where(and(REAL_SCAN, within(scansTable.createdAt, s)))
    .groupBy(scansTable.status)
    .orderBy(desc(count()), scansTable.status);
  return rows.map((r) => ({ status: r.status, count: n(r.c) }));
}

async function perCompany(table: typeof scansTable | typeof contactsTable | typeof leadsTable, live: SQL, s: Span): Promise<Map<number, number>> {
  const rows = await db.select({ companyId: table.companyId, c: count() }).from(table).where(and(live, within(table.createdAt, s))).groupBy(table.companyId);
  return new Map(rows.map((r) => [r.companyId, n(r.c)]));
}

// Per-company volumes in the window. One grouped query per source; the result has at most
// one entry per company, so merging in memory is bounded by the number of tenants.
export async function activityByCompany(s: Span): Promise<Map<number, { scans: number; contacts: number; leads: number }>> {
  const [scans, contacts, leads] = await Promise.all([perCompany(scansTable, REAL_SCAN, s), perCompany(contactsTable, LIVE_CONTACT, s), perCompany(leadsTable, LIVE_LEAD, s)]);
  const out = new Map<number, { scans: number; contacts: number; leads: number }>();
  const touch = (id: number) => {
    let v = out.get(id);
    if (!v) {
      v = { scans: 0, contacts: 0, leads: 0 };
      out.set(id, v);
    }
    return v;
  };
  for (const [id, c] of scans) touch(id).scans = c;
  for (const [id, c] of contacts) touch(id).contacts = c;
  for (const [id, c] of leads) touch(id).leads = c;
  return out;
}
export async function companyNames(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(inArray(companiesTable.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ── sign-ins (counts only — never the e-mail or address of an attempt) ───────
// `successful` and `failed` count every attempt on the platform. `activeUsers` counts the
// distinct USERS who signed in, with "user" meaning what it means everywhere else on the
// platform's reports (TENANT_USER): an account that still exists and is not a platform
// operator. A sign-in by an account that was deleted afterwards, or by the operator, stays
// in the attempt counts but adds no active user.
//
// Active users are counted from the users side with a semi-join on the window's successful
// sign-ins: one pass over each table. (Asking "is this a company user?" once per sign-in row
// costs one index probe per row — measured at 1.6 s against 0.28 s for a one-year window of
// a three-million-row table.)
// The two statements run one after the other so the unit never holds two connections.
export async function signInCounts(s: Span): Promise<{ successful: number; failed: number; activeUsers: number }> {
  const [r] = await db
    .select({
      successful: sql<number>`count(*) filter (where ${loginAttemptsTable.success})`,
      failed: sql<number>`count(*) filter (where not ${loginAttemptsTable.success})`,
    })
    .from(loginAttemptsTable)
    .where(within(loginAttemptsTable.createdAt, s));
  const signedIn = db
    .select({ userId: loginAttemptsTable.userId })
    .from(loginAttemptsTable)
    .where(and(eq(loginAttemptsTable.success, true), within(loginAttemptsTable.createdAt, s)));
  const [a] = await db.select({ c: count() }).from(usersTable).where(and(TENANT_USER, inArray(usersTable.id, signedIn)));
  return { successful: n(r?.successful), failed: n(r?.failed), activeUsers: n(a?.c) };
}
export async function signInSeries(s: Span, g: Granularity): Promise<Array<{ bucket: string; successful: number; failed: number }>> {
  const b = bucketOf(loginAttemptsTable.createdAt, g);
  const rows = await db
    .select({
      bucket: b,
      successful: sql<number>`count(*) filter (where ${loginAttemptsTable.success})`,
      failed: sql<number>`count(*) filter (where not ${loginAttemptsTable.success})`,
    })
    .from(loginAttemptsTable)
    .where(within(loginAttemptsTable.createdAt, s))
    .groupBy(b);
  return rows.map((r) => ({ bucket: r.bucket, successful: n(r.successful), failed: n(r.failed) }));
}

// ── audit trail (action names only — never metadata, actor names or addresses) ─
export async function countAuditEvents(s: Span): Promise<number> {
  const [r] = await db.select({ c: count() }).from(auditLogsTable).where(within(auditLogsTable.createdAt, s));
  return n(r?.c);
}
export async function auditByCategory(s: Span, limit: number): Promise<Array<{ category: string; count: number }>> {
  const category = sql<string>`split_part(${auditLogsTable.action}, '.', 1)`;
  const rows = await db.select({ category, c: count() }).from(auditLogsTable).where(within(auditLogsTable.createdAt, s)).groupBy(category).orderBy(desc(count()), category).limit(limit);
  return rows.map((r) => ({ category: r.category, count: n(r.c) }));
}
export async function auditSeries(s: Span, g: Granularity): Promise<Array<{ bucket: string; value: number }>> {
  const b = bucketOf(auditLogsTable.createdAt, g);
  const rows = await db.select({ bucket: b, c: count() }).from(auditLogsTable).where(within(auditLogsTable.createdAt, s)).groupBy(b);
  return rows.map((r) => ({ bucket: r.bucket, value: n(r.c) }));
}

// ── subscription lifecycle, derived from the audit trail ─────────────────────
// Every lifecycle change writes one audit row with the before/after status and plan
// (lib/billing/audit.ts). A transition INTO a status is a row whose after-status differs
// from its before-status; a new subscription counts as entering its first status.
// "subscription.repair_create" is a data repair for companies that lacked a row, not a
// business event, and is left out.
const beforeStatus = sql`${auditLogsTable.metadata}->'before'->>'status'`;
const afterStatus = sql`${auditLogsTable.metadata}->'after'->>'status'`;
const beforePlan = sql`${auditLogsTable.metadata}->'before'->>'plan'`;
const afterPlan = sql`${auditLogsTable.metadata}->'after'->>'plan'`;
const LIFECYCLE_ROW: SQL = and(eq(auditLogsTable.entityType, "subscription"), sql`${auditLogsTable.action} like 'subscription.%'`, ne(auditLogsTable.action, "subscription.repair_create"))!;
const entered = (status: string) => sql<number>`count(*) filter (where ${afterStatus} = ${status} and ${beforeStatus} is distinct from ${afterStatus})`;
const LIFECYCLE = {
  created: sql<number>`count(*) filter (where ${auditLogsTable.action} = 'subscription.create')`,
  toTrialing: entered("trialing"),
  toActive: entered("active"),
  toPastDue: entered("past_due"),
  toCancelled: entered("cancelled"),
  toExpired: entered("expired"),
  toSuspended: entered("suspended"),
  planChanges: sql<number>`count(*) filter (where ${beforePlan} is not null and ${afterPlan} is not null and ${beforePlan} <> ${afterPlan})`,
};
export interface LifecycleCounts {
  created: number;
  toTrialing: number;
  toActive: number;
  toPastDue: number;
  toCancelled: number;
  toExpired: number;
  toSuspended: number;
  planChanges: number;
}
export const ZERO_LIFECYCLE: LifecycleCounts = { created: 0, toTrialing: 0, toActive: 0, toPastDue: 0, toCancelled: 0, toExpired: 0, toSuspended: 0, planChanges: 0 };
function lifecycleOf(r: Record<string, unknown> | undefined): LifecycleCounts {
  return {
    created: n(r?.created),
    toTrialing: n(r?.toTrialing),
    toActive: n(r?.toActive),
    toPastDue: n(r?.toPastDue),
    toCancelled: n(r?.toCancelled),
    toExpired: n(r?.toExpired),
    toSuspended: n(r?.toSuspended),
    planChanges: n(r?.planChanges),
  };
}
export async function lifecycleTotals(s: Span): Promise<LifecycleCounts> {
  const [r] = await db.select(LIFECYCLE).from(auditLogsTable).where(and(LIFECYCLE_ROW, within(auditLogsTable.createdAt, s)));
  return lifecycleOf(r);
}
export async function lifecycleSeries(s: Span, g: Granularity): Promise<Array<{ bucket: string } & LifecycleCounts>> {
  const b = bucketOf(auditLogsTable.createdAt, g);
  const rows = await db
    .select({ bucket: b, ...LIFECYCLE })
    .from(auditLogsTable)
    .where(and(LIFECYCLE_ROW, within(auditLogsTable.createdAt, s)))
    .groupBy(b);
  return rows.map((r) => ({ bucket: r.bucket, ...lifecycleOf(r) }));
}
export async function planMoves(s: Span, limit: number): Promise<Array<{ fromPlan: string; toPlan: string; count: number }>> {
  const fromPlan = sql<string>`${beforePlan}`;
  const toPlan = sql<string>`${afterPlan}`;
  const rows = await db
    .select({ fromPlan, toPlan, c: count() })
    .from(auditLogsTable)
    .where(and(LIFECYCLE_ROW, within(auditLogsTable.createdAt, s), sql`${beforePlan} is not null and ${afterPlan} is not null and ${beforePlan} <> ${afterPlan}`))
    .groupBy(fromPlan, toPlan)
    .orderBy(desc(count()), fromPlan, toPlan)
    .limit(limit);
  return rows.map((r) => ({ fromPlan: r.fromPlan, toPlan: r.toPlan, count: n(r.c) }));
}

// ── security events (type names only) ────────────────────────────────────────
export async function countSecurityEvents(s: Span): Promise<number> {
  const [r] = await db.select({ c: count() }).from(securityEventsTable).where(within(securityEventsTable.createdAt, s));
  return n(r?.c);
}
export async function securityByType(s: Span, limit: number): Promise<Array<{ type: string; count: number }>> {
  const rows = await db
    .select({ type: securityEventsTable.type, c: count() })
    .from(securityEventsTable)
    .where(within(securityEventsTable.createdAt, s))
    .groupBy(securityEventsTable.type)
    .orderBy(desc(count()), securityEventsTable.type)
    .limit(limit);
  return rows.map((r) => ({ type: r.type, count: n(r.c) }));
}

// ── billing provider notifications (the ledger of received events; no amounts exist) ──
// A payment notification counts as an ACTUAL payment event only when it was processed for a
// known subscription — unbound, mismatched and failed deliveries are not payments.
const PAYMENT_BOUND = sql`${billingProviderEventsTable.status} = 'processed' and ${billingProviderEventsTable.companyId} is not null`;
const PAID = sql<number>`count(*) filter (where ${billingProviderEventsTable.eventType} = 'invoice.paid' and ${PAYMENT_BOUND})`;
const PAYMENT_FAILED = sql<number>`count(*) filter (where ${billingProviderEventsTable.eventType} = 'invoice.payment_failed' and ${PAYMENT_BOUND})`;
export async function providerEventCounts(s: Span): Promise<{ total: number; failed: number; paid: number; paymentFailed: number }> {
  const [r] = await db
    .select({
      total: count(),
      failed: sql<number>`count(*) filter (where ${billingProviderEventsTable.status} = 'failed')`,
      paid: PAID,
      paymentFailed: PAYMENT_FAILED,
    })
    .from(billingProviderEventsTable)
    .where(within(billingProviderEventsTable.receivedAt, s));
  return { total: n(r?.total), failed: n(r?.failed), paid: n(r?.paid), paymentFailed: n(r?.paymentFailed) };
}
export async function paymentEventSeries(s: Span, g: Granularity): Promise<Array<{ bucket: string; paid: number; failed: number }>> {
  const b = bucketOf(billingProviderEventsTable.receivedAt, g);
  const rows = await db.select({ bucket: b, paid: PAID, failed: PAYMENT_FAILED }).from(billingProviderEventsTable).where(within(billingProviderEventsTable.receivedAt, s)).groupBy(b);
  return rows.map((r) => ({ bucket: r.bucket, paid: n(r.paid), failed: n(r.failed) }));
}
export async function providerEventsByType(s: Span, limit: number): Promise<Array<{ eventType: string; count: number }>> {
  const rows = await db
    .select({ eventType: billingProviderEventsTable.eventType, c: count() })
    .from(billingProviderEventsTable)
    .where(within(billingProviderEventsTable.receivedAt, s))
    .groupBy(billingProviderEventsTable.eventType)
    .orderBy(desc(count()), billingProviderEventsTable.eventType)
    .limit(limit);
  return rows.map((r) => ({ eventType: r.eventType, count: n(r.c) }));
}
export async function providerEventsByOutcome(s: Span): Promise<Array<{ outcome: string; count: number }>> {
  // A row that has no outcome yet (still "received", or "failed") is reported by its status.
  const outcome = sql<string>`coalesce(${billingProviderEventsTable.outcome}, ${billingProviderEventsTable.status})`;
  const rows = await db.select({ outcome, c: count() }).from(billingProviderEventsTable).where(within(billingProviderEventsTable.receivedAt, s)).groupBy(outcome).orderBy(desc(count()), outcome);
  return rows.map((r) => ({ outcome: r.outcome, count: n(r.c) }));
}

// ── self-service checkout sessions started in the window, by their current state ──
export async function checkoutCounts(s: Span): Promise<{ started: number; completed: number; expired: number; failed: number; open: number }> {
  const st = billingCheckoutSessionsTable.status;
  const [r] = await db
    .select({
      started: count(),
      completed: sql<number>`count(*) filter (where ${st} = 'completed')`,
      expired: sql<number>`count(*) filter (where ${st} = 'expired')`,
      failed: sql<number>`count(*) filter (where ${st} = 'failed')`,
      open: sql<number>`count(*) filter (where ${st} in ('creating','open'))`,
    })
    .from(billingCheckoutSessionsTable)
    .where(within(billingCheckoutSessionsTable.createdAt, s));
  return { started: n(r?.started), completed: n(r?.completed), expired: n(r?.expired), failed: n(r?.failed), open: n(r?.open) };
}

// ── subscriptions as of now, by billing source ───────────────────────────────
export async function subscriptionsByBillingSource(): Promise<Array<{ billingSource: string; total: number; fullAccess: number }>> {
  const rows = await db
    .select({
      billingSource: subscriptionsTable.billingSource,
      total: count(),
      fullAccess: sql<number>`count(*) filter (where ${subscriptionsTable.status} in ('active','trialing'))`,
    })
    .from(subscriptionsTable)
    .groupBy(subscriptionsTable.billingSource)
    .orderBy(subscriptionsTable.billingSource);
  return rows.map((r) => ({ billingSource: r.billingSource, total: n(r.total), fullAccess: n(r.fullAccess) }));
}

// ── background job queue as of now (status counts only — never a payload) ────
export async function jobQueueSnapshot(): Promise<{ pending: number; running: number; dead: number }> {
  const st = jobQueueTable.status;
  const [r] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${st} = 'pending')`,
      running: sql<number>`count(*) filter (where ${st} = 'running')`,
      dead: sql<number>`count(*) filter (where ${st} = 'dead')`,
    })
    .from(jobQueueTable);
  return { pending: n(r?.pending), running: n(r?.running), dead: n(r?.dead) };
}
