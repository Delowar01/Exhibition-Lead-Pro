// Stage 5E — Deterministic capture validation + normalization.
//
// Pure, tenant-agnostic functions that VALIDATE captured contact fields (email, website,
// phone with international dial code, country, postal code) and produce NORMALIZATION
// SUGGESTIONS (company name, phone, country code, email, website, address). Nothing here
// mutates or overwrites the caller's data — every normalization is returned as a
// suggested value alongside the original, for the user to accept or reject. No AI, no I/O,
// no fabrication: an absent/unparseable value yields an honest "empty"/"invalid" status,
// never a guessed correction.

export type FieldStatus = "valid" | "invalid" | "warning" | "empty";

export interface FieldValidation {
  field: string;
  value: string | null;
  status: FieldStatus;
  message?: string;
}

export interface NormalizationSuggestion {
  field: string;
  original: string;
  suggested: string;
  reason: string;
}

export interface CaptureFields {
  firstName?: string | null;
  lastName?: string | null;
  jobTitle?: string | null;
  company?: string | null;
  email?: string | null;
  mobile?: string | null;
  officePhone?: string | null;
  website?: string | null;
  linkedin?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  postalCode?: string | null;
}

// ── Country / dial-code reference (GCC-first, plus major markets) ──────────────
interface CountryRef { iso2: string; name: string; dial: string; aliases: string[]; postal?: RegExp }

const COUNTRIES: CountryRef[] = [
  { iso2: "AE", name: "United Arab Emirates", dial: "971", aliases: ["uae", "u.a.e", "u.a.e.", "emirates", "united arab emirates"] },
  { iso2: "SA", name: "Saudi Arabia", dial: "966", aliases: ["ksa", "k.s.a", "saudi", "saudi arabia", "kingdom of saudi arabia"], postal: /^\d{5}(-\d{4})?$/ },
  { iso2: "QA", name: "Qatar", dial: "974", aliases: ["qatar"] },
  { iso2: "KW", name: "Kuwait", dial: "965", aliases: ["kuwait"] },
  { iso2: "BH", name: "Bahrain", dial: "973", aliases: ["bahrain"] },
  { iso2: "OM", name: "Oman", dial: "968", aliases: ["oman", "sultanate of oman"] },
  { iso2: "EG", name: "Egypt", dial: "20", aliases: ["egypt", "misr"], postal: /^\d{5}$/ },
  { iso2: "JO", name: "Jordan", dial: "962", aliases: ["jordan"] },
  { iso2: "LB", name: "Lebanon", dial: "961", aliases: ["lebanon"] },
  { iso2: "US", name: "United States", dial: "1", aliases: ["us", "u.s", "u.s.a", "usa", "united states", "united states of america", "america"], postal: /^\d{5}(-\d{4})?$/ },
  { iso2: "GB", name: "United Kingdom", dial: "44", aliases: ["uk", "u.k", "united kingdom", "britain", "great britain", "england"], postal: /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i },
  { iso2: "IN", name: "India", dial: "91", aliases: ["india", "bharat"], postal: /^\d{6}$/ },
  { iso2: "PK", name: "Pakistan", dial: "92", aliases: ["pakistan"], postal: /^\d{5}$/ },
  { iso2: "DE", name: "Germany", dial: "49", aliases: ["germany", "deutschland"], postal: /^\d{5}$/ },
  { iso2: "FR", name: "France", dial: "33", aliases: ["france"], postal: /^\d{5}$/ },
  { iso2: "ES", name: "Spain", dial: "34", aliases: ["spain", "espana", "españa"], postal: /^\d{5}$/ },
  { iso2: "IT", name: "Italy", dial: "39", aliases: ["italy", "italia"], postal: /^\d{5}$/ },
  { iso2: "NL", name: "Netherlands", dial: "31", aliases: ["netherlands", "holland"] },
  { iso2: "CN", name: "China", dial: "86", aliases: ["china", "prc"], postal: /^\d{6}$/ },
  { iso2: "JP", name: "Japan", dial: "81", aliases: ["japan", "nippon"], postal: /^\d{3}-?\d{4}$/ },
  { iso2: "SG", name: "Singapore", dial: "65", aliases: ["singapore"], postal: /^\d{6}$/ },
  { iso2: "AU", name: "Australia", dial: "61", aliases: ["australia"], postal: /^\d{4}$/ },
  { iso2: "CA", name: "Canada", dial: "1", aliases: ["canada"], postal: /^[A-Z]\d[A-Z]\s*\d[A-Z]\d$/i },
  { iso2: "TR", name: "Türkiye", dial: "90", aliases: ["turkey", "türkiye", "turkiye"], postal: /^\d{5}$/ },
  { iso2: "ZA", name: "South Africa", dial: "27", aliases: ["south africa", "rsa"], postal: /^\d{4}$/ },
  { iso2: "NG", name: "Nigeria", dial: "234", aliases: ["nigeria"] },
  { iso2: "BR", name: "Brazil", dial: "55", aliases: ["brazil", "brasil"], postal: /^\d{5}-?\d{3}$/ },
];

// Longest-dial-first so a "1" (US/CA) never shadows a "971" (AE).
const DIAL_SORTED = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);

function s(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length > 0 ? t : null;
}

// ── Country ───────────────────────────────────────────────────────────────────
export function resolveCountry(input: string | null | undefined): CountryRef | null {
  const v = s(input);
  if (!v) return null;
  const norm = v.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  for (const c of COUNTRIES) {
    if (c.iso2.toLowerCase() === norm) return c;
    if (c.name.toLowerCase() === norm) return c;
    if (c.aliases.includes(norm)) return c;
  }
  return null;
}

// ── Email ─────────────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(input: string | null | undefined): FieldValidation {
  const v = s(input);
  if (!v) return { field: "email", value: null, status: "empty" };
  const collapsed = v.replace(/\s+/g, "");
  const status: FieldStatus = EMAIL_RE.test(collapsed) ? "valid" : "invalid";
  return { field: "email", value: v, status, message: status === "invalid" ? "Does not look like a valid email address" : undefined };
}

export function normalizeEmail(input: string | null | undefined): string | null {
  const v = s(input);
  if (!v) return null;
  return v.replace(/\s+/g, "").toLowerCase();
}

// ── Website ───────────────────────────────────────────────────────────────────
export function validateWebsite(input: string | null | undefined): FieldValidation {
  const v = s(input);
  if (!v) return { field: "website", value: null, status: "empty" };
  const bare = v.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  const ok = /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(bare);
  return { field: "website", value: v, status: ok ? "valid" : "invalid", message: ok ? undefined : "Does not look like a valid website" };
}

export function normalizeWebsite(input: string | null | undefined): string | null {
  const v = s(input);
  if (!v) return null;
  let bare = v.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  bare = bare.toLowerCase();
  return `https://${bare}`;
}

// ── Phone (with international dial code) ───────────────────────────────────────
export interface PhoneValidation extends FieldValidation {
  dialCode?: string | null;
  country?: string | null;
  e164?: string | null;
}

export function validatePhone(input: string | null | undefined, countryHint?: string | null): PhoneValidation {
  const v = s(input);
  if (!v) return { field: "phone", value: null, status: "empty" };
  const hasPlus = v.trim().startsWith("+") || v.trim().startsWith("00");
  const digits = v.replace(/[^\d]/g, "").replace(/^00/, "");
  if (digits.length < 7 || digits.length > 15) {
    return { field: "phone", value: v, status: "invalid", message: "Phone number has an unusual length" };
  }

  let matched: CountryRef | null = null;
  if (hasPlus) {
    for (const c of DIAL_SORTED) {
      if (digits.startsWith(c.dial)) { matched = c; break; }
    }
  }
  // Fall back to a caller-provided country hint (e.g. resolved from the card's country field).
  if (!matched && countryHint) matched = resolveCountry(countryHint);

  const e164 = hasPlus ? `+${digits}` : matched ? `+${matched.dial}${digits.replace(new RegExp(`^${matched.dial}`), "").replace(/^0+/, "")}` : null;
  return {
    field: "phone",
    value: v,
    status: "valid",
    dialCode: matched ? matched.dial : hasPlus ? digits.slice(0, Math.min(3, digits.length)) : null,
    country: matched ? matched.name : null,
    e164,
    message: !hasPlus && !matched ? "No country/dial code detected" : undefined,
  };
}

export function normalizePhone(input: string | null | undefined, countryHint?: string | null): string | null {
  const p = validatePhone(input, countryHint);
  return p.e164 ?? null;
}

// ── Postal code ───────────────────────────────────────────────────────────────
export function validatePostalCode(input: string | null | undefined, country?: string | null): FieldValidation {
  const v = s(input);
  if (!v) return { field: "postalCode", value: null, status: "empty" };
  const ref = resolveCountry(country);
  if (ref?.postal) {
    const ok = ref.postal.test(v.trim());
    return { field: "postalCode", value: v, status: ok ? "valid" : "warning", message: ok ? undefined : `Does not match the ${ref.name} postal-code format` };
  }
  // No country-specific rule: accept a generic 3-10 char alphanumeric code.
  const ok = /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/.test(v.trim());
  return { field: "postalCode", value: v, status: ok ? "valid" : "warning", message: ok ? undefined : "Unusual postal-code format" };
}

// ── Company name normalization ────────────────────────────────────────────────
const LEGAL_SUFFIX_RE = /[.,]?\s*\b(l\.?l\.?c|inc|incorporated|ltd|limited|co|corp|corporation|gmbh|s\.?a|s\.?r\.?l|plc|pvt|pte|fzco|fze|fz-?llc|w\.?l\.?l)\b\.?$/i;

export function normalizeCompanyName(input: string | null | undefined): string | null {
  const v = s(input);
  if (!v) return null;
  // Collapse whitespace + tidy spacing around punctuation. Legal suffix is left intact
  // (dropping it can change identity); we only tidy casing of ALL-CAPS words to Title Case
  // when the whole string is uppercase, otherwise preserve the author's casing.
  let out = v.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();
  if (out === out.toUpperCase() && /[A-Z]/.test(out)) {
    out = out.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  }
  return out;
}

export function hasLegalSuffix(input: string | null | undefined): boolean {
  const v = s(input);
  return v ? LEGAL_SUFFIX_RE.test(v) : false;
}

// ── Country code normalization ────────────────────────────────────────────────
export function normalizeCountry(input: string | null | undefined): string | null {
  const ref = resolveCountry(input);
  return ref ? ref.name : s(input);
}

// ── Address normalization ─────────────────────────────────────────────────────
export function normalizeAddress(input: string | null | undefined): string | null {
  const v = s(input);
  if (!v) return null;
  return v.replace(/\s*\n\s*/g, ", ").replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").replace(/,\s*,/g, ",").trim();
}

// ── Aggregate analysis over a captured field set ──────────────────────────────
export interface CaptureValidationResult {
  validations: FieldValidation[];
  suggestions: NormalizationSuggestion[];
  detectedCountry: string | null;
  detectedDialCode: string | null;
}

function suggest(list: NormalizationSuggestion[], field: string, original: string | null, suggested: string | null, reason: string): void {
  if (original != null && suggested != null && suggested !== original) {
    list.push({ field, original, suggested, reason });
  }
}

export function analyzeCaptureFields(fields: CaptureFields): CaptureValidationResult {
  const validations: FieldValidation[] = [];
  const suggestions: NormalizationSuggestion[] = [];

  const countryRef = resolveCountry(fields.country);
  const countryHint = fields.country ?? null;

  // Validations.
  validations.push(validateEmail(fields.email));
  validations.push(validateWebsite(fields.website));
  const mobileV = { ...validatePhone(fields.mobile, countryHint), field: "mobile" };
  validations.push(mobileV);
  if (fields.officePhone != null) validations.push({ ...validatePhone(fields.officePhone, countryHint), field: "officePhone" });
  validations.push({ ...validateCountryField(fields.country) });
  if (fields.postalCode != null) validations.push(validatePostalCode(fields.postalCode, fields.country));

  // Normalization suggestions (accept/reject; originals preserved).
  suggest(suggestions, "email", s(fields.email), normalizeEmail(fields.email), "Lowercase + trim whitespace");
  suggest(suggestions, "website", s(fields.website), normalizeWebsite(fields.website), "Add https:// and drop trailing slash");
  suggest(suggestions, "mobile", s(fields.mobile), normalizePhone(fields.mobile, countryHint), "Format in international (E.164) form");
  if (fields.officePhone != null) suggest(suggestions, "officePhone", s(fields.officePhone), normalizePhone(fields.officePhone, countryHint), "Format in international (E.164) form");
  suggest(suggestions, "company", s(fields.company), normalizeCompanyName(fields.company), "Tidy spacing/casing");
  suggest(suggestions, "country", s(fields.country), normalizeCountry(fields.country), "Use the canonical country name");
  suggest(suggestions, "address", s(fields.address), normalizeAddress(fields.address), "Tidy address formatting");

  const detectedDialCode = mobileV.dialCode ?? (countryRef ? countryRef.dial : null);

  return {
    validations,
    suggestions,
    detectedCountry: countryRef ? countryRef.name : null,
    detectedDialCode,
  };
}

function validateCountryField(input: string | null | undefined): FieldValidation {
  const v = s(input);
  if (!v) return { field: "country", value: null, status: "empty" };
  const ref = resolveCountry(v);
  return { field: "country", value: v, status: ref ? "valid" : "warning", message: ref ? undefined : "Unrecognized country — could not match a known country" };
}

// Derive a website from an email domain (deterministic gap-fill). Returns null for
// free/personal email providers so we never suggest gmail.com as a company website.
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com", "outlook.com", "live.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "yandex.com", "mail.com",
]);

export function websiteFromEmail(email: string | null | undefined): string | null {
  const v = normalizeEmail(email);
  if (!v || !EMAIL_RE.test(v)) return null;
  const domain = v.split("@")[1];
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) return null;
  return `https://${domain}`;
}

export function countryFromDialCode(phone: string | null | undefined): string | null {
  const p = validatePhone(phone);
  return p.country ?? null;
}
