---
name: NFC/QR shared contact parser
description: parseQr/parseVCard/parseMecard/parseContactText in mobile lib/contact-parse.ts are the single source of truth for all text contact payloads (QR + NFC NDEF).
---

# Shared contact parser (QR + NFC)

`parseQr` in `artifacts/mobile/lib/contact-parse.ts` is the one entry point for all
text-based contact payloads — QR codes AND NFC NDEF records both flow through it
(via `parseVCard` / `parseMecard` / `parseContactText`). Extend it in one place;
never fork a per-surface parser.

## vCard property keys carry prefixes/params — normalize before matching

Apple/iOS Contacts export **grouped** properties: `item1.URL`, `item2.EMAIL`,
`item3.ADR`, plus TYPE/ENCODING params (`EMAIL;type=INTERNET`). The bare property
name must be extracted as `rawKey.split(";")[0].split(".").pop()` before the switch,
or grouped properties are silently dropped — the root cause of "QR from an iPhone
loses website/email/address."

**Why:** iOS "share contact" QR/NFC is the most common real-world source; its
vCards are almost always grouped. **How to apply:** any new vCard property handling
must key off the normalized name, not the raw line prefix.

## Name resolution: FN order-detects N; honorifics must be stripped first

N (`Family;Given`) is NOT blindly trusted for order — many real generators emit the
reversed `Given;Family`. The resolver cross-references N's two components against the
first word of FN to detect which order this card uses, then assigns first/last.

**Strip leading honorifics from FN before taking its first word** (Dr/Mr/Eng/Sheikh/
etc, optional trailing dot). Otherwise `FN:"Dr. John Smith"` + `N:"Smith;John"` makes
the first word "Dr.", which matches neither N part → falls through to a raw FN split →
firstName="Dr.". This was a real shipped extraction bug.

**Why:** honorifics are common on Gulf/UAE business cards (the app's market).
**How to apply:** when FN matches NEITHER N component (nickname/variant, single-token
N), fall back to the honorific-stripped FN word-split — do NOT force RFC `Family;Given`
order, because that SWAPS names for the reversed-order nickname case
(`FN:Bob Smith` + `N:Robert;Smith` → wrongly Smith/Robert). Only assume spec order
when there is no FN at all.

## Real QR encoders mangle line endings — never trust clean CRLF

Field QR generators emit mixed/broken endings in ONE payload: `\n`, `\r\n`, AND a
bare `\r` mid-value. A common one: a CRLF fold whose `\n` is lost, leaving
`FN:ASLAM\r SIDHIC` (CR+space, not split by `/\r?\n/`). Name resolution survives
because the FN word-split uses `/\s+/` (matches `\r`), but any field that re-joins
sub-components must `.trim()` each part to drop stray `\r` (ADR region did, so
"\rRiyadh"→"Riyadh"). When adding new structured-field handling, trim per-component.

## ADR components carry baked-in commas → clean before re-joining

A single ADR component often already ends with a comma ("Al Khubra,"); naive
`parts.join(", ")` then yields a double comma. `cleanAdrPart()` strips surrounding
whitespace AND commas per component. Also normalize vCard `URL` values through
`normalizeWebsite()` (scheme-less → https) so saved sites are tappable — the v3.0
`URL:www.x.com` case was previously stored scheme-less.

## vCard 4.0 URI schemes: strip tel:/mailto: from TEL/EMAIL

v4.0 emits `TEL;VALUE=uri:tel:+...` and `EMAIL:mailto:...`; strip the scheme prefix or
the saved number/email carries junk. Scheme-less website QRs (`www.x.com`, `acme.com/me`)
are normalized to `https://` but opaque tokens without a TLD (e.g. `BOOTH-42`) stay a
company name.

## vCard 2.1 / QUOTED-PRINTABLE + folding ARE handled (don't re-add)

`unfoldVCardLines()` joins RFC 2426/6350 folded lines (continuation starts with
space/tab) AND vCard 2.1 QP soft breaks (line ends with `=`). The QP soft-break
join is **gated to QP-encoded properties only** (`lineIsQuotedPrintable`) — a normal
3.0/4.0 value ending in `=` (URL token, base64) must NOT absorb the next line.
`decodeQuotedPrintable()` escapes literal `%` *before* mapping `=XX`→`%XX` then
`decodeURIComponent` (UTF-8 safe, incl. Arabic); without the pre-escape a value like
`100%` throws and silently returns undecoded.

**Why:** vCard 2.1 is the most common QR/Outlook/NFC-writer format; QP-encoded
non-ASCII (Arabic) names came through garbled/empty — the "QR/NFC detected but no
data extracted" symptom. **How to apply:** keep both fixes; only the primary `TEL`
is kept (single `mobile` field by schema).
