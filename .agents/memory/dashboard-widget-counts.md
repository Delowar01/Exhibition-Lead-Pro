---
name: Dashboard widget list-vs-count
description: Convention for dashboard report endpoints that power both a capped list and a total badge.
---

When a report endpoint feeds a widget that shows BOTH a capped list (e.g. top 6 hot leads / follow-ups) AND a "total" number elsewhere (a KPI card), return a SEPARATE unlimited count field alongside the limited list. Never let the frontend derive the total from `list.length`.

**Why:** The follow-ups KPI once read `followUpsDue.length` while the list was server-capped to 6, so any tenant with >6 due silently undercounted. Architect flagged it as a correctness bug.

**How to apply:** In `reports.ts`-style endpoints, run a `count()` query for the total (same WHERE as the list) and expose it as e.g. `followUpsDueCount`; the list query keeps its `.limit(n)`. Mark the count field required in the OpenAPI schema.

Related: dashboard report endpoints must keep ALL series/aggregate data real and tenant-scoped — `scan-activity` is a DB `to_char(createdAt,'YYYY-MM-DD')` group-by (zero-filled across 30 days), not random; per-event metrics come from `/reports/leads-by-event`, not magic ratios.
