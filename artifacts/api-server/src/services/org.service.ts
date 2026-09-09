import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as companiesRepo from "../repositories/companies.repository.js";
import * as subsRepo from "../repositories/subscriptions.repository.js";
import { normalizeLegacyStatus } from "../lib/billing/lifecycle.js";

// Self-service organization profile for a company admin (own tenant). Distinct
// from the platform-owner /companies surface: a company manages only its OWN org.
function resolveCompanyId(user: AuthUser, companyId?: number): number {
  if (user.role === "platform_owner") {
    const cid = companyId ?? user.companyId;
    if (cid == null) throw new AppError(400, "companyId is required");
    return cid;
  }
  if (user.companyId == null) throw new AppError(400, "Your account has no company");
  if (companyId != null && companyId !== user.companyId && !user.accessibleCompanies.includes(companyId)) {
    throw new AppError(404, "Organization not found");
  }
  return companyId && user.accessibleCompanies.includes(companyId) ? companyId : user.companyId;
}

// Batch 20: `plan` / `status` are projected from the canonical subscription row
// (the legacy company columns are write-only mirrors and are not consulted).
async function format(company: companiesRepo.CompanyRow) {
  const sub = await subsRepo.findByCompanyId(company.id);
  return {
    id: company.id,
    name: company.name,
    legalName: company.legalName,
    registrationNumber: company.registrationNumber,
    industry: company.industry,
    website: company.website,
    phone: company.phone,
    address: company.address,
    country: company.country,
    vatNumber: company.vatNumber,
    timezone: company.timezone,
    currency: company.currency,
    logoUrl: company.logoUrl,
    primaryContactName: company.primaryContactName,
    primaryContactEmail: company.primaryContactEmail,
    plan: sub?.plan ?? company.plan,
    status: sub ? (normalizeLegacyStatus(sub.status) ?? sub.status) : company.status,
  };
}

export async function getMyOrg(user: AuthUser, companyId?: number) {
  const cid = resolveCompanyId(user, companyId);
  const company = await companiesRepo.findById(cid);
  if (!company) throw new AppError(404, "Organization not found");
  return await format(company);
}

export interface OrgInput {
  companyId?: number;
  name?: string;
  legalName?: string | null;
  registrationNumber?: string | null;
  industry?: string | null;
  website?: string | null;
  phone?: string | null;
  address?: string | null;
  country?: string | null;
  vatNumber?: string | null;
  timezone?: string | null;
  currency?: string | null;
  logoUrl?: string | null;
  primaryContactName?: string | null;
  primaryContactEmail?: string | null;
}

export async function updateMyOrg(user: AuthUser, input: OrgInput) {
  const cid = resolveCompanyId(user, input.companyId);
  const patch: Partial<companiesRepo.CompanyRow> = {};
  const str = (v: unknown) => (v === null ? null : typeof v === "string" ? v : undefined);
  if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim();
  const fields: Array<keyof OrgInput> = [
    "legalName", "registrationNumber", "industry", "website", "phone", "address",
    "country", "vatNumber", "timezone", "currency", "logoUrl", "primaryContactName", "primaryContactEmail",
  ];
  for (const f of fields) {
    const v = str(input[f]);
    if (v !== undefined) (patch as Record<string, unknown>)[f] = v;
  }
  if (Object.keys(patch).length === 0) throw new AppError(400, "Nothing to update");
  patch.updatedAt = new Date();
  const company = await companiesRepo.update(cid, patch);
  if (!company) throw new AppError(404, "Organization not found");
  return await format(company);
}
