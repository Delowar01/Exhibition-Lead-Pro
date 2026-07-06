---
name: Capture intelligence engine (Stage 5E)
description: Read-only intelligent-capture analysis over business cards — validation, recognition, duplicate warnings, suggestions; JSON-text scan metadata columns; no auto-write.
---

# Capture intelligence engine

Additive upgrade to the business-card capture pipeline. Three read-only endpoints under
`/scans` (`analyze`, `batch-analyze`, `batch/{jobId}`), a pure deterministic validation
lib, and a recognition/suggestion service. Web + mobile surface a "Capture Intelligence"
panel.

## Load-bearing rules (why they exist)

- **Analyze is advisory-only.** It recognizes existing contacts/orgs and warns about
  likely duplicates, but NEVER links, merges, or writes the CRM. Every "Apply" of a
  suggestion is user-initiated in the UI. **Why:** the product's core invariant is AI
  never auto-writes/auto-merges — recognition that silently mutates would break trust and
  tenant safety.
- **Deterministic vs AI provenance must stay honest.** Gap-fill like website-from-email
  and country-from-dial-code is `source: "deterministic"`; only the industry
  classification is AI and it SOFT-DEGRADES (never 500) exposing an `aiDegraded` flag +
  full provenance (provider/model/promptKey/promptVersion). Deterministic rows must never
  be labeled `ai`. **Why:** same rule as the Sales Copilot — provenance is a hard product
  contract.
- **Tenant scope on recognition.** Contact/org matching runs through the tenant scope
  (never `companyId` alone). **Why:** a null-companyId query would leak cross-tenant
  records; recognition is the exact place that would surface other tenants' data.

## Non-obvious implementation traps

- **Scan metadata columns are JSON text, exposed as objects.** `fieldConfidences`,
  `validationStatus`, `qualityMeta` are stored as JSON strings on `scans`. EVERY response
  path (list / get / create-success / create-fail / reprocess / replace) must parse them
  (helper `parsedScanMeta`) or a client gets a raw string where the OpenAPI contract
  promises an object. Easy to fix one path and miss the other five.
- **Static paths before `/:id`.** `/scans/analyze` and `/scans/batch/:jobId` must be
  registered before `/scans/:id` (Express declaration-order match) or `:id` swallows
  them — same class as the contacts/duplicates trap.
- **Verbatim OCR is never overwritten.** The new confidence/provenance columns are
  additive; the original extracted fields and stored image stay untouched.
- **On-device quality score is best-effort + degrades.** The mobile capture-quality
  heuristic must hide (not crash) on web/Expo Go where native signals are unavailable;
  it is advisory and never blocks capture.
