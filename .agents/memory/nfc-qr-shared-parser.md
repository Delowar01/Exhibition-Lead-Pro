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

## Name precedence: structured N wins over FN

`N:Family;Given` is authoritative; `FN` is a free-form display string whose naive
space-split mishandles titles/multi-word names ("Dr. John Smith"). Let `N` set the
name and only fall back to `FN` when `N` is absent.

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
