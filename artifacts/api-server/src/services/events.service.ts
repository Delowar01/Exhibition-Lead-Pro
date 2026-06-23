import { db } from "@workspace/db";
import { eventsTable, contactsTable, leadsTable } from "@workspace/db";
import { eq, ilike, and, count, inArray, isNull, sum } from "drizzle-orm";
import { AppError } from "../middlewares/errorHandler.js";
import { canAccessCompany, type AuthUser } from "../middlewares/requireAuth.js";

// Per-event aggregate counts surfaced alongside each event record. Kept here so
// list/detail/mutation responses stay shaped identically.
async function enrichEvent(e: typeof eventsTable.$inferSelect) {
  const [contactCount] = await db.select({ count: count() }).from(contactsTable).where(and(eq(contactsTable.eventId, e.id), isNull(contactsTable.duplicateOfId)));
  const [leadCount] = await db.select({ count: count() }).from(leadsTable).where(eq(leadsTable.eventId, e.id));
  return { ...e, contactCount: contactCount.count, leadCount: leadCount.count };
}

export interface ListEventsParams {
  search?: string;
  page?: string;
  limit?: string;
}

export async function listEvents(user: AuthUser, params: ListEventsParams) {
  const { search, page = "1", limit = "20" } = params;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit));
  const offset = (pageNum - 1) * limitNum;
  const conditions = [];
  if (user.role !== "platform_owner") conditions.push(inArray(eventsTable.companyId, user.accessibleCompanies));
  if (search) conditions.push(ilike(eventsTable.name, `%${search}%`));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [{ total }] = await db.select({ total: count() }).from(eventsTable).where(whereClause);
  const events = await db.select().from(eventsTable).where(whereClause).limit(limitNum).offset(offset).orderBy(eventsTable.createdAt);
  const enriched = await Promise.all(events.map(enrichEvent));
  return { events: enriched, total, page: pageNum, limit: limitNum };
}

export interface EventInput {
  name?: string;
  venue?: string;
  country?: string;
  startDate?: string;
  endDate?: string;
  boothNumber?: string;
  description?: string;
  status?: string;
}

export async function createEvent(user: AuthUser, input: EventInput) {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const { name, venue, country, startDate, endDate, boothNumber, description, status } = input;
  if (!name) throw new AppError(400, "name required");
  const [event] = await db.insert(eventsTable).values({ companyId, name, venue, country: country ?? null, startDate: startDate ?? null, endDate: endDate ?? null, boothNumber, description, status: status ?? "active" }).returning();
  return await enrichEvent(event);
}

export async function getEvent(user: AuthUser, id: number) {
  const [e] = await db.select().from(eventsTable).where(eq(eventsTable.id, id)).limit(1);
  if (!e || !canAccessCompany(user, e.companyId)) throw new AppError(404, "Event not found");
  return await enrichEvent(e);
}

export async function updateEvent(user: AuthUser, id: number, input: EventInput) {
  const [existing] = await db.select({ companyId: eventsTable.companyId }).from(eventsTable).where(eq(eventsTable.id, id)).limit(1);
  if (!existing || !canAccessCompany(user, existing.companyId)) throw new AppError(404, "Event not found");
  const { name, venue, country, startDate, endDate, boothNumber, description, status } = input;
  const updateData: Record<string, unknown> = { name, venue, country, startDate, endDate, boothNumber, description, status };
  Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
  if (Object.keys(updateData).length === 0) throw new AppError(400, "No valid fields to update");
  const [e] = await db.update(eventsTable).set(updateData as Partial<typeof eventsTable.$inferInsert>).where(eq(eventsTable.id, id)).returning();
  if (!e) throw new AppError(404, "Event not found");
  return await enrichEvent(e);
}

export async function deleteEvent(user: AuthUser, id: number) {
  const [existing] = await db.select({ companyId: eventsTable.companyId }).from(eventsTable).where(eq(eventsTable.id, id)).limit(1);
  if (!existing || !canAccessCompany(user, existing.companyId)) throw new AppError(404, "Event not found");
  await db.delete(eventsTable).where(eq(eventsTable.id, id));
  return { success: true, message: "Event deleted" };
}

export async function getEventStats(user: AuthUser, id: number) {
  const [evt] = await db.select({ companyId: eventsTable.companyId }).from(eventsTable).where(eq(eventsTable.id, id)).limit(1);
  if (!evt || !canAccessCompany(user, evt.companyId)) throw new AppError(404, "Event not found");
  const [contactCount] = await db.select({ count: count() }).from(contactsTable).where(and(eq(contactsTable.eventId, id), isNull(contactsTable.duplicateOfId)));
  const [qualifiedCountRow] = await db.select({ count: count() }).from(contactsTable).where(and(eq(contactsTable.eventId, id), isNull(contactsTable.duplicateOfId), inArray(contactsTable.status, ["qualified", "interested"])));
  const [leadCount] = await db.select({ count: count() }).from(leadsTable).where(eq(leadsTable.eventId, id));
  const wonLeads = await db.select({ count: count(), total: sum(leadsTable.value) }).from(leadsTable).where(and(eq(leadsTable.eventId, id), eq(leadsTable.stage, "won")));
  const byStage = await db.select({ stage: leadsTable.stage, count: count() }).from(leadsTable).where(eq(leadsTable.eventId, id)).groupBy(leadsTable.stage);
  const wonCount = wonLeads[0]?.count ?? 0;
  const revenue = Number(wonLeads[0]?.total ?? 0);
  const total = leadCount?.count ?? 0;
  const conversionRate = total > 0 ? Math.round((wonCount / total) * 100) : 0;
  return { contactCount: contactCount.count, leadCount: leadCount.count, qualifiedCount: qualifiedCountRow.count, wonCount, revenue, conversionRate, byStage: byStage.map(s => ({ status: s.stage, count: s.count })) };
}
