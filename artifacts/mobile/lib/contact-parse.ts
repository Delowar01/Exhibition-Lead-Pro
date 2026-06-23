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
  // Defer name resolution: collect raw N components and FN display string, then
  // cross-reference them after the loop so we can detect whether a generator
  // used the spec order (Family;Given) or the common non-compliant order
  // (Given;Family). Without this, N:John;Doe is misread as firstName=Doe.
  let pendingN: [string, string] | null = null; // [part0, part1] from N field
  let pendingFn: string | null = null;           // FN display string
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
        pendingFn = value;
        break;
      }
      case "N": {
        const parts = value.split(";");
        if (parts.length >= 2) {
          // Defer — store for cross-reference with FN after the loop.
          pendingN = [parts[0] ?? "", parts[1] ?? ""];
        } else {
          // Single-component N with no semicolons (some QR generators omit the
          // structured separator): treat the whole value as a full name and
          // space-split it so "John Smith" → firstName="John" lastName="Smith"
          // rather than the entire name landing in lastName only.
          setName(out, value);
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
        // vCard 4.0 may carry a "mailto:" URI scheme — strip it.
        out.email = value.replace(/^mailto:/i, "").trim();
        break;
      case "TEL": {
        // vCard 4.0 emits TEL;VALUE=uri:tel:+1555... — drop the "tel:" scheme so
        // the stored number is dialable and not prefixed with junk.
        const tel = value.replace(/^tel:/i, "").trim();
        if (!tel) break;
        // Prefer CELL/MOBILE-typed numbers for the mobile field; route WORK /
        // HOME / other explicit non-cell types to officePhone. An untyped TEL
        // defaults to mobile so the most common QR codes (single number, no
        // TYPE param) still populate the right field.
        const isMobile =
          /CELL|MOBILE/i.test(params) || !/WORK|HOME|FAX/i.test(params);
        if (isMobile) {
          if (!out.mobile) out.mobile = tel;
        } else {
          if (!out.officePhone) out.officePhone = tel;
        }
        break;
      }
      case "URL":
        if (/linkedin\.com/i.test(value)) out.linkedin = value;
        else if (!out.website) out.website = normalizeWebsite(value);
        break;
      case "ADR": {
        // ADR is semicolon-delimited: PoBox;Ext;Street;Locality;Region;Postal;Country
        // Extract country from the 7th component and build a clean address from
        // the remaining meaningful components (street, city, region, postal).
        // cleanAdrPart trims whitespace AND stray commas: real-world cards often
        // bake a comma into a single component (e.g. "Al Khubra,"), which would
        // otherwise produce a double comma once components are re-joined.
        const adrParts = value.split(";");
        const street = cleanAdrPart(adrParts[2]);
        const locality = cleanAdrPart(adrParts[3]);
        const region = cleanAdrPart(adrParts[4]);
        const postal = cleanAdrPart(adrParts[5]);
        const country = cleanAdrPart(adrParts[6]);
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

  // Resolve names: cross-reference N components with FN to detect field order.
  // Many real-world QR generators emit N:Given;Family (reversed from RFC 2426).
  // If FN is present we use it as a ground truth: whichever N component matches
  // the first word of FN is the given name (firstName). Falls back to spec order
  // (Family;Given) when only N is present, and to FN word-split when only FN.
  if (pendingN !== null) {
    const [nPart0, nPart1] = pendingN;
    if (pendingFn) {
      // Strip leading honorifics ("Dr.", "Eng.", "Sheikh", ...) so the FN's
      // first word is the actual given name, not a title. Without this, a card
      // with FN:"Dr. John Smith" + N:"Smith;John" failed both order checks and
      // fell back to a raw FN split → firstName="Dr.", lastName="John Smith".
      const fnWords = stripHonorifics(pendingFn.trim().split(/\s+/));
      const fnFirst = (fnWords[0] ?? "").toLowerCase();
      if (fnFirst && nPart1.trim().toLowerCase().startsWith(fnFirst)) {
        // N is in spec Family;Given order → nPart1 = given name
        if (nPart1.trim()) out.firstName = nPart1.trim();
        if (nPart0.trim()) out.lastName = nPart0.trim();
      } else if (fnFirst && nPart0.trim().toLowerCase().startsWith(fnFirst)) {
        // N is in reversed Given;Family order → nPart0 = given name
        if (nPart0.trim()) out.firstName = nPart0.trim();
        if (nPart1.trim()) out.lastName = nPart1.trim();
      } else {
        // Ambiguous order (FN uses a nickname/variant matching neither N part,
        // single-token N, initials). We cannot reliably tell Family;Given from
        // Given;Family, so use the honorific-stripped FN word-split — the FN is
        // the human-readable display name and yields a usable first/last. Do NOT
        // blindly assume RFC order here: many generators emit Given;Family, so a
        // forced Family;Given would SWAP names for the nickname case.
        setName(out, fnWords.join(" ") || pendingFn);
      }
    } else {
      // No FN — trust RFC 2426 spec order: Family;Given
      if (nPart1.trim()) out.firstName = nPart1.trim();
      if (nPart0.trim()) out.lastName = nPart0.trim();
    }
  } else if (pendingFn && !out.firstName && !out.lastName) {
    // No N field and no name already set (e.g. from single-component N) — use
    // the honorific-stripped FN so a leading title never lands in firstName.
    setName(out, stripHonorifics(pendingFn.trim().split(/\s+/)).join(" ") || pendingFn);
  }

  return out;
}

// Common name-leading honorifics/titles (incl. UAE/Gulf "Sheikh"/"Sheikha"),
// matched case-insensitively with an optional trailing dot. Never strips the
// final remaining token, so a name that is *only* a title stays intact.
const HONORIFICS = new Set([
  "dr", "mr", "mrs", "ms", "miss", "mx", "prof", "professor", "eng", "engineer",
  "sir", "madam", "rev", "fr", "hon", "capt", "col", "gen", "lt", "sgt", "maj",
  "sheikh", "sheikha", "shaikh", "shaikha", "hh", "he",
]);

function stripHonorifics(words: string[]): string[] {
  let i = 0;
  while (i < words.length - 1) {
    const w = words[i].toLowerCase().replace(/\.$/, "");
    if (HONORIFICS.has(w)) i++;
    else break;
  }
  return words.slice(i);
}

// Normalize a single structured-ADR component: strip whitespace (incl. stray
// \r left by QR encoders that lose the \n of a CRLF fold) and surrounding commas.
// Real cards frequently bake a comma into one component (e.g. "Al Khubra,"),
// which would produce a double comma ("Al Khubra,, ...") once components rejoin.
function cleanAdrPart(part: string | undefined): string {
  return (part ?? "").replace(/[\s,]+$/, "").replace(/^[\s,]+/, "").trim();
}

// Normalize a website value to a tappable https:// URL. Scheme-less values
// (e.g. "www.elitemarcom.com", "acme.com/me") get an https:// prefix; values
// that already carry a scheme are returned unchanged.
function normalizeWebsite(value: string): string {
  const v = value.trim();
  if (!v) return v;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  if (/^(www\.[^\s]+|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/[^\s]*)?)$/i.test(v)) {
    return `https://${v.replace(/^\/\//, "")}`;
  }
  return v;
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
  // "Website QR" without a scheme — e.g. "www.example.com" or "acme.com/me".
  // Requires a single token with a domain + TLD (≥2 letters) so opaque codes
  // like "BOOTH-42" still fall through to the company branch below. Normalizes
  // to https:// so the saved website is tappable.
  if (
    !/\s/.test(v) &&
    /^(www\.[^\s]+|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/[^\s]*)?)$/i.test(v)
  ) {
    const out: ExtractedCardData = {};
    assignUrl(out, `https://${v.replace(/^\/\//, "")}`);
    return out;
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

// Count populated contact fields (ignoring the verbatim `original` payload). Used
// to rank multiple decode candidates and keep the richest as the merge base.
function contactFieldCount(data: ExtractedCardData): number {
  return Object.entries(data).filter(
    ([k, v]) => k !== "original" && v != null && String(v).trim() !== "",
  ).length;
}

// Parse a QR scan from one or more candidate payloads and return the richest
// result.
//
// WHY this exists: Android's barcode engine (Google ML Kit, via expo-camera)
// PARSES structured QR codes (vCard / MECARD) and exposes a lossy, human-readable
// display string in `result.data` — it strips the BEGIN:VCARD wrapper and drops
// most fields (ML Kit's getDisplayValue() "may omit some of the information
// encoded in the barcode"). The original, complete payload is only in
// `result.raw`. iOS/web return the full payload in `result.data` and leave `raw`
// empty. Feeding only `result.data` to the parser therefore yields an empty /
// company-only contact on Android even though detection succeeded — the exact
// "QR detected but no contact extracted" device failure.
//
// We parse every distinct non-empty candidate, then keep whichever yielded the
// most fields as the base and let the others fill any gaps. This is robust to
// platform differences (raw-only, data-only, or both) without hardcoding any one
// QR or assuming which field carries the raw bytes.
export function parseQrBest(
  ...candidates: (string | null | undefined)[]
): ExtractedCardData {
  const seen = new Set<string>();
  const parsed: ExtractedCardData[] = [];
  for (const candidate of candidates) {
    const trimmed = (candidate ?? "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    parsed.push(parseQr(trimmed));
  }
  if (parsed.length === 0) return {};
  parsed.sort((a, b) => contactFieldCount(b) - contactFieldCount(a));
  return parsed.reduce((acc, next) => mergeExtracted(acc, next));
}
