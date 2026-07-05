// Stage 4B — Export Center column registry. Defines the exported columns per
// entity type over the real DB rows (no fabricated values). Custom-field columns
// are appended by the service at runtime. Kept pure (no DB) and stable so the
// output layout is deterministic across formats.
import type { ContactRow } from "../repositories/contacts.repository.js";
import type { LeadRow } from "../repositories/leads.repository.js";

export type ExportEntityType = "contact" | "lead";

export interface ExportColumn<T> {
  key: string;
  label: string;
  get: (row: T) => string;
}

function s(v: unknown): string {
  return v == null ? "" : String(v);
}

function iso(v: unknown): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? s(v) : d.toISOString();
}

function tagList(v: unknown): string {
  if (!v) return "";
  try {
    const arr = JSON.parse(String(v));
    return Array.isArray(arr) ? arr.join(", ") : s(v);
  } catch {
    return s(v);
  }
}

const CONTACT_COLUMNS: ExportColumn<ContactRow>[] = [
  { key: "id", label: "ID", get: (r) => s(r.id) },
  { key: "firstName", label: "First Name", get: (r) => s(r.firstName) },
  { key: "lastName", label: "Last Name", get: (r) => s(r.lastName) },
  { key: "fullName", label: "Full Name", get: (r) => s(r.fullName) },
  { key: "arabicName", label: "Arabic Name", get: (r) => s(r.arabicName) },
  { key: "jobTitle", label: "Job Title", get: (r) => s(r.jobTitle) },
  { key: "contactCompany", label: "Company", get: (r) => s(r.contactCompany) },
  { key: "email", label: "Email", get: (r) => s(r.email) },
  { key: "mobile", label: "Mobile", get: (r) => s(r.mobile) },
  { key: "officePhone", label: "Office Phone", get: (r) => s(r.officePhone) },
  { key: "website", label: "Website", get: (r) => s(r.website) },
  { key: "country", label: "Country", get: (r) => s(r.country) },
  { key: "address", label: "Address", get: (r) => s(r.address) },
  { key: "linkedin", label: "LinkedIn", get: (r) => s(r.linkedin) },
  { key: "status", label: "Status", get: (r) => s(r.status) },
  { key: "leadScore", label: "Lead Score", get: (r) => s(r.leadScore) },
  { key: "leadTemperature", label: "Temperature", get: (r) => s(r.leadTemperature) },
  { key: "source", label: "Source", get: (r) => s(r.source) },
  { key: "tags", label: "Tags", get: (r) => tagList(r.tags) },
  { key: "notes", label: "Notes", get: (r) => s(r.notes) },
  { key: "createdAt", label: "Created At", get: (r) => iso(r.createdAt) },
];

const LEAD_COLUMNS: ExportColumn<LeadRow>[] = [
  { key: "id", label: "ID", get: (r) => s(r.id) },
  { key: "title", label: "Title", get: (r) => s(r.title) },
  { key: "companyName", label: "Company", get: (r) => s(r.companyName) },
  { key: "contactId", label: "Contact ID", get: (r) => s(r.contactId) },
  { key: "value", label: "Value", get: (r) => s(r.value) },
  { key: "currency", label: "Currency", get: (r) => s(r.currency) },
  { key: "stage", label: "Stage", get: (r) => s(r.stage) },
  { key: "probability", label: "Probability", get: (r) => s(r.probability) },
  { key: "priority", label: "Priority", get: (r) => s(r.priority) },
  { key: "closingDate", label: "Closing Date", get: (r) => s(r.closingDate) },
  { key: "source", label: "Source", get: (r) => s(r.source) },
  { key: "notes", label: "Notes", get: (r) => s(r.notes) },
  { key: "createdAt", label: "Created At", get: (r) => iso(r.createdAt) },
];

export function contactColumns(): ExportColumn<ContactRow>[] {
  return CONTACT_COLUMNS;
}

export function leadColumns(): ExportColumn<LeadRow>[] {
  return LEAD_COLUMNS;
}

export function isExportEntityType(v: unknown): v is ExportEntityType {
  return v === "contact" || v === "lead";
}
