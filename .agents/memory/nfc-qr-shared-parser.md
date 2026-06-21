---
name: NFC/QR shared contact parser
description: Why all text-based contact payloads (QR + NFC) must go through one parser in the mobile app.
---

# Shared contact-text parser for QR and NFC

`parseQr()` in `artifacts/mobile/lib/contact-parse.ts` is the single source of truth
for turning any text contact payload into `ExtractedCardData`. It dispatches:
vCard → `parseVCard`, MECARD → `parseMecard`, bare URL/email handled inline, and any
other structured text → `parseContactText` (labeled lines + unlabeled heuristics),
falling back to `{ company }` for opaque single tokens.

NFC (`lib/nfc.ts`) funnels every NDEF Text/URI/unknown record body through `parseQr`
and combines multiple records with `mergeExtracted`.

**Why:** A first version forked QR-only logic that only knew vCard/URL/email, so
real NFC business cards (MECARD, labeled multiline text) silently collapsed into
`company`. Keeping QR and NFC on one parser prevents that drift and means new tag
formats are added once and benefit both surfaces.

**How to apply:** When adding support for a new contact format (e.g. BIZCARD),
extend `parseQr`/`parseContactText` — do NOT add a parallel parser in a capture
screen. Unit coverage lives in `lib/contact-parse.test.ts` (`pnpm --filter
@workspace/mobile run test`), which runs under plain node because the module has
only a type-import, no React Native runtime deps.
