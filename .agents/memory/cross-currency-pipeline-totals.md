---
name: Cross-currency pipeline totals
description: Why every pipeline/KPI money total must convert per-lead before summing, and the traps when doing it client-side.
---

# Cross-currency pipeline totals

**Rule:** Any money total that aggregates `lead.value` across leads MUST convert each
lead to the display currency *before* summing — `convertCurrency(value, lead.currency,
displayCurrency)` inside the reduce. Never sum raw `value` across mixed currencies and
then stamp one currency code on the result.

**Why:** A reported bug — USD 35k+25k+15k+10k (=85k) showed "SAR 260.4K" instead of
SAR 318,750 (peg 3.75). Root cause was a raw cross-currency SUM relabeled as SAR. The
math engine (`lib/currency.ts`, SAR peg 3.75) was always correct; the aggregation was
the bug.

**How to apply:**
- This bug hides on EVERY total surface, not just the one reported. When fixing one,
  audit all of them: dashboard, leads list, event report, team-member report. They
  were each independently wrong.
- The server's report endpoints (`api-server/src/routes/reports.ts`) use raw
  `SUM(leads.value)` with no currency normalization — so client screens that display
  the server's aggregate are wrong for mixed-currency data. The durable fix is either
  server-side normalization (per-currency grouping + rates) or client-side per-lead
  conversion. We chose client-side for the mobile screens that already had per-lead
  data; server-side was deferred as larger scope.
- **Trap 1 (staleness):** if you switch a card from a server aggregate to a value
  derived from a *separate* per-lead query (`useListLeads`), the pull-to-refresh
  handler must also `refetch()` that lead query — otherwise the card goes stale.
- **Trap 2 (truncation):** `useListLeads({ limit: N })` caps the rows summed; a list
  with >N leads silently undercounts. The dashboard avoids this by using the
  server-grouped pipeline endpoint (no cap). Client-side per-lead totals are only
  safe when you can fetch all leads.
- "Open pipeline" semantics = `stage NOT IN (won, lost)`; match the server's filter.
- Guard each addend with `Number.isFinite(v)` so one malformed value can't NaN-poison
  the whole total.
