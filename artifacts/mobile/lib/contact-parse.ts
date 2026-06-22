import type { ContactInput, ExtractedCardData } from "@workspace/api-client-react";

// Shared on-device contact parsing used by QR and NFC capture. Keeping these in
// one place means every code-based capture method extracts identical fields and
// any new format support benefits all callers.

export function extractedToContact(data: ExtractedCardData): ContactInput {
  return {
    firstName: data.firstName ?? null,
    lastName: data.lastName ?? null,
    jobTitle: data.jobTitle ?? null,
    contactCompany: data.company ?? null,
    email: data.email ?? null,
    mobile: data.mobile ?? null,
    officePhone: data.officePhone ?? null,
    website: data.website ?? null,
    linkedin: data.linkedin ?? null,
    country: data.country ?? null,
    address: data.address ?? null,
  };
}

// Escape a value for a vCard 3.0 property per RFC 2426: backslash, newline,
// comma, and semicolon are the reserved characters.
function escapeVCard(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

export interface VCardFields {
  fullName?: string | null;
  companyName?: string | null;
  designation?: string | null;
  primaryPhone?: string | null;
  alternatePhone?: string | null;
  email?: string | null;
  website?: string | null;
  officeAddress?: string | null;
}

// Build a standards-compliant vCard 3.0 string from a business card's fields.
// Empty fields are omitted. The output is meant to be embedded directly in a QR
// code so a native camera offers "Add Contact" with the fields pre-filled — it
// intentionally carries no hosted-card/landing URL.
export function buildVCard(fields: VCardFields): string {
  const clean = (v?: string | null): string => (v ?? "").trim();
  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];

  const fullName = clean(fields.fullName);
  if (fullName) {
    const parts = fullName.split(/\s+/);
    const first = parts[0] ?? "";
    const last = parts.slice(1).join(" ");
    // N is structured: Family;Given;Additional;Prefix;Suffix
    lines.push(`N:${escapeVCard(last)};${escapeVCard(first)};;;`);
    lines.push(`FN:${escapeVCard(fullName)}`);
  }

  const company = clean(fields.companyName);
  if (company) lines.push(`ORG:${escapeVCard(company)}`);

  const title = clean(fields.designation);
  if (title) lines.push(`TITLE:${escapeVCard(title)}`);

  const primary = clean(fields.primaryPhone);
  if (primary) lines.push(`TEL;TYPE=CELL:${escapeVCard(primary)}`);

  const alt = clean(fields.alternatePhone);
  if (alt) lines.push(`TEL;TYPE=WORK,VOICE:${escapeVCard(alt)}`);

  const email = clean(fields.email);
  if (email) lines.push(`EMAIL;TYPE=INTERNET:${escapeVCard(email)}`);

  const website = clean(fields.website);
  if (website) lines.push(`URL:${escapeVCard(website)}`);

  const address = clean(fields.officeAddress);
  if (address) {
    // ADR is structured: PoBox;Ext;Street;Locality;Region;Postal;Country.
    // We keep the whole address in the Street component.
    lines.push(`ADR;TYPE=WORK:;;${escapeVCard(address)};;;;`);
  }

  lines.push("END:VCARD");
  return lines.join("\r\n");
}

// Decode a QUOTED-PRINTABLE value (vCard 2.1 / Outlook / many QR & NFC writers)
// into a UTF-8 string. `=XX` byte escapes are mapped to percent-escapes and run
// through decodeURIComponent so multi-byte UTF-8 (e.g. Arabic names) decodes
// correctly. Falls back to the raw value if decoding fails.
function decodeQuotedPrintable(input: string): string {
  if (!/=[0-9A-Fa-f]{2}/.test(input)) return input;
  try {
    // Escape any literal "%" FIRST (otherwise decodeURIComponent throws on a
    // value like "100%"), then map the QP "=XX" byte escapes to percent escapes
    // so multi-byte UTF-8 (e.g. Arabic) decodes correctly. Malformed "=X"
    // sequences are left untouched by the regex and pass through harmlessly.
    const escaped = input.replace(/%/g, "%25").replace(/=([0-9A-Fa-f]{2})/g, "%$1");
    return decodeURIComponent(escaped);
  } catch {
    return input;
  }
}

// True when a (logical) vCard line's parameters declare QUOTED-PRINTABLE encoding.
function lineIsQuotedPrintable(line: string): boolean {
  const colon = line.indexOf(":");
  const head = colon === -1 ? line : line.slice(0, colon);
  return /ENCODING=QUOTED-PRINTABLE/i.test(head);
}

// Join physical lines into logical vCard lines, handling BOTH wrapping schemes:
//   • RFC 2426/6350 folding — a continuation line begins with a space or tab.
//   • vCard 2.1 QUOTED-PRINTABLE soft breaks — a value line ends with "=".
// Without this, long or non-ASCII (QP) values split across lines were truncated,
// so the contact lost its name/address — exactly the "no data extracted" symptom.
function unfoldVCardLines(raw: string): string[] {
  const physical = raw.split(/\r?\n/);
  const logical: string[] = [];
  for (const line of physical) {
    const prev = logical.length ? logical[logical.length - 1] : null;
    if (prev !== null && /^[ \t]/.test(line)) {
      logical[logical.length - 1] = prev + line.slice(1);
    } else if (prev !== null && /=$/.test(prev) && lineIsQuotedPrintable(prev)) {
      // Only treat a trailing "=" as a QP soft break for QP-encoded properties.
      // A normal 3.0/4.0 value that happens to end with "=" (e.g. a URL or
      // base64-ish token) must NOT absorb the following property line.
      logical[logical.length - 1] = prev.slice(0, -1) + line;
    } else {
      logical.push(line);
    }
  }
  return logical;
}

export function parseVCard(raw: string): ExtractedCardData {
  const out: ExtractedCardData = {};
  // The structured N property (Family;Given) is authoritative for names; FN is a
  // free-form display string we only fall back to when N is absent (its naive
  // space-split mishandles titled or multi-word names like "Dr. John Smith").
  let nameFromN = false;
  for (const line of unfoldVCardLines(raw)) {
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;
    // Strip any group prefix (Apple/iOS exports group properties as
    // "item1.URL", "item2.EMAIL", "item1.ADR", etc.) and any TYPE/ENCODING
    // parameters, leaving the bare property name. Without this, grouped
    // properties were silently dropped and QR/vCard contacts lost their
    // website, email, and address fields.
    const segments = rawKey.split(";");
    const key = segments[0].split(".").pop()!.toUpperCase();
    const params = segments.slice(1).join(";").toUpperCase();
    let value = rest.join(":").trim();
    if (/ENCODING=QUOTED-PRINTABLE/.test(params)) {
      value = decodeQuotedPrintable(value).trim();
    }
    if (!value) continue;
    switch (key) {
      case "FN": {
        if (nameFromN) break;
        const parts = value.split(" ");
        out.firstName = parts[0] ?? null;
        out.lastName = parts.slice(1).join(" ") || null;
        break;
      }
      case "N": {
        const parts = value.split(";");
        if (parts.length >= 2) {
          // Standard structured form: Family;Given[;Additional;Prefix;Suffix]
          const [last, first] = parts;
          if (first?.trim()) out.firstName = first.trim();
          if (last?.trim()) out.lastName = last.trim();
          if (first?.trim() || last?.trim()) nameFromN = true;
        } else {
          // Single-component N with no semicolons (some QR generators omit the
          // structured separator): treat the whole value as a full name and
          // space-split it so "John Smith" → firstName="John" lastName="Smith"
          // rather than the entire name landing in lastName only.
          setName(out, value);
          nameFromN = value.trim().length > 0;
        }
        break;
      }
      case "ORG":
        out.company = value.replace(/;/g, " ").trim();
        break;
      case "TITLE":
        out.jobTitle = value;
        break;
      case "EMAIL":
        out.email = value;
        break;
      case "TEL": {
        // Prefer CELL/MOBILE-typed numbers for the mobile field; route WORK /
        // HOME / other explicit non-cell types to officePhone. An untyped TEL
        // defaults to mobile so the most common QR codes (single number, no
        // TYPE param) still populate the right field.
        const isMobile =
          /CELL|MOBILE/i.test(params) || !/WORK|HOME|FAX/i.test(params);
        if (isMobile) {
          if (!out.mobile) out.mobile = value;
        } else {
          if (!out.officePhone) out.officePhone = value;
        }
        break;
      }
      case "URL":
        if (/linkedin\.com/i.test(value)) out.linkedin = value;
        else if (!out.website) out.website = value;
        break;
      case "ADR": {
        // ADR is semicolon-delimited: PoBox;Ext;Street;Locality;Region;Postal;Country
        // Extract country from the 7th component and build a clean address from
        // the remaining meaningful components (street, city, region, postal).
        const adrParts = value.split(";");
        const street = (adrParts[2] ?? "").trim();
        const locality = (adrParts[3] ?? "").trim();
        const region = (adrParts[4] ?? "").trim();
        const postal = (adrParts[5] ?? "").trim();
        const country = (adrParts[6] ?? "").trim();
        if (country) out.country = country;
        const addrPieces = [street, locality, region, postal].filter(Boolean);
        if (addrPieces.length > 0) {
          out.address = addrPieces.join(", ");
        } else {
          // Fallback for unstructured ADR: collapse all components.
          const raw = value.replace(/;/g, " ").trim();
          if (raw) out.address = raw;
        }
        break;
      }
    }
  }
  return out;
}

function setName(out: ExtractedCardData, value: string): void {
  const parts = value.trim().split(/\s+/);
  out.firstName = parts[0] ?? null;
  out.lastName = parts.slice(1).join(" ") || null;
}

function assignUrl(out: ExtractedCardData, value: string): void {
  if (/linkedin\.com/i.test(value)) out.linkedin = value;
  else out.website = value;
}

// MECARD (and the closely related compact contact syntax some NFC writers use):
//   MECARD:N:Doe,John;ORG:Acme;TITLE:CEO;TEL:+1...;EMAIL:a@b.com;URL:...;ADR:...;;
export function parseMecard(raw: string): ExtractedCardData {
  const out: ExtractedCardData = {};
  const body = raw.replace(/^MECARD:/i, "");
  for (const field of body.split(";")) {
    const idx = field.indexOf(":");
    if (idx === -1) continue;
    const key = field.slice(0, idx).trim().toUpperCase();
    const value = field.slice(idx + 1).trim();
    if (!value) continue;
    switch (key) {
      case "N": {
        const [last, first] = value.split(",");
        if (first !== undefined) {
          out.firstName = first.trim() || null;
          out.lastName = (last ?? "").trim() || null;
        } else {
          setName(out, value);
        }
        break;
      }
      case "ORG":
        out.company = value;
        break;
      case "TITLE":
        out.jobTitle = value;
        break;
      case "TEL":
        out.mobile = out.mobile ?? value;
        break;
      case "EMAIL":
        out.email = value;
        break;
      case "URL":
        assignUrl(out, value);
        break;
      case "ADR":
        out.address = value.replace(/,/g, " ").replace(/\s+/g, " ").trim();
        break;
    }
  }
  return out;
}

// Plain-text contact records: either labeled lines ("Name: ...", "Mobile: ...",
// "Designation: ...") or unlabeled lines we classify heuristically (email / URL
// / phone / name / company). Covers the freeform text written by many standard
// NFC business cards that don't use vCard.
export function parseContactText(raw: string): ExtractedCardData {
  const out: ExtractedCardData = {};
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const labeled = line.match(/^([A-Za-z][A-Za-z .\/_-]*?)\s*[:=]\s*(.+)$/);
    if (labeled) {
      const key = labeled[1].toLowerCase().replace(/[\s._/-]/g, "");
      const value = labeled[2].trim();
      if (!value) continue;
      if (/^(name|fullname|fn)$/.test(key)) setName(out, value);
      else if (/^(firstname|givenname)$/.test(key)) out.firstName = value;
      else if (/^(lastname|surname|familyname)$/.test(key)) out.lastName = value;
      else if (/^(company|org|organization|organisation|employer|business)$/.test(key))
        out.company = value;
      else if (/^(title|jobtitle|designation|role|position)$/.test(key)) out.jobTitle = value;
      else if (/^(mobile|phone|tel|telephone|cell|cellphone|mob|contact|whatsapp)$/.test(key))
        out.mobile = out.mobile ?? value;
      else if (/^(officephone|workphone|businessphone|directline|direct)$/.test(key))
        out.officePhone = out.officePhone ?? value;
      else if (/^(email|emailaddress|mail|e-mail)$/.test(key)) out.email = value;
      else if (/^(website|web|url|site|homepage)$/.test(key)) assignUrl(out, value);
      else if (/^linkedin$/.test(key)) out.linkedin = value;
      else if (/^(address|addr|location)$/.test(key)) out.address = value;
      else if (/^(country|nation)$/.test(key)) out.country = value;
      continue;
    }

    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line)) {
      out.email = out.email ?? line;
    } else if (/^https?:\/\/\S+$/i.test(line)) {
      assignUrl(out, line);
    } else if (/^[\d\s+()./-]{7,}$/.test(line) && line.replace(/\D/g, "").length >= 7) {
      out.mobile = out.mobile ?? line;
    } else if (out.firstName == null && out.lastName == null) {
      setName(out, line);
    } else if (out.company == null) {
      out.company = line;
    }
  }
  return out;
}

export function parseQr(value: string): ExtractedCardData {
  const v = value.trim();
  if (/BEGIN:VCARD/i.test(v)) return parseVCard(v);
  if (/^MECARD:/i.test(v)) return parseMecard(v);

  // Single-token URL or email (the common QR payloads).
  if (/^https?:\/\/\S+$/i.test(v) && !/\s/.test(v)) {
    const out: ExtractedCardData = {};
    assignUrl(out, v);
    return out;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    return { email: v };
  }

  // Anything that looks like structured contact text (multiline, labeled, or
  // containing an email/phone/URL) is parsed for fields; otherwise treat the
  // whole value as a company name (prior behavior for opaque payloads).
  const structured =
    /\r?\n/.test(v) ||
    /(name|company|org|title|designation|role|mobile|phone|tel|cell|email|e-mail|website|web|url|addr|address|country)\s*[:=]/i.test(
      v,
    ) ||
    /[^\s@]+@[^\s@]+\.[^\s@]+/.test(v) ||
    /https?:\/\//i.test(v);
  if (structured) {
    const parsed = parseContactText(v);
    if (hasAnyContactField(parsed)) return parsed;
  }
  return { company: v.slice(0, 120) };
}

// Fill empty fields of `base` from `add` (first non-empty value wins). Used when
// a single NFC tag carries several records (e.g. a name text + a website URI).
export function mergeExtracted(
  base: ExtractedCardData,
  add: ExtractedCardData,
): ExtractedCardData {
  const out: ExtractedCardData = { ...base };
  (Object.keys(add) as (keyof ExtractedCardData)[]).forEach((k) => {
    if (k === "original") return; // verbatim OCR object, not a mergeable text field
    const v = add[k];
    const current = out[k];
    if ((current == null || current === "") && typeof v === "string" && v.trim() !== "") {
      (out as Record<string, unknown>)[k] = v;
    }
  });
  return out;
}

export function hasAnyContactField(data: ExtractedCardData): boolean {
  return Object.entries(data).some(
    ([k, v]) => k !== "original" && v != null && String(v).trim() !== "",
  );
}
