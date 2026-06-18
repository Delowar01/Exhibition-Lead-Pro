---
name: Contact duplicate exclusion in aggregations
description: Duplicate contacts must be filtered out of every count/stat/group query, not just the contacts list.
---

Contacts flagged as duplicates carry a non-null `duplicateOfId` (set by dedup detection + merge). Any query that COUNTS, SUMS, or GROUPS contacts for dashboards/reports/stats/pipeline must add `isNull(contactsTable.duplicateOfId)` alongside the tenant scope, or duplicates inflate every metric.

**Why:** Dedup was added to the contacts list/merge UI, but the aggregation endpoints kept counting the duplicate rows, so dashboard/report/event totals were higher than the visible (deduped) contact list — a silent inconsistency the user reported.

**How to apply:** Apply to contact aggregations in `reports.ts` (admin-dashboard, lead-intelligence, mobile-dashboard), `contacts.ts` `/contacts/stats`, and `events.ts` (enrichEvent contactCount + `/events/:id/stats`). Do NOT touch `leadsTable` counts — duplicate contacts never spawn leads, so lead metrics are already correct.
