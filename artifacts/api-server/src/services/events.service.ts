import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as eventsRepo from "../repositories/events.repository.js";

async function enrichEvent(e: eventsRepo.EventRow) {
  const { contactCount, leadCount } = await eventsRepo.counts(e.id);
  return { ...e, contactCount, leadCount };
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

  const { rows, total } = await eventsRepo.list(user, { search, limit: limitNum, offset });
  const enriched = await Promise.all(rows.map(enrichEvent));
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
  const event = await eventsRepo.insert({ companyId, name, venue, country: country ?? null, startDate: startDate ?? null, endDate: endDate ?? null, boothNumber, description, status: status ?? "active" });
  return await enrichEvent(event);
}

export async function getEvent(user: AuthUser, id: number) {
  const e = await eventsRepo.findById(user, id);
  if (!e) throw new AppError(404, "Event not found");
  return await enrichEvent(e);
}

export async function updateEvent(user: AuthUser, id: number, input: EventInput) {
  const existing = await eventsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Event not found");
  const { name, venue, country, startDate, endDate, boothNumber, description, status } = input;
  const updateData: Record<string, unknown> = { name, venue, country, startDate, endDate, boothNumber, description, status };
  Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
  if (Object.keys(updateData).length === 0) throw new AppError(400, "No valid fields to update");
  const e = await eventsRepo.update(id, updateData as Partial<eventsRepo.EventRow>);
  if (!e) throw new AppError(404, "Event not found");
  return await enrichEvent(e);
}

export async function deleteEvent(user: AuthUser, id: number) {
  const existing = await eventsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Event not found");
  await eventsRepo.softDelete(id);
  return { success: true, message: "Event deleted" };
}

export async function getEventStats(user: AuthUser, id: number) {
  const evt = await eventsRepo.findById(user, id);
  if (!evt) throw new AppError(404, "Event not found");
  const { contactCount, qualifiedCountRow, leadCount, wonLeads, byStage } = await eventsRepo.statsAggregates(id);
  const wonCount = wonLeads[0]?.count ?? 0;
  const revenue = Number(wonLeads[0]?.total ?? 0);
  const total = leadCount?.count ?? 0;
  const conversionRate = total > 0 ? Math.round((wonCount / total) * 100) : 0;
  return { contactCount: contactCount.count, leadCount: leadCount.count, qualifiedCount: qualifiedCountRow.count, wonCount, revenue, conversionRate, byStage: byStage.map(s => ({ status: s.stage, count: s.count })) };
}
