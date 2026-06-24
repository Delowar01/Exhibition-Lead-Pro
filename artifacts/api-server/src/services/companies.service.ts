import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as companiesRepo from "../repositories/companies.repository.js";

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

  const { rows, total } = await companiesRepo.list({ search: params.search, status: params.status, plan: params.plan, limit: limitNum, offset });
  const enriched = await Promise.all(rows.map(async (c) => ({ ...c, ...(await companiesRepo.counts(c.id)) })));

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
  legalName?: string | null;
  registrationNumber?: string | null;
  timezone?: string | null;
  currency?: string | null;
  primaryContactName?: string | null;
  primaryContactEmail?: string | null;
}

export async function createCompany(user: AuthUser, input: CompanyInput) {
  if (user.role !== "platform_owner") throw new AppError(403, "Forbidden");
  if (!input.name) throw new AppError(400, "name required");
  const company = await companiesRepo.insert({
    name: input.name,
    industry: input.industry,
    country: input.country,
    address: input.address,
    vatNumber: input.vatNumber,
    website: input.website,
    plan: input.plan ?? "free",
    legalName: input.legalName,
    registrationNumber: input.registrationNumber,
    timezone: input.timezone,
    currency: input.currency,
    primaryContactName: input.primaryContactName,
    primaryContactEmail: input.primaryContactEmail,
  });
  await companiesRepo.insertActivityLog({
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
  const company = await companiesRepo.findById(id);
  if (!company) throw new AppError(404, "Company not found");
  return { ...company, ...(await companiesRepo.counts(id)) };
}

export async function updateCompany(id: number, input: CompanyInput) {
  const company = await companiesRepo.update(id, {
    name: input.name,
    industry: input.industry,
    country: input.country,
    address: input.address,
    vatNumber: input.vatNumber,
    website: input.website,
    plan: input.plan,
    legalName: input.legalName,
    registrationNumber: input.registrationNumber,
    timezone: input.timezone,
    currency: input.currency,
    primaryContactName: input.primaryContactName,
    primaryContactEmail: input.primaryContactEmail,
  });
  if (!company) throw new AppError(404, "Company not found");
  return { ...company, userCount: 0, contactCount: 0, scanCount: 0 };
}

export async function deleteCompany(user: AuthUser, id: number) {
  if (user.role !== "platform_owner") throw new AppError(403, "Forbidden");
  await companiesRepo.remove(id);
  return { success: true, message: "Company deleted" };
}

async function setCompanyStatus(user: AuthUser, id: number, status: string, logType: string, verb: string) {
  if (user.role !== "platform_owner") throw new AppError(403, "Forbidden");
  const company = await companiesRepo.update(id, { status });
  if (!company) throw new AppError(404, "Company not found");
  await companiesRepo.insertActivityLog({
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
