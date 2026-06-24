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
- The server now normalizes to USD server-side (closes tech-debt M1). `api-server/src/lib/currency.ts`
  is a deliberate DUPLICATE of `artifacts/mobile/lib/currency.ts` (FX_RATES_TO_USD) — the mobile
  bundle can't import server code. **Drift trap:** changing a rate in one file silently makes the
  two clients disagree; change both in lockstep. Convert-before-sum is applied on `getPipeline`
  (totalValue + per-stage), `getEventReport.pipelineValue`, `getTeamMemberReport.pipelineValue`,
  and the mobile dashboard. The dashboard uses a GROUP BY currency SQL query, then the service
  converts each currency bucket to USD before summing — never sum raw across currencies at the SQL
  level. The two report lead selects had to add `currency` to their projection for this to work.
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
