---
name: Import/export access-control gates
description: Permission-gate the whole import flow (not just commit) and neutralize spreadsheet formula injection on export.
---

# Import/export access-control gates

## Gate the whole import flow, not just the write
A multi-step import (preview → validate → commit) must apply the SAME
create-permission gate (`contacts:create` / `leads:create`, chosen by
`entityType`) on ALL steps — not only `commit`.

**Why:** `validate` runs duplicate detection, which reveals whether a given
contact/lead already exists in the tenant. Leaving preview/validate open to any
tenant-authenticated user (on the theory they "don't persist") leaks record
existence to users who lack create permission. `preview` also exposes the field
catalog / auto-mapping.

**How to apply:** put the permission middleware AFTER `validateBody` (so
`req.body.entityType` is populated) and before the handler, on every import
endpoint. `primary_admin`/`platform_owner` bypass permission checks; a
path-scoped `requireTenantUser` still blocks `platform_owner` from tenant CRM.

## Neutralize CSV/Excel formula injection on export
Exported cell values are user-controlled (names, notes, company). A cell whose
text begins with `= + - @` (or a leading tab/CR) is evaluated as a formula by
spreadsheet apps → data-exfil / command payloads on open.

**Why:** CSV has no type info so Excel/Sheets interpret `=...` as a formula;
even XLSX string cells are safer to neutralize uniformly.

**How to apply:** before building the sheet, prefix any triggering cell with a
single quote (`'`) so it renders as literal text. Neutralize row values (header
labels are app-controlled). Covered by `neutralizeCell` unit tests.

## Import commit must be atomic across base rows AND custom-field values
Bulk-import commit inserts base entities (contacts/leads) plus their custom-field
VALUES. Both must commit inside ONE transaction. Do NOT insert base rows, then
apply custom-field values per-row via a separate self-transacting service call —
especially not wrapped in a swallowed `catch {}`.

**Why:** out-of-transaction per-row custom-field writes with a swallowed error
produce SILENT partial imports — the entity is created but its (possibly required)
custom fields are missing, and the API still returns success. Correctness + the
"whole batch atomic on fatal failure" constraint both break.

**How to apply:** thread a single `tx: Executor` (from `repositories/base.ts`)
through the entity `bulkInsert` and a `customFieldsRepo.bulkInsertValues(entries, tx)`
call inside `db.transaction(...)`; let errors propagate (no catch) so the batch
rolls back. Resolve per-row custom-field DEFAULTS + REQUIRED enforcement up-front in
`buildRows` (validate step) so commit only inserts a complete, pre-validated set.
Regression: force a custom-field write failure (map two columns to one custom
field → violates the `(definitionId, entityId)` unique index) and assert NO base
row survives.
