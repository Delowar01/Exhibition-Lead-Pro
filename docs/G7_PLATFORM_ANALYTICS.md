# G-7 — Platform Owner Analytics

Status: **implemented** on `claude/platform-owner-analytics-g7` (branched from the release
candidate `d1e884b…`). Local development branch only — not merged, not deployed, and kept
separate from the release candidate until that release has passed its gates. It replaces the
"Detailed Analytics coming soon" placeholder at `/platform/analytics` (gap register item
G-7 in `docs/B23_FINAL_RECONCILIATION.md`).

No new table, no schema change, no new provider, no new runtime dependency. The module
only reads existing tables through seven new read-only endpoints.

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
`ai.repository.ts`, and the dashboard's company/user totals.

## 3. Definitions

- **Capture** — any `scans` row that is not deleted. The table holds one row per capture:
  card images read by OCR, and every contact saved without OCR (QR, vCard, digital card,
  e-mail signature, NFC, typed in, imported). The origin is `capture_source`.
- **Card scan** — a capture that went through OCR (`extraction_method` is not `manual`).
  This is the filter of the platform dashboard's scan trend. `extraction_method` says only
  whether OCR ran — it is never used as the capture source.
- **User** — a company user that exists today: not a deleted account and not a platform
  operator. (The platform dashboard's "Total Users" counts every user row, including
  deleted accounts, so the two figures can differ — see §8.)
- **Active company** — at least one card scan or new contact in the period. **Active user** —
  a company user with at least one successful sign-in in the period. Sign-in counts on the
  Operations tab cover every attempt on the platform.
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
rollout on the hosted database: timestamp indexes on `audit_logs.created_at`,
`login_attempts.created_at`, `security_events.created_at`,
`billing_provider_events.received_at`, `leads.created_at` and `users.created_at`. Without
them the Operations and Subscriptions tabs scan those tables in full; the gate bounds the
concurrency, not the duration.

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

Pre-existing, outside this batch and left unchanged: the platform dashboard's "Total Users"
counts deleted accounts and platform operators, its "Total Scans" counts every capture row
(not only OCR scans), and its revenue cards divide by 100 for every currency.
