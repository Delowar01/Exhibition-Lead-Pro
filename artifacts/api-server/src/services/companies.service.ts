import { db } from "@workspace/db";
import { companiesTable, usersTable, contactsTable, scansTable, activityLogsTable } from "@workspace/db";
import { eq, ilike, and, count } from "drizzle-orm";
import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";

// Per-company aggregate counts surfaced alongside each company record. Kept here so
// list/detail/mutation responses stay shaped identically.
async function companyCounts(id: number): Promise<{ userCount: number; contactCount: number; scanCount: number }> {
  const [userCount] = await db.select({ count: count() }).from(usersTable).where(eq(usersTable.companyId, id));
  const [contactCount] = await db.select({ count: count() }).from(contactsTable).where(eq(contactsTable.companyId, id));
  const [scanCount] = await db.select({ count: count() }).from(scansTable).where(eq(scansTable.companyId, id));
  return { userCount: userCount.count, contactCount: contactCount.count, scanCount: scanCount.count };
}

export interface ListCompaniesParams {
  search?: string;
  status?: string;
  plan?: string;
  page?: string;
  limit?: string;
}

export async function listCompanies(params: ListCompaniesParams) {
  const pageNum = Math.max(1, parseInt(params.page ?? "1"));
  const limitNum = Math.min(100, parseInt(params.limit ?? "20"));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (params.search) conditions.push(ilike(companiesTable.name, `%${params.search}%`));
  if (params.status) conditions.push(eq(companiesTable.status, params.status));
  if (params.plan) conditions.push(eq(companiesTable.plan, params.plan));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [{ total }] = await db.select({ total: count() }).from(companiesTable).where(whereClause);

  const companies = await db
    .select()
    .from(companiesTable)
    .where(whereClause)
    .limit(limitNum)
    .offset(offset)
    .orderBy(companiesTable.createdAt);

  const enriched = await Promise.all(companies.map(async (c) => ({ ...c, ...(await companyCounts(c.id)) })));

  return { companies: enriched, total, page: pageNum, limit: limitNum };
}

export interface CompanyInput {
  name?: string;
  industry?: string;
  country?: string;
  address?: string;
  vatNumber?: string;
  website?: string;
  plan?: string;
}

export async function createCompany(user: AuthUser, input: CompanyInput) {
  if (user.role !== "platform_owner") throw new AppError(403, "Forbidden");
  if (!input.name) throw new AppError(400, "name required");
  const [company] = await db
    .insert(companiesTable)
    .values({
      name: input.name,
      industry: input.industry,
      country: input.country,
      address: input.address,
      vatNumber: input.vatNumber,
      website: input.website,
      plan: input.plan ?? "free",
    })
    .returning();
  await db.insert(activityLogsTable).values({
    type: "company_created",
    description: `Company created: ${input.name}`,
    companyId: company.id,
    companyName: input.name,
    userId: user.id,
    userName: user.email,
  });
  return { ...company, userCount: 0, contactCount: 0, scanCount: 0 };
}

export async function getCompany(id: number) {
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, id)).limit(1);
  if (!company) throw new AppError(404, "Company not found");
  return { ...company, ...(await companyCounts(id)) };
}

export async function updateCompany(id: number, input: CompanyInput) {
  const [company] = await db
    .update(companiesTable)
    .set({
      name: input.name,
      industry: input.industry,
      country: input.country,
      address: input.address,
      vatNumber: input.vatNumber,
      website: input.website,
      plan: input.plan,
    })
    .where(eq(companiesTable.id, id))
    .returning();
  if (!company) throw new AppError(404, "Company not found");
  return { ...company, userCount: 0, contactCount: 0, scanCount: 0 };
}

export async function deleteCompany(user: AuthUser, id: number) {
  if (user.role !== "platform_owner") throw new AppError(403, "Forbidden");
  await db.delete(companiesTable).where(eq(companiesTable.id, id));
  return { success: true, message: "Company deleted" };
}

async function setCompanyStatus(user: AuthUser, id: number, status: string, logType: string, verb: string) {
  if (user.role !== "platform_owner") throw new AppError(403, "Forbidden");
  const [company] = await db.update(companiesTable).set({ status }).where(eq(companiesTable.id, id)).returning();
  await db.insert(activityLogsTable).values({
    type: logType,
    description: `Company ${verb}: ${company.name}`,
    companyId: id,
    companyName: company.name,
    userId: user.id,
    userName: user.email,
  });
  return { ...company, userCount: 0, contactCount: 0, scanCount: 0 };
}

export async function suspendCompany(user: AuthUser, id: number) {
  return setCompanyStatus(user, id, "suspended", "company_suspended", "suspended");
}

export async function activateCompany(user: AuthUser, id: number) {
  return setCompanyStatus(user, id, "active", "company_activated", "activated");
}
