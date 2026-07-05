---
name: Unknown saved-view payloads + export filter-key subset
description: Two front-end contract traps on the pipeline/leads surface — normalize `unknown` saved-view payloads before applying, and only forward server-supported export filter keys.
---

## Saved-view (saved-search) payloads are `unknown` — normalize, never cast
Saved searches/views return `payload` typed as `unknown`. A blind `as Partial<...>` cast plus spread into state lets a legacy/hand-edited/malformed payload (e.g. `filters.stages = null`, non-array `sorting`, wrong `columnPinning` shape) drive table/filter state and fault at render.

**Rule:** run every restored payload through a defensive normalizer that field-by-field coerces types and falls back to safe defaults (enum whitelists for viewMode/groupBy/status, array-of-string filters, `{id:string,desc:boolean}[]` sorting, boolean-only columnVisibility, string[] pinning). See `normalizeViewState`/`normalizeFilters` in `components/pipeline/utils.tsx`.
**Why:** views persist across schema/UI changes; the shape you wrote last month is not guaranteed today.

## Export dialog only forwards keys the server export understands
The lead export service accepts only `stage` (SINGLE string), `assignedToId`, `eventId`. The rich pipeline filter set (multi-`stages[]`, team, priority, tag, value range, search, status) has no server export representation.

**Rule:** map the rich UI filters down to the supported subset before passing to `ExportDialog` (e.g. `stage` only when exactly ONE stage selected; owner→`assignedToId`; event→`eventId`). Passing `filters={{}}` silently exports unfiltered data while the UI implies filtered context; passing unsupported keys is a no-op at best.
**How to apply:** confirm accepted keys in `services/export.service.ts` for the entity, then build the subset object; `cleanFilters` in `ExportDialog` drops empties.
