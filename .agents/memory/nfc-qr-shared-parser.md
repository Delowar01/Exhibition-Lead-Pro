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

## Known gaps (not yet handled)

RFC 2426 line-folding (continuation lines) and QUOTED-PRINTABLE value decoding are
not implemented; only the primary `TEL` is kept (single `mobile` field by schema).
