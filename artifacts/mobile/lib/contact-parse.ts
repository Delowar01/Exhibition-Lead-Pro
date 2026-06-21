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
    website: data.website ?? null,
    linkedin: data.linkedin ?? null,
    address: data.address ?? null,
  };
}

export function parseVCard(raw: string): ExtractedCardData {
  const out: ExtractedCardData = {};
  for (const line of raw.split(/\r?\n/)) {
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.split(";")[0].toUpperCase();
    const value = rest.join(":").trim();
    if (!value) continue;
    switch (key) {
      case "FN": {
        const parts = value.split(" ");
        out.firstName = parts[0] ?? null;
        out.lastName = parts.slice(1).join(" ") || null;
        break;
      }
      case "N": {
        const [last, first] = value.split(";");
        if (first) out.firstName = first;
        if (last) out.lastName = last;
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
      case "TEL":
        out.mobile = value;
        break;
      case "URL":
        if (/linkedin\.com/i.test(value)) out.linkedin = value;
        else out.website = value;
        break;
      case "ADR":
        out.address = value.replace(/;/g, " ").trim();
        break;
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
      else if (/^(email|emailaddress|mail|e-mail)$/.test(key)) out.email = value;
      else if (/^(website|web|url|site|homepage)$/.test(key)) assignUrl(out, value);
      else if (/^linkedin$/.test(key)) out.linkedin = value;
      else if (/^(address|addr|location)$/.test(key)) out.address = value;
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
    /(name|company|org|title|designation|role|mobile|phone|tel|cell|email|e-mail|website|web|url|addr|address)\s*[:=]/i.test(
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
    const v = add[k];
    const current = out[k];
    if ((current == null || current === "") && v != null && String(v).trim() !== "") {
      out[k] = v;
    }
  });
  return out;
}

export function hasAnyContactField(data: ExtractedCardData): boolean {
  return Object.values(data).some((v) => v != null && String(v).trim() !== "");
}
