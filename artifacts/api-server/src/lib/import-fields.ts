// Stage 4B — Import & Export Center. Field registry + shared helpers for the
// bulk import pipeline. Pure module (no DB): defines the standard importable
// fields per entity type, header→field auto-mapping, and per-type value coercion
// used by the import service's preview/validate/commit steps.

export type ImportEntityType = "contact" | "lead";

export type ImportFieldType = "text" | "email" | "phone" | "number" | "date" | "tags";

export interface ImportFieldDef {
  key: string;
  label: string;
  type: ImportFieldType;
  aliases: string[]; // normalized header candidates for auto-mapping
}

// Standard (non-custom) importable fields. Kept aligned with CreateContactInput /
// LeadInput so a mapped value flows straight into the create path.
const CONTACT_FIELDS: ImportFieldDef[] = [
  { key: "firstName", label: "First Name", type: "text", aliases: ["firstname", "first", "givenname", "fname"] },
  { key: "lastName", label: "Last Name", type: "text", aliases: ["lastname", "last", "surname", "familyname", "lname"] },
  { key: "arabicName", label: "Arabic Name", type: "text", aliases: ["arabicname", "namearabic", "arabic"] },
  { key: "jobTitle", label: "Job Title", type: "text", aliases: ["jobtitle", "title", "position", "role", "designation"] },
  { key: "contactCompany", label: "Company", type: "text", aliases: ["company", "companyname", "organization", "organisation", "employer", "contactcompany"] },
  { key: "email", label: "Email", type: "email", aliases: ["email", "emailaddress", "mail", "e-mail"] },
  { key: "mobile", label: "Mobile", type: "phone", aliases: ["mobile", "mobilephone", "cell", "cellphone", "phone", "phonenumber", "tel"] },
  { key: "officePhone", label: "Office Phone", type: "phone", aliases: ["officephone", "workphone", "office", "landline", "telephone"] },
  { key: "website", label: "Website", type: "text", aliases: ["website", "web", "url", "site"] },
  { key: "country", label: "Country", type: "text", aliases: ["country", "nation"] },
  { key: "address", label: "Address", type: "text", aliases: ["address", "streetaddress", "location"] },
  { key: "linkedin", label: "LinkedIn", type: "text", aliases: ["linkedin", "linkedinurl", "li"] },
  { key: "notes", label: "Notes", type: "text", aliases: ["notes", "note", "comments", "remark", "remarks"] },
  { key: "status", label: "Status", type: "text", aliases: ["status", "stage", "leadstatus"] },
  { key: "source", label: "Source", type: "text", aliases: ["source", "leadsource", "origin"] },
  { key: "tags", label: "Tags", type: "tags", aliases: ["tags", "tag", "labels"] },
];

const LEAD_FIELDS: ImportFieldDef[] = [
  { key: "title", label: "Title", type: "text", aliases: ["title", "name", "leadname", "opportunity", "opportunityname", "deal", "dealname"] },
  { key: "contactEmail", label: "Contact Email", type: "email", aliases: ["contactemail", "email", "emailaddress", "mail"] },
  { key: "companyName", label: "Company", type: "text", aliases: ["company", "companyname", "organization", "account"] },
  { key: "value", label: "Value", type: "number", aliases: ["value", "amount", "dealvalue", "dealsize", "price"] },
  { key: "currency", label: "Currency", type: "text", aliases: ["currency", "ccy"] },
  { key: "stage", label: "Stage", type: "text", aliases: ["stage", "pipelinestage", "status"] },
  { key: "probability", label: "Probability", type: "number", aliases: ["probability", "prob", "winprobability", "likelihood"] },
  { key: "priority", label: "Priority", type: "text", aliases: ["priority", "importance"] },
  { key: "closingDate", label: "Closing Date", type: "date", aliases: ["closingdate", "closedate", "expectedclose", "closing"] },
  { key: "notes", label: "Notes", type: "text", aliases: ["notes", "note", "comments", "description"] },
  { key: "source", label: "Source", type: "text", aliases: ["source", "leadsource", "origin"] },
];

export function standardFields(entityType: ImportEntityType): ImportFieldDef[] {
  return entityType === "contact" ? CONTACT_FIELDS : LEAD_FIELDS;
}

// Normalize a spreadsheet header (or alias) to a comparable token: lowercase,
// strip everything but a-z0-9.
export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Auto-map spreadsheet columns to field keys. Standard fields match by alias;
// custom fields (prefixed "cf:") match by their label or fieldKey. First match
// wins per column and each field is used at most once.
export function inferMapping(
  columns: string[],
  fields: ImportFieldDef[],
): Record<string, string | null> {
  const used = new Set<string>();
  const out: Record<string, string | null> = {};
  for (const col of columns) {
    const norm = normalizeHeader(col);
    let matched: string | null = null;
    for (const f of fields) {
      if (used.has(f.key)) continue;
      if (f.aliases.some((a) => normalizeHeader(a) === norm) || normalizeHeader(f.label) === norm || normalizeHeader(f.key) === norm) {
        matched = f.key;
        break;
      }
    }
    if (matched) used.add(matched);
    out[col] = matched;
  }
  return out;
}

export interface CoerceResult {
  ok: boolean;
  value: string | null;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Coerce+validate a raw cell string against a standard field's type. Empty is
// always allowed here (required-ness is enforced at the row level in the service).
export function coerceStandardValue(field: ImportFieldDef, raw: string): CoerceResult {
  const v = raw.trim();
  if (v === "") return { ok: true, value: null };
  switch (field.type) {
    case "email":
      if (!EMAIL_RE.test(v)) return { ok: false, value: null, error: `${field.label}: invalid email` };
      return { ok: true, value: v.toLowerCase() };
    case "phone": {
      if (v.replace(/\D/g, "").length < 7) return { ok: false, value: null, error: `${field.label}: invalid phone` };
      return { ok: true, value: v };
    }
    case "number": {
      const n = Number(v.replace(/,/g, ""));
      if (Number.isNaN(n)) return { ok: false, value: null, error: `${field.label}: not a number` };
      return { ok: true, value: String(n) };
    }
    case "date": {
      const norm = normalizeDate(v);
      if (!norm) return { ok: false, value: null, error: `${field.label}: invalid date (use YYYY-MM-DD)` };
      return { ok: true, value: norm };
    }
    default:
      return { ok: true, value: v };
  }
}

// Accept a few common date encodings and normalize to YYYY-MM-DD. Returns null
// when unparseable.
export function normalizeDate(raw: string): string | null {
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : v;
  }
  // M/D/YYYY or D/M/YYYY are ambiguous; treat as M/D/YYYY (common in exports).
  const m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    const year = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const iso = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : iso;
  }
  return null;
}
