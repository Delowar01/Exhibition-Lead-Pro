# G-7 — Platform Owner Analytics

Status: **implemented** on `claude/platform-owner-analytics-g7` (branched from the release
candidate `d1e884b…`). Local development branch only — not merged, not deployed, and kept
separate from the release candidate until that release has passed its gates. It replaces the
"Detailed Analytics coming soon" placeholder at `/platform/analytics` (gap register item
G-7 in `docs/B23_FINAL_RECONCILIATION.md`).

No new table, no schema change, no new provider, no new runtime dependency. The module
only reads existing tables through seven new read-only endpoints.

The existing Platform Dashboard (`/platform`) was aligned with the module's definitions in
the final polish pass (§9). A separate, not-yet-approved proposal for timestamp indexes is
in `docs/G7_INDEX_PROPOSAL.md`; no index is part of this branch.

## 1. What the page shows

One reporting period scopes every tab. The period, the bucket size and the open tab live
in the URL (`?tab=…&range=…` or `?from=…&to=…`, `&granularity=…`), so a view can be
bookmarked.

| Tab | Content | Source |
| --- | --- | --- |
| Overview | New / active companies and users, card scans, contacts, leads, AI requests — each against the previous period; scan and new-company trends; subscription status today; estimated recurring revenue; estimated AI cost. One request. | all of the below |
| Growth | New and running-total companies and company users | `companies.created_at`, `users.created_at` |
| Subscriptions | Today: by status, billing method, access, plan distribution. In the period: new subscriptions, moves into each status, plan changes | `subscriptions`; `audit_logs` (`subscription.*` rows, before/after status and plan) |
| Revenue & billing | **Estimate** of recurring revenue (MRR, ARR, by plan); **collected revenue: not available**; **actual** billing events as counts (payments, failed payments, checkouts, notifications) | `revenueSnapshot()`; `billing_provider_events`; `billing_checkout_sessions` |
| Activity | Captures, card scans, contacts, leads; trends; captures by source; card scans by processing status; most active companies (volumes only) | `scans`, `contacts`, `leads` |
| AI usage | Requests, failures, tokens, **estimated** cost, by feature, by company, failure causes | `ai_invocations` (the Enterprise AI Layer ledger) |
| Operations | Sign-ins, audit events by area, security events by type, billing notifications, job-queue snapshot | `login_attempts`, `audit_logs`, `security_events`, `billing_provider_events`, `job_queue` |

Every chart has a table view with the same figures. Loading keeps the previous figures on
screen; a failed request shows an explanation with a retry and never a figure in its place.

## 2. API

All `GET`, all under the platform firewall (`requireAuth` + path-scoped
`requireRole("platform_owner")`): anonymous → 401, every tenant role → 403.

```
/api/v1/platform/analytics/overview
/api/v1/platform/analytics/growth
/api/v1/platform/analytics/subscriptions
/api/v1/platform/analytics/revenue
/api/v1/platform/analytics/activity
/api/v1/platform/analytics/ai
/api/v1/platform/analytics/operations
```

Query (identical on every endpoint; contract in `lib/api-spec/openapi.yaml`):

- `from`, `to` — UTC calendar days (`YYYY-MM-DD`), both inclusive; an ISO date-time with an
  explicit zone is evaluated as its UTC day (one without a zone is refused). Default: the
  last 30 days ending today. Maximum 731 days; years 1970–2100.
- `granularity` — `day` | `week` (ISO, Monday) | `month`. Default: day up to 62 days, week
  up to 366, month beyond. `day` is refused beyond 366 days.
- An invalid window is a `400` with `code: "INVALID_ANALYTICS_WINDOW"`.

Every response echoes the evaluated `range`, including the previous period (the same number
of days, ending the day before `from`). Series are zero-filled, one point per bucket.

Code: `routes/platform-analytics.ts` → `services/platform-analytics.service.ts` →
`repositories/platform-analytics.repository.ts`; window arithmetic in
`lib/analytics-window.ts`. Existing calculations are reused, not duplicated:
`subscriptionMetrics()`, `revenueSnapshot()`, the AI ledger aggregates of
`ai.repository.ts`, and the dashboard's company/user totals. The three reporting
definitions that more than one screen uses — company user, capture, card scan — are SQL
fragments in one file, `repositories/platform-definitions.ts`, shared by the dashboard,
the Analytics module and the per-company user count.

## 3. Definitions

- **Capture** — any `scans` row that is not deleted. The table holds one row per capture:
  card images read by OCR, and every contact saved without OCR (QR, vCard, digital card,
  e-mail signature, NFC, typed in, imported). The origin is `capture_source`.
- **Card scan** — a capture that went through OCR (`extraction_method` is not `manual`).
  This is the filter of the platform dashboard's scan trend. `extraction_method` says only
  whether OCR ran — it is never used as the capture source.
- **User** — a company user that exists today: not a deleted account and not a platform
  operator. The platform dashboard's "Total Users" and the "Users" figure of a company use
  the same rule (§9).
- **Active company** — at least one card scan or new contact in the period. **Active user** —
  a company user (as defined above) with at least one successful sign-in in the period: a
  sign-in by an account that has since been deleted, or by a platform operator, does not
  make an active user. Sign-in counts on the Operations tab are a different measure — they
  cover every attempt on the platform, whoever made it.
- **Subscription changes** — derived from the audit trail: a move *into* a status is a row
  whose after-status differs from its before-status; a new subscription is a
  `subscription.create` row; `subscription.repair_create` (a data repair) is excluded.
- **Estimated recurring revenue** — verified provider prices × subscriptions the provider
  reports as live, normalised to a month. It is an estimate as of now, independent of the
  selected period, and is "Unavailable" with the reason whenever it cannot be computed
  (no verified prices, mixed currencies, …). Manually managed subscriptions carry no price
  and are never part of it. The annual run rate is that monthly figure × 12 and is labelled
  so. Amounts are shown in the currency's own minor unit (no cents assumed for yen or dinar).
- **Collected revenue** — always reported as not available: this system stores no invoice
  or payment amount. Nothing is estimated in its place.
- **Paid invoices / failed payments** — `invoice.paid` / `invoice.payment_failed`
  notifications that were processed for a known subscription. Counts only: a paid invoice
  says nothing about how much was paid (it may be a zero-amount invoice).
- **Shares** — a breakdown that lists only the largest parts (audit areas, security event
  types, notification types) is measured against the true total and shows the rest as
  "Other".
- **AI cost** — estimated from token usage and the platform price table; not an invoice.

## 4. Security and privacy

- Platform Owner only; the tenant firewall is unchanged (the Platform Owner still cannot
  open tenant CRM routes).
- Responses contain counts, sums, plan ids/names and company ids/names only — never a
  contact, lead, scan, user, e-mail, IP address, note, audit metadata or AI prompt/response
  text. `g7-platform-analytics.test.ts` asserts this over every endpoint.
- Read-only: no write path exists under `/platform/analytics`.

## 5. Load on the shared database

Tenant requests and platform reporting share one connection pool, and several source
tables (`audit_logs`, `login_attempts`, `security_events`) have no index on their timestamp.

- Every analytics query runs through a process-wide gate (`lib/read-gate.ts`), at most two
  at a time, however many analytics requests are in flight — reporting cannot occupy the
  pool.
- The landing view is one request (the overview carries its two chart series).
- Tabs open on Enter/Space, not on arrow-key focus, so moving along the tab bar does not
  load every tab.
- The window is capped at 731 days on every endpoint.

Not done here, because it is a schema change that needs its own approval and a controlled
rollout on the hosted database: timestamp indexes on `audit_logs`, `login_attempts`,
`security_events` and `billing_provider_events`. Without them the Operations and
Subscriptions tabs scan those tables in full; the gate bounds the concurrency, not the
duration. The analysis, the exact DDL, the measured plans and the rollout order are in
`docs/G7_INDEX_PROPOSAL.md` (seven indexes on those four tables; a time index on `leads`
was measured and rejected because it slows the tenant leads list).

## 6. Web

`pages/platform/Analytics.tsx` (filters, URL state, tabs), one section component per tab in
`components/platform/analytics/`, pure helpers in `lib/platform-analytics.ts`. New
design-system components in `components/ds`: `ChartCard` (with a chart/table switch),
`DataTable`, `TrendChart`, `ChartLegend`, `BreakdownList`, `SegmentedBar`; `MetricCard`
gained `deltaIntent` (a rise in failures is not coloured as good).

Charts use the existing chart tokens. Those tokens separate reliably only in pairs
(orange + indigo, indigo + red), so no chart draws more than two coloured series; three
measures are shown as three small charts. Subscription status uses the status tokens and
always prints the status name and its count.

## 7. Tests

```bash
pnpm --filter @workspace/api-server exec vitest run test/g7-platform-analytics.test.ts test/unit-analytics-window.test.ts test/unit-read-gate.test.ts
pnpm --filter @workspace/web-app run test                                   # unit + component (new script)
pnpm --filter @workspace/web-app exec playwright test e2e/zg-platform-analytics.spec.ts --trace off
```

- API integration (41): exact aggregates over synthetic rows dated in an isolated window
  (January 2001) and written the way the API writes them, window validation, 401/403 for
  every role, firewall/no-leak checks, SQL written in the test as the oracle for users.
- API unit (25): window parsing, limits and bucket boundaries (20); the read gate (5).
- Web unit + component (55): helpers and design-system components (static render). This
  adds a `test` script and a `vitest.config.ts` to the web app, using the `vitest` version
  the workspace already has; the web typecheck now covers the test files too.
- Playwright (26): live figures against the page's own API responses, filters and URL
  state, loading/error/stale/empty states, revenue wording, truncated-list shares, role
  routing, keyboard use, desktop 1440 / tablet 820 / mobile 390 layouts, dark theme. Set
  `G7_SHOTS_DIR` to save screenshots.

Full local regression on the code of this branch (commit `1369447…`, fresh disposable
database, filesystem object storage, durable job queue, stub AI provider, fake billing
provider; API suite run once on a freshly started API):

| Suite | Result | Before this batch |
| --- | --- | --- |
| API | 1871 passed / 0 failed / 11 skipped of 1882 (134 files) | 1805 / 0 / 11 of 1816 |
| Playwright | 205 / 205 | 179 / 179 |
| Mobile | 332 / 332 (26 files) | 332 / 332 |
| Web unit + component | 55 / 55 (new suite) | — |
| Workspace typecheck, API build, web build | pass | pass |

The skipped API tests are the pre-existing, classified skips; none belongs to this batch.

## 8. Limits (by design, from the data that exists)

- No payment amounts exist, so there is no collected-revenue figure and no revenue history;
  the estimate is a current snapshot.
- Subscription changes exist only since the audit trail records them, and one subscription
  can appear in several rows (trial started, then activated).
- Growth counts rows that exist today by creation date; a permanently deleted company or a
  deleted user account is not counted in any period.
- "Active or trialing" counts a trial that has just run out until the lifecycle sweep
  moves it.
- The job queue keeps completed jobs for a few days only, so jobs are a current snapshot.
  With the in-process job driver there are no queue figures.
- Subscription and revenue "today" figures do not change with the selected period.
- All buckets are UTC days; there is no per-viewer time zone.
- An AI ledger row stamped in the last 999 microseconds of a period's final day is counted
  in neither that period nor the next (about one row in 86 million).
- No CSV export, no per-company drill-down beyond the link to the company page, no
  scheduled reports. These are possible follow-ups, not part of this batch.

## 9. Platform Dashboard alignment (final polish)

The dashboard at `/platform` predates this module and reported three figures by different
rules. They now follow the definitions of §3; the page keeps its design (the same six
cards, three charts and company table).

| Figure | Before | Now |
| --- | --- | --- |
| Total Users | every row of `users`, including deleted accounts and platform operators | company users that exist today — the same figure as the Analytics overview |
| "Users" of a company (dashboard table, Companies pages) | every row of that company, including deleted accounts | company users that exist today |
| Total Scans card | every capture row, including deleted ones, labelled "Cards captured system-wide" | the card is **Total Captures** (every capture that is not deleted) and names the OCR figure beneath it: "N card scans read by OCR" |
| Scan trend chart | card scans read by OCR, titled "Scan Volume" | unchanged figures, titled **Card Scan Volume** with a description that says captures saved without OCR are not included |
| MRR / ARR cards | amount ÷ 100 for every currency | `formatMinor()` — the currency's own minor unit (¥5,000 is no longer shown as ¥50; 10,000 fils are 10.000 dinars) |

API contract (`GET /platform/stats`): every existing field is kept. `totalUsers` and
`totalScans` keep their names and now carry the definitions above; `totalCaptures` is
added. The OpenAPI descriptions of `totalUsers`, `totalScans`, `totalLeads` and of a
company's `userCount` / `contactCount` / `scanCount` now state what each counts.

Active users (`signInCounts()` in `platform-analytics.repository.ts`): the count excluded
platform operators but not deleted accounts, against the definition in §3. It now applies
the shared company-user rule, and reads the sign-ins of the period once instead of once
per user (1.6 s → 0.28 s over a year of three million synthetic sign-ins, same result).

Also corrected on the dashboard: the page no longer scrolls sideways at phone width (the
company table now scrolls inside its card).

Tests: `g7-platform-dashboard.test.ts` (API, 9) proves each rule as a before/after delta
with synthetic rows and independent SQL as the oracle — a new user counts, a deleted
account does not, deleting and restoring an account moves the total, an account that
becomes a platform owner leaves it, six live captures of which three were read by OCR add
6 and 3, and the dashboard and Analytics report the same users. `g7-platform-analytics`
gained sign-ins by a deleted account and by the platform owner (counted as sign-ins,
never as active users). `zh-platform-dashboard.spec.ts` (Playwright, 9) checks the cards
against the API, the labels, the company table, US dollar / yen / Kuwaiti dinar /
unavailable revenue, and the layout at 1440 / 820 / 390.

Left unchanged, for a separate decision:

- The plan and subscription screens (`pages/platform/Plans.tsx`,
  `pages/platform/Subscriptions.tsx`, `pages/admin/Subscription.tsx`,
  `components/platform/PlanVersions.tsx`) still format prices as amount ÷ 100, and the
  manual-price form of `PlanVersions.tsx` converts typed amounts with × 100. Correct for
  two-decimal currencies only; changing the form is a write-path change.
- A company's `scanCount` (the "Scans" figure on the company pages) counts every capture
  row of the company, including deleted ones. Its API description now says so.

## 10. After integration: documents to update

These living documents still describe G-7 as an unapproved placeholder or carry the
pre-G-7 test totals. They are deliberately untouched on this branch (they are being edited
by the release documentation in its own pull request); update them when G-7 is merged.

| Document | Update |
| --- | --- |
| `CLAUDE.md` — working rules | G-7 is no longer "awaiting owner decision"; record it as implemented, with its merge commit and deployment state. Baseline line: new API / Playwright / mobile totals and the new web unit suite |
| `CLAUDE.md` — tests section | add `pnpm --filter @workspace/web-app run test` to the command list |
| `docs/LOCALHOST_DEVELOPMENT.md` §7 | the authoritative baseline totals (API, Playwright, mobile, web unit); note that no new skip was added |
| `docs/B23_FINAL_RECONCILIATION.md` | gap register: G-7 row from "placeholder / awaiting decision" to implemented, with a pointer to `docs/G7_PLATFORM_ANALYTICS.md` |
| `docs/PROJECT_TECHNICAL_BRIEF.md` | Platform Owner portal: Analytics is a seven-tab module, not a placeholder; seven read-only endpoints under `/platform/analytics`; the process-wide read gate; `GET /platform/stats` gained `totalCaptures` |
| `docs/PROJECT_FILE_MAP.md` | new files: `routes/platform-analytics.ts`, `services/platform-analytics.service.ts`, `repositories/platform-analytics.repository.ts`, `repositories/platform-definitions.ts`, `lib/analytics-window.ts`, `lib/read-gate.ts`; web `pages/platform/Analytics.tsx`, `components/platform/analytics/*`, `components/ds/{ChartCard,TrendChart,Breakdown}.tsx`, `lib/platform-analytics.ts`, `vitest.config.ts`; the two docs |
| `replit.md` | operational summary: the Analytics module and the new web test command |
| Master roadmap / release notes | G-7 delivered; follow-ups awaiting decisions: the index proposal (`docs/G7_INDEX_PROPOSAL.md`), currency-aware prices on the plan and subscription screens, the company "Scans" figure |
| `lib/db/migrations/README.md` | only if the index proposal is approved: add the `0041` row |
