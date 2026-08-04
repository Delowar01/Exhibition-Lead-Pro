---
name: OCR scan pipeline hardening
description: Verbatim-original contract, policy-denial state reconciliation, cache-vs-budget test trap, and stub extraction patterns for the business-card scan flow.
---

# Verbatim `original` contract
Display-field normalization (e.g. lowercasing the email domain) must NEVER leak into `extractedData.original`. Any `original.<field> ?? fallback` must fall back to the RAW model value captured BEFORE normalization, not the normalized display value.
**Why:** review caught `original.email ?? display.email` silently storing a normalized value as "verbatim" whenever the model omitted `original.email`.
**How to apply:** capture `const rawX = str(parsed.x)` before building `display`, and use `rawX` in original fallbacks. Test it by omitting the field from the stub provider's `original` block so the fallback path is exercised by the standard assertions.

# Policy denials must reconcile optimistic writes
`createScan` increments the usage counter and inserts a `processing` scan row BEFORE calling the provider. A policy denial (429 budget / 403 AI disabled / rate limit = `AppError`) used to rethrow immediately — stranding a forever-`processing` row and inflating the quota. Same class of bug in `replaceScanImage`: image already swapped, then denial rethrown without marking the scan failed (old extractedData no longer matches the stored image).
**How to apply:** every early-throw AFTER an optimistic write must undo/settle that write (mark row `failed`, `decrementScansUsed` floored at 0). Reprocess needs nothing — it mutates nothing before the provider call.

# AI result cache bypasses budget admission
The AI result cache is keyed per prompt+image; a cache hit legitimately skips budget admission (cache hits cost nothing). Budget-denial tests MUST use a never-before-scanned image (generate a fresh sharp image per run) or the 429 never fires.

# validateBody rejects empty bodies
`validateBody(schema)` 400s on `{}` ("must include at least one valid field"). POST bodies that are semantically optional (e.g. reprocess) must send at least one field, e.g. `{ appLanguage: "en" }`.

# Stub provider as OCR test lever
The stub provider carries a full deterministic card body (mixed-case email domain, Arabic name/original city) plus purpose-built models: `stub-nocard` (all-null → 422 SCAN_NO_CARD), `stub-injection` (injection strings + malicious extra keys → proves schema allowlist), `stub-fail` (502 + error ledger row). Extend that set rather than mocking HTTP.

# EXIF orientation
`sharp().rotate()` (no args) in the image compress path applies EXIF orientation — without it, phone photos in portrait store sideways and the provider sees rotated text.
