import { db } from "@workspace/db";
import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as companiesRepo from "../repositories/companies.repository.js";
import * as subsRepo from "../repositories/subscriptions.repository.js";
import { parseListQuery } from "../lib/list-query.js";
import { ensureStages } from "./pipeline.service.js";
import * as lifecycle from "./subscription-lifecycle.service.js";
import { resolveEntitlement, normalizeLegacyStatus } from "../lib/billing/lifecycle.js";
import type { Actor } from "./subscription-lifecycle.service.js";

export interface ListCompaniesParams {
  search?: string;
  status?: string;
  plan?: string;
  page?: string;
  limit?: string;
}

// Batch 20: every company view carries its canonical subscription summary; the
// legacy `plan`/`status` columns on the row are mirrors and are not consulted.
async function withSubscription<T extends { id: number; plan: string; status: string }>(c: T) {
  const sub = await subsRepo.findByCompanyId(c.id);
  const entitlement = resolveEntitlement(sub ?? null);
  return {
    ...c,
    plan: sub?.plan ?? c.plan,
    status: sub ? (normalizeLegacyStatus(sub.status) ?? sub.status) : c.status,
    subscription: sub
      ? {
          id: sub.id,
          plan: sub.plan,
          status: normalizeLegacyStatus(sub.status) ?? sub.status,
          billingSource: sub.billingSource,
          accessMode: entitlement.accessMode,
          trialExpiresAt: sub.trialExpiresAt?.toISOString() ?? null,
          currentPeriodEndsAt: sub.currentPeriodEndsAt?.toISOString() ?? null,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        }
      : null,
  };
}

export async function listCompanies(params: ListCompaniesParams) {
  const { page: pageNum, limit: limitNum, offset } = parseListQuery(params, { defaultPageSize: 20, maxPageSize: 100 });

  const { rows, total } = await companiesRepo.list({ search: params.search, status: params.status, plan: params.plan, limit: limitNum, offset });
  const enriched = await Promise.all(rows.map(async (c) => withSubscription({ ...c, ...(await companiesRepo.counts(c.id)) })));

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

function actorOf(user: AuthUser, ip: string | null = null): Actor {
  return { userId: user.id, userName: user.email, ipAddress: ip };
}

// Company + its canonical subscription (manual, trialing, 14 days) commit in ONE
// transaction — or roll back together. The activity log rides in the same
// transaction; pipeline stages are seeded afterwards (idempotent, non-critical).
export async function createCompany(user: AuthUser, input: CompanyInput, ip: string | null = null) {
  if (user.role !== "platform_owner") throw new AppError(403, "Forbidden");
  if (!input.name) throw new AppError(400, "name required");
  const company = await db.transaction(async (tx) => {
    const created = await companiesRepo.insert(
      {
        name: input.name!,
        industry: input.industry,
        country: input.country,
        address: input.address,
        vatNumber: input.vatNumber,
        website: input.website,
        plan: input.plan ?? "free",
        status: "trial",
        legalName: input.legalName,
        registrationNumber: input.registrationNumber,
        timezone: input.timezone,
        currency: input.currency,
        primaryContactName: input.primaryContactName,
        primaryContactEmail: input.primaryContactEmail,
        createdById: user.id,
      },
      tx,
    );
    await lifecycle.createSubscriptionForCompany(tx, { id: created.id, name: created.name }, { plan: input.plan ?? "free", actor: actorOf(user, ip) });
    await companiesRepo.insertActivityLog(
      {
        type: "company_created",
        description: `Company created: ${input.name}`,
        companyId: created.id,
        companyName: input.name!,
        userId: user.id,
        userName: user.email,
      },
      tx,
    );
    return created;
  });
  // Seed the default pipeline stages so the new tenant has a working pipeline immediately.
  await ensureStages(company.id);
  return withSubscription({ ...company, userCount: 0, contactCount: 0, scanCount: 0 });
}

export async function getCompany(id: number) {
  const company = await companiesRepo.findById(id);
  if (!company) throw new AppError(404, "Company not found");
  return withSubscription({ ...company, ...(await companiesRepo.counts(id)) });
}

// Profile fields only. `plan` / `status` / `suspendedReason` are NOT accepted
// here any more (Batch 20): plan changes go through the subscription lifecycle
// routes, which keep the legacy mirror columns in sync transactionally.
export async function updateCompany(id: number, input: CompanyInput) {
  const company = await companiesRepo.update(id, {
    name: input.name,
    industry: input.industry,
    country: input.country,
    address: input.address,
    vatNumber: input.vatNumber,
    website: input.website,
    legalName: input.legalName,
    registrationNumber: input.registrationNumber,
    timezone: input.timezone,
    currency: input.currency,
    primaryContactName: input.primaryContactName,
    primaryContactEmail: input.primaryContactEmail,
  });
  if (!company) throw new AppError(404, "Company not found");
  return withSubscription({ ...company, ...(await companiesRepo.counts(id)) });
}

export async function deleteCompany(user: AuthUser, id: number) {
  if (user.role !== "platform_owner") throw new AppError(403, "Forbidden");
  await companiesRepo.remove(id);
  return { success: true, message: "Company deleted" };
}

async function logStatus(user: AuthUser, id: number, logType: string, verb: string) {
  const company = await companiesRepo.findById(id);
  if (!company) throw new AppError(404, "Company not found");
  await companiesRepo.insertActivityLog({
    type: logType,
    description: `Company ${verb}: ${company.name}`,
    companyId: id,
    companyName: company.name,
    userId: user.id,
    userName: user.email,
  });
  return withSubscription({ ...company, ...(await companiesRepo.counts(id)) });
}

// Legacy platform endpoints kept for compatibility; both now drive the
// canonical subscription through the lifecycle service (transaction + audit).
export async function suspendCompany(user: AuthUser, id: number, ip: string | null = null) {
  if (user.role !== "platform_owner") throw new AppError(403, "Forbidden");
  await lifecycle.suspend(id, actorOf(user, ip), { reason: "Suspended by platform operator" });
  return logStatus(user, id, "company_suspended", "suspended");
}

export async function activateCompany(user: AuthUser, id: number, ip: string | null = null) {
  if (user.role !== "platform_owner") throw new AppError(403, "Forbidden");
  const sub = await subsRepo.findByCompanyId(id);
  if (!sub) throw new AppError(404, "Company not found");
  if (normalizeLegacyStatus(sub.status) === "suspended") await lifecycle.reactivate(id, actorOf(user, ip));
  else await lifecycle.activate(id, actorOf(user, ip));
  return logStatus(user, id, "company_activated", "activated");
}
