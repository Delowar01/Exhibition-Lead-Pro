import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as orgRepo from "../repositories/organizations.repository.js";
import * as contactsRepo from "../repositories/contacts.repository.js";
import * as leadsRepo from "../repositories/leads.repository.js";
import { enrichContactRows } from "./contacts.service.js";
import { enrichLeads } from "./leads.service.js";
import { parseListQuery } from "../lib/list-query.js";
import { convertCurrency } from "../lib/currency.js";

const STATUSES = ["active", "archived"] as const;

// Lowercase + collapse internal whitespace for tenant-scoped dedup + backfill
// matching against the legacy free-text company fields.
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

async function enrich(o: orgRepo.OrganizationRow) {
  const { contactCount, leadCount } = await orgRepo.counts(o.id);
  const openLeads = await orgRepo.openLeadValues(o.id);
  // Cross-currency: convert each open lead's value to USD BEFORE summing.
  const openLeadValue = openLeads.reduce(
    (sum, l) => sum + convertCurrency(l.value ? parseFloat(l.value) : 0, l.currency ?? "USD", "USD"),
    0,
  );
  return {
    id: o.id,
    companyId: o.companyId,
    name: o.name,
    industry: o.industry,
    website: o.website,
    phone: o.phone,
    email: o.email,
    address: o.address,
    country: o.country,
    size: o.size,
    notes: o.notes,
    status: o.status,
    contactCount,
    leadCount,
    openLeadValue,
    createdAt: o.createdAt,
  };
}

export interface ListOrganizationsParams {
  search?: string;
  status?: string;
  page?: string;
  limit?: string;
}

export async function listOrganizations(user: AuthUser, params: ListOrganizationsParams) {
  const { search, page: pageNum, limit: limitNum, offset } = parseListQuery(params, { defaultPageSize: 50, maxPageSize: 200 });
  const { rows, total } = await orgRepo.list(user, { search, status: params.status, limit: limitNum, offset });
  const organizations = await Promise.all(rows.map(enrich));
  return { organizations, total, page: pageNum, limit: limitNum };
}

export async function getOrganization(user: AuthUser, id: number) {
  const o = await orgRepo.findById(user, id);
  if (!o) throw new AppError(404, "Organization not found");
  return enrich(o);
}

export interface OrganizationInput {
  name?: string;
  industry?: string | null;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  country?: string | null;
  size?: string | null;
  notes?: string | null;
  status?: string;
}

export async function createOrganization(user: AuthUser, input: OrganizationInput) {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const { name, industry, website, phone, email, address, country, size, notes, status } = input;
  if (!name || !name.trim()) throw new AppError(400, "name required");
  if (status !== undefined && !STATUSES.includes(status as (typeof STATUSES)[number])) throw new AppError(400, "Invalid status");
  const normalizedName = normalizeName(name);
  if (await orgRepo.findByNormalizedName(companyId, normalizedName)) throw new AppError(409, "An organization with this name already exists");
  const o = await orgRepo.insert({
    companyId,
    name: name.trim(),
    normalizedName,
    industry: industry ?? null,
    website: website ?? null,
    phone: phone ?? null,
    email: email ?? null,
    address: address ?? null,
    country: country ?? null,
    size: size ?? null,
    notes: notes ?? null,
    status: status ?? "active",
    createdById: user.id,
  });
  return enrich(o);
}

export async function updateOrganization(user: AuthUser, id: number, input: OrganizationInput) {
  const existing = await orgRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Organization not found");
  const { name, industry, website, phone, email, address, country, size, notes, status } = input;
  if (status !== undefined && !STATUSES.includes(status as (typeof STATUSES)[number])) throw new AppError(400, "Invalid status");
  const patch: Record<string, unknown> = {};
  if (name !== undefined) {
    if (!name.trim()) throw new AppError(400, "name cannot be empty");
    const normalizedName = normalizeName(name);
    if (normalizedName !== existing.normalizedName) {
      const dup = await orgRepo.findByNormalizedName(existing.companyId, normalizedName);
      if (dup && dup.id !== id) throw new AppError(409, "An organization with this name already exists");
    }
    patch.name = name.trim();
    patch.normalizedName = normalizedName;
  }
  if (industry !== undefined) patch.industry = industry;
  if (website !== undefined) patch.website = website;
  if (phone !== undefined) patch.phone = phone;
  if (email !== undefined) patch.email = email;
  if (address !== undefined) patch.address = address;
  if (country !== undefined) patch.country = country;
  if (size !== undefined) patch.size = size;
  if (notes !== undefined) patch.notes = notes;
  if (status !== undefined) patch.status = status;
  if (Object.keys(patch).length === 0) throw new AppError(400, "No valid fields to update");
  patch.updatedAt = new Date();
  const o = await orgRepo.update(id, patch);
  if (!o) throw new AppError(404, "Organization not found");
  return enrich(o);
}

export async function deleteOrganization(user: AuthUser, id: number) {
  const existing = await orgRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Organization not found");
  await orgRepo.softDelete(id);
  return { success: true, message: "Organization deleted" };
}

export async function archiveOrganization(user: AuthUser, id: number) {
  const existing = await orgRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Organization not found");
  const o = await orgRepo.update(id, { status: "archived", updatedAt: new Date() });
  if (!o) throw new AppError(404, "Organization not found");
  return enrich(o);
}

export async function restoreOrganization(user: AuthUser, id: number) {
  const existing = await orgRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Organization not found");
  const o = await orgRepo.update(id, { status: "active", updatedAt: new Date() });
  if (!o) throw new AppError(404, "Organization not found");
  return enrich(o);
}

// Contacts linked to an organization (tenant-scoped, soft-delete-excluding),
// returned in the standard ContactList shape.
export async function listOrganizationContacts(user: AuthUser, id: number) {
  const o = await orgRepo.findById(user, id);
  if (!o) throw new AppError(404, "Organization not found");
  const ids = await orgRepo.contactIds(user, id);
  const rows = await Promise.all(ids.map((cid) => contactsRepo.findById(user, cid)));
  const present = rows.filter((r): r is NonNullable<typeof r> => !!r);
  const contacts = await enrichContactRows(present);
  return { contacts, total: contacts.length, page: 1, limit: contacts.length };
}

// Leads linked to an organization (tenant-scoped, soft-delete-excluding),
// returned in the standard LeadList shape.
export async function listOrganizationLeads(user: AuthUser, id: number) {
  const o = await orgRepo.findById(user, id);
  if (!o) throw new AppError(404, "Organization not found");
  const ids = await orgRepo.leadIds(user, id);
  const rows = await Promise.all(ids.map((lid) => leadsRepo.findById(user, lid)));
  const present = rows.filter((r): r is NonNullable<typeof r> => !!r);
  const leads = await enrichLeads(present);
  return { leads, total: leads.length };
}
