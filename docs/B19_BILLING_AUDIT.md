# Batch 19 — Billing Audit

> **Status (Batch 20):** this audit is a historical record of the tree at `c2cd467`. The P0/P1 findings below were addressed by **Batch 20 — Subscription Lifecycle Integrity and Hybrid Stripe Billing**; the canonical model, transition table, access matrix, repair algorithm, provider boundary and limit semantics that now apply are documented in `docs/B20_SUBSCRIPTION_LIFECYCLE.md`. Where this document and the code disagree, the code (and the B20 document) are authoritative.

**Scope:** audit and documentation only. No schema, API, behavior, generated-client or UI change was made. No payment provider was selected or integrated. Nothing was merged, deployed, or executed against the hosted VPS or hosted database.

**Baseline audited:** `develop` at `c2cd4674977ce517e9ffd8ec7f50688613864dad` (branch `claude/b19-billing-audit`, same tree).

**Evidence convention:** every file reference is workspace-relative with line numbers from the audited tree (`path:Lstart-Lend`). "Local verification" refers to disposable tenants created and deleted on the isolated localhost stack (see §15). Hosted state was **not** inspected; statements about hosted data are explicitly labelled *unknown*.

---

## 1. Executive verdict

**The application has no billing system.** It has a *plan/subscription metadata* layer (three tables, three tenant endpoints, one platform-owner company lifecycle) whose data is duplicated, unsynchronised, unpaid, largely unenforced, and partly fabricated in the UI.

Concretely (each item is proven in the sections below):

| # | Verdict | Evidence |
|---|---|---|
| 1 | There is **no payment provider, checkout, webhook, invoice, receipt, tax, coupon, refund or dunning code** anywhere in the repository. | §7 |
| 2 | **`POST /subscriptions/upgrade` activates any plan for free, for any tenant member (including `employee` with empty permissions), with no transaction, and rewrites `companies.plan/status` even when the tenant has no subscription row.** | §4, §9, local V3/V4/V15 |
| 3 | **`/subscriptions` is not behind the Platform Owner firewall** (`requireTenantUser` is missing). Locally the platform owner account is attached to company 1 and could read and rewrite that tenant's subscription through the ordinary tenant route. | §9, local V14 |
| 4 | **`companies` is the sole record that gates access** (login, per-request, refresh). `subscriptions.status`, `subscriptions.plan` and every limit column are never consulted for access; `subscriptions` is only read by the tenant Subscription page and by the contacts *import* path. | §2, §5, §6 |
| 5 | **Company creation by the platform owner writes no subscription row**; the first tenant read of `GET /subscriptions/current` silently inserts a `free/active` row regardless of `companies.plan`, so a `professional` company reports itself as `free`. | §3, local V1 |
| 6 | **Limits are stored but not enforced** for users, admins, employees, events, scans, storage and API usage. The *only* enforced limit is the contacts limit on CSV import, and it is bypassable by concurrent imports and by ordinary `POST /contacts`. | §5, local V9 |
| 7 | **The `plans` table is never seeded by any code path.** On a fresh database it is empty, `GET /subscriptions/plans` returns `[]`, every upgrade fails with `400 Invalid plan`, and registration falls back to hard-coded defaults. Hosted `plans` content is *unknown*. | §3 |
| 8 | **Platform revenue, MRR, ARR, churn, trends and the entire Platform Subscriptions table are simulated or hard-coded** (`Math.random`, fixed price map missing `business`, fake "Company N Inc" rows, fixed "+8.2% MoM"). | §8, local V12 |
| 9 | **Zero automated tests reference subscriptions, plans, upgrade or billing** in the API suite or Playwright suite. `docs/PROJECT_FILE_MAP.md` L94 cites `test/services.test.ts` as the subscriptions test; that file tests scan URLs and login input validation only. | §10 |

**Overall classification:** P0 data-integrity and authorization defects exist today, independent of any provider decision. Commercial billing is entirely absent. A provider integration built on the current tables would inherit the drift and the unsafe upgrade path; the provider-independent lifecycle must be fixed first (§12).

---

## 2. Architecture and source-of-truth map

### 2.1 Components that exist

| Layer | Files | Role |
|---|---|---|
| Schema | `lib/db/src/schema/companies.ts:22-26`, `lib/db/src/schema/subscriptions.ts:6-27`, `lib/db/src/schema/plans.ts:11-29` | Three tables. `companies` carries `plan`, `status`, `suspendedReason`, `trialEndsAt`, `scansUsed`. `subscriptions` (one per company, `companyId` unique, cascade) carries `plan`, `status`, `scansUsed`, `scansLimit`, `usersLimit`, six per-limit columns, `trialEndsAt`, `renewalDate`, `stripeCustomerId`, `stripeSubscriptionId`. `plans` carries price/currency/limits/`trialDays`/`features`. |
| Tenant API | `artifacts/api-server/src/routes/subscriptions.ts:9-29`, `services/subscriptions.service.ts:5-74`, `repositories/subscriptions.repository.ts:10-39` | `GET /subscriptions/current` (lazy insert), `GET /subscriptions/plans`, `POST /subscriptions/upgrade`. Mounted through `routes/index.ts:85`. |
| Platform company lifecycle | `routes/companies.ts:11-78`, `services/companies.service.ts:40-124`, `repositories/companies.repository.ts:9-52` | Create / read / update / hard-delete / suspend / activate. Platform owner only (`routes/companies.ts:12`). |
| Registration | `services/auth.service.ts:211-250`, `repositories/auth.repository.ts:146-155` | Self-registration (non-production only, `config.ts:10-12`) creates company **and** subscription. |
| Access gate | `lib/company-access.ts:12-27`, `middlewares/requireAuth.ts:99-116`, `lib/sessions.ts:132-144`, `services/auth.service.ts:88-92,127-133` | Blocks or read-onlies a tenant from **`companies.status` + `companies.trialEndsAt` only**. |
| Read-only guards | `middlewares/requireAuth.ts:308-314` (`requireWritable`), `:318-326` (`blockReadOnlyMutations`) | Reject mutations when `req.user.readOnly` (cancelled). |
| Platform statistics | `routes/platform.ts:7-27`, `services/platform.service.ts:3-47`, `repositories/platform.repository.ts:9-37` | Counts, **simulated** revenue and trends. |
| Only limit consumer | `services/import.service.ts:411-421` | Contacts limit on CSV import. |
| Scan counter | `services/scans.service.ts:107-108,122-131`, `repositories/scans.repository.ts:126-134` | Increments/decrements **`companies.scansUsed`**. |
| Web | `artifacts/web-app/src/pages/admin/Subscription.tsx`, `pages/platform/Subscriptions.tsx`, `pages/platform/Dashboard.tsx`, `pages/platform/Companies.tsx`, `pages/admin/Organization.tsx:83-84`, `components/layouts/SidebarFooter.tsx:4-14`, `components/layouts/AdminLayout.tsx:43,78,90` | Display only; no upgrade/plan-change action exists in any UI. |
| Contract | `lib/api-spec/openapi.yaml:3726-3771` (subscriptions), `:9583-9626` (CompanyInput/CompanyUpdate), `:1210-1240` (suspend/activate), `:11581-11662` (Subscription, Plan, SubscriptionUpgradeInput), `:12057-12076` (PlatformStats); generated `lib/api-zod/src/generated/api.ts:746,784-794`; `lib/api-client-react` hooks `useGetCurrentSubscription` (used), `useListPlans` and `useUpgradeSubscription` (`api.ts:12929`, unused by web and mobile). | |
| Mobile | none | No subscription, plan, limit or read-only logic. Only notification-category icons `artifacts/mobile/lib/notification-center.ts:14-24`. |

### 2.2 Authoritative record per concern (as implemented)

| Concern | Authoritative record today | Evidence | Notes |
|---|---|---|---|
| **Login blocking** (suspended / expired / lapsed trial) | `companies.status`, `companies.trialEndsAt` | `services/auth.service.ts:127-133` → `repositories/auth.repository.ts:55-61` → `lib/company-access.ts:14-22` | `subscriptions.status` never read. |
| **Per-request blocking** | same | `middlewares/requireAuth.ts:101-113` | Fresh `companies` read every request. |
| **Refresh-token blocking** | same | `lib/sessions.ts:132-144` | Same policy function. |
| **Read-only mode** | `companies.status = 'cancelled'` | `lib/company-access.ts:23-25`, `requireAuth.ts:114,155-170,308-326` | Not exposed to clients: `GET /auth/me` returns no `readOnly`/`companyStatus` (`services/auth.service.ts:32-52`). Clients learn it only from 403 bodies. |
| **Plan display — tenant sidebar / Organization page** | `companies.plan` | `AdminLayout.tsx:43,78,90` ← `GET /organization` (`routes/org.ts:14`); `Organization.tsx:83-84` | |
| **Plan display — tenant Subscription page** | `subscriptions.plan` / `subscriptions.status` | `pages/admin/Subscription.tsx:8,21-27` ← `GET /subscriptions/current` | **Can disagree with the sidebar on the same screen** (local V1: sidebar `professional`, page `free`). |
| **Plan display — platform Companies list** | `companies.plan` | `pages/platform/Companies.tsx:149-150` ← `GET /companies` | |
| **Limit checks** | `subscriptions.contactsLimit` (import only) | `services/import.service.ts:414-421` | No other limit column is read anywhere (repo-wide grep, §5). |
| **Scan usage** | `companies.scansUsed` is written; `subscriptions.scansUsed` is displayed | `scans.repository.ts:126-134` vs `Subscription.tsx:34,37` | Permanently stale (local V9: 6 vs 0). |
| **Price / revenue** | Hard-coded map in `services/platform.service.ts:13`; `plans.priceMonthly` is never used for revenue | | |
| **Trial length** | `plans.trialDays` if a `free` plan row exists, else literal 14 | `services/auth.service.ts:226-231` | Platform-created companies get **no** trial end (`companies.service.ts:43-57` never sets `trialEndsAt`). |

**Conclusion:** for everything that affects access, `companies` wins. For the tenant-facing Subscription page and the import limit, `subscriptions` wins. Nothing reconciles the two.

---

## 3. Schema and data-drift analysis

### 3.1 Field-by-field source of truth

Legend — **W** = written by, **R** = read by, *Enforced* = affects behavior beyond display.

| Field | `companies` | `subscriptions` | `plans` | Enforced? | Winner on disagreement | Constraints | Drift path (confirmed) |
|---|---|---|---|---|---|---|---|
| Plan id | `plan` text, default `free` (`companies.ts:22`). W: create (`companies.service.ts:50`), update (`:85`), upgrade (`subscriptions.service.ts:72`), registration (`auth.service.ts:231`). R: sidebar/Organization/Companies list, `planDistribution`. | `plan` text, default `free` (`subscriptions.ts:9`). W: registration (`auth.service.ts:234`), lazy insert (`subscriptions.service.ts:14`), upgrade (`:61`). R: Subscription page. | `id` text PK (`plans.ts:12`). | Display only. | Access: neither (plan is never checked). Display: depends on page (§2.2). | **No FK** `companies.plan → plans.id`, **no FK** `subscriptions.plan → plans.id`, no CHECK/enum (local `pg_constraint`: only PKs, one FK, one unique). | `POST /companies {plan}` (V1: `professional` vs `free`); `PATCH /companies/:id {plan}` (V5: `enterprise` vs `starter`). |
| Status | `status` text, default `trial` (`companies.ts:23`). W: registration (`trial`), suspend/activate (`companies.service.ts:105`), upgrade (`active`, `subscriptions.service.ts:72`). R: **all access gates**. | `status` text, default `trial` (`subscriptions.ts:10`). W: registration, lazy insert (`active`), upgrade (`active`). R: Subscription page badge only. | — | **Yes, `companies` only.** | `companies`. | none | Suspend/activate never touch `subscriptions` (V6: `suspended` vs `active`); cancelled tenant's Subscription page still says `active` (V7). |
| Suspended reason | `suspendedReason` (`companies.ts:24`). **Never written by any code** (repo grep: zero writers). Accepted by contract `CompanyUpdate` (`openapi.yaml:9625`, `api-zod api.ts:793`) but dropped by `updateCompany` (`companies.service.ts:78-92`). | — | — | No | n/a | none | Contract accepts a field the service ignores (V5: sent `"b19 test"`, stored `null`). |
| Trial end | `trialEndsAt` **timestamp** (`companies.ts:25`). W: registration only. R: access gates. | `trialEndsAt` **date** (`subscriptions.ts:21`). W: registration only. | `trialDays` (`plans.ts:23`). | `companies` only. | `companies`. | Different column types (timestamp vs date). | Platform-created companies: `status='trial'`, `trialEndsAt=NULL` → never expire (V1). Upgrade sets `status='active'` but leaves both trial columns populated (V15). |
| Renewal date | — | `renewalDate` date (`subscriptions.ts:22`). W: upgrade = today + 1 month (`subscriptions.service.ts:57-58,69`). R: Subscription page text. | — | **No** — nothing runs at renewal (§6). | n/a | none | Cosmetic. |
| Scan usage | `scansUsed` int (`companies.ts:26`). W: `incrementScansUsed`/`decrementScansUsed` (`scans.repository.ts:126-134`). R: nothing user-facing. | `scansUsed` int (`subscriptions.ts:11`). W: registration/lazy insert (0), seed-demo (87/64). R: Subscription page (`Subscription.tsx:34,37`). | — | No | Display shows the wrong column. | none | Always drifts after the first scan (V9: `companies=6`, `subscriptions=0`; seed: `companies=0`, `subscriptions=87`). |
| Scan limit | — | `scansLimit` default 50 (`subscriptions.ts:12`). W: registration (literal 50, `auth.service.ts:237`), lazy insert (literal 50), **not updated by upgrade** (`subscriptions.service.ts:60-71` omits it). | **no `scansLimit` column** in `plans`. | **No** (V9: scan accepted with `scansUsed=5`, `scansLimit=1`). | n/a | none | Upgrading to any plan keeps `scansLimit=50`. |
| Users limit | — | `usersLimit` default 1 (`subscriptions.ts:13`). W: literal 1 at registration/lazy insert; never updated by upgrade. | no column | No | n/a | none | Meaningless after upgrade. |
| Admins / employees / contacts / events / storage / API limits | — | six nullable ints (`subscriptions.ts:15-20`). W: registration + lazy insert (from `free` plan row or literal fallbacks `1/0/50/1/100/0`, `auth.service.ts:239-244`, `subscriptions.service.ts:19-24`), upgrade (from plan row, `:63-68`). | same six columns (`plans.ts:17-22`). | **Only `contactsLimit`, only on import** (`import.service.ts:414-421`). | `subscriptions` (import); plan changes on `companies` do nothing. | none | `PATCH /companies {plan}` changes plan without changing any limit (V5). No API exists to override limits per tenant despite the schema comment "platform-owner overridable" (`subscriptions.ts:14`). |
| Feature flags | — | — | `features` jsonb (`plans.ts:24`). R: `listPlans` echo only (`subscriptions.service.ts:44`). | **No consumer** anywhere (repo grep for `.features` outside the service: none). | n/a | none | Stored but unused. |
| Price / currency | — | — | `priceMonthly`, `currency` (`plans.ts:15-16`). R: `listPlans` echo only. | No | Revenue uses a hard-coded map instead (`platform.service.ts:13`). | none | `plans` prices and dashboard revenue can never agree. |
| Provider ids | — | `stripeCustomerId`, `stripeSubscriptionId` (`subscriptions.ts:23-24`). **No reader or writer in the repository** (grep). Returned raw by `GET /subscriptions/current` although absent from the OpenAPI `Subscription` schema (`openapi.yaml:11581-11618`). | — | No | n/a | none | Inert; also a contract/response mismatch. |

### 3.2 Row-existence drift

| Path | `companies` row | `subscriptions` row | Evidence |
|---|---|---|---|
| Self-registration (non-production) | yes (`trial`, trial end set) | yes (`free/trial`, limits from plan or fallbacks) | `auth.service.ts:231-246` |
| `POST /companies` (platform owner) | yes (`plan` from body or `free`, `status` default `trial`, **no `trialEndsAt`**) | **no** | `companies.service.ts:43-57`; local V1 `subscription_rows_for_A_after_create = 0` |
| First `GET /subscriptions/current` by any member | unchanged | inserted as **`free/active`** regardless of `companies.plan` | `subscriptions.service.ts:10-25`; local V1 (`professional/trial` vs `free/active`) |
| `POST /subscriptions/upgrade` with no row | `plan` and `status='active'` rewritten | **still none**; response body is empty (`res.json(undefined)`) | `subscriptions.service.ts:60-72`, `subscriptions.repository.ts:29-35`; local V4 (`200`, empty body, `sub_rows=0`, audit row still written) |
| Seed demo | `professional/active` | `professional/active`, `scansUsed 87/64` | `scripts/src/seed-demo.ts:297-331` |
| `DELETE /companies/:id` | hard delete | cascaded | `companies.repository.ts:46-48`, FK cascade `subscriptions.ts:8` |

### 3.3 `plans` is never seeded

* Readers only: `repositories/auth.repository.ts:146-149`, `repositories/subscriptions.repository.ts:15-18,25-27`.
* No writer: `scripts/src/seed-demo.ts` sets plan *strings* only (`:297,310,317`); `docker/scripts/*.sh`, `docker/compose*.yml`, `.github/workflows/*`, Playwright `e2e/global-setup.ts` and all API tests contain no `plans` insert.
* Local database (schema-pushed, seeded, all suites run): `select count(*) from plans` = **0**. `GET /subscriptions/plans` = `[]` (local S0). Consequences: `POST /subscriptions/upgrade` → `400 Invalid plan` for every value; registration uses literal fallbacks (`auth.service.ts:226,239-244`).
* **Hosted `plans` content is unknown** — not inspected in this batch.

### 3.4 Contract vs behavior mismatches

| Contract says | Code does | Evidence |
|---|---|---|
| `PATCH /companies/{id}` accepts `status` and `suspendedReason` | both ignored | `openapi.yaml:9604-9626`, `api-zod api.ts:784-794` vs `companies.service.ts:77-95`; local V5 |
| `Subscription` schema has no `stripe*` fields | response includes them (`null`) | `openapi.yaml:11581-11618` vs local V14 response |
| Plan enum `[free, starter, professional, business, enterprise]` | any string can live in `companies.plan` (no DB constraint); `business` is absent from revenue and from the Companies plan filter | `platform.service.ts:13`, `Companies.tsx:106-110` |
| `PlatformStats.subscriptionDistribution[].status` | contains **plan** names (`planDistribution` aliases `companiesTable.plan` as `status`) | `platform.repository.ts:35-37`, `platform.service.ts:20` |
| `docs/PROJECT_FILE_MAP.md:94` lists `test/services.test.ts` as the subscriptions test | that file has no subscription test | `test/services.test.ts:1-33` |
| `docs/PROJECT_TECHNICAL_BRIEF.md:456` "Plans + subscription lifecycle" | no lifecycle beyond suspend/activate/upgrade | §6 |

---

## 4. Endpoint and permission inventory

| Endpoint | Guards (in order) | Effective permitted actors | Writes | Audit | Evidence |
|---|---|---|---|---|---|
| `GET /subscriptions/current` | `requireAuth`, `blockReadOnlyMutations` (GET passes) | **any authenticated user with a `companyId`**, including `platform_owner` if it has one (no `requireTenantUser`), `employee` with `{}` permissions, cancelled tenants | **Inserts** a `subscriptions` row on first read | none | `routes/subscriptions.ts:9-16`, `subscriptions.service.ts:8-26`; local V1, V7, V14 |
| `GET /subscriptions/plans` | `requireAuth` | any authenticated user | none | none | `routes/subscriptions.ts:19-22` |
| `POST /subscriptions/upgrade` | `requireAuth`, `blockReadOnlyMutations`, `requireWritable`, `validateBody(UpgradeSubscriptionBody)` | **any non-read-only tenant member of any role**; `platform_owner` with a `companyId`. **No `requirePermission`** although the RBAC catalog defines `subscriptions: [view, manage]` (`lib/rbac.ts:31`) with **zero consumers** (repo grep for `"subscriptions", "` in guards: none). | `subscriptions` (plan/status/limits/renewal) then `companies` (plan/status), two statements, **no transaction, no payment** | `subscription.upgrade` via `writeAudit` (`routes/subscriptions.ts:27`), written even when no subscription row was updated (V4) | `routes/subscriptions.ts:25-29`, `subscriptions.service.ts:50-74`; local V3 (employee 200), V4, V15 (admin `{}` 200) |
| `GET /companies`, `GET /companies/:id` | `requireAuth`, `requireRole(platform_owner)` | platform owner | none | none | `routes/companies.ts:11-12,17-29` |
| `POST /companies` | + `blockReadOnlyMutations`, `auditMutations("company")`, `validateBody(CreateCompanyBody)` | platform owner | `companies` only (+ pipeline stages, activity log `company_created`) | `company.post` (entity id absent on create — `req.params.id` undefined) + activity log | `routes/companies.ts:22-24`, `companies.service.ts:40-69` |
| `PATCH /companies/:id` | same | platform owner | `companies` profile + `plan`; `status`/`suspendedReason` dropped | `company.patch` with entity id | `routes/companies.ts:32-34`, `companies.service.ts:77-95`; local V5, V6 audit list |
| `DELETE /companies/:id` | same | platform owner | **hard delete, cascade wipes tenant** (`companies.repository.ts:43-48`) | `company.delete` | `routes/companies.ts:37-39`, `companies.service.ts:97-101` |
| `POST /companies/:id/suspend` / `/activate` | same | platform owner | `companies.status` only | `company.post` + activity log `company_suspended` / `company_activated` | `routes/companies.ts:71-78`, `companies.service.ts:103-124`; local V6 |
| `GET /platform/stats`, `/revenue-trend`, `/scan-trend`, `/activity` | `requireAuth`, `requireRole(platform_owner)` | platform owner | none | none | `routes/platform.ts:6-27`; tenant 403 covered by `test/role-firewall.test.ts:28-39` |
| `POST /auth/register` | `config.auth.enableRegistration` (always off in production) | anonymous (non-production) | `companies` + `subscriptions` + `users` | activity log `company_created` | `config.ts:10-12`, `auth.service.ts:211-255` |
| No endpoint exists for: cancel, downgrade (only `upgrade`, which also accepts a cheaper plan), renew, reactivate, set trial, override limits, list/inspect tenant subscriptions as platform owner, provider webhooks | | | | | grep of `routes/` (`webhook`: none) |

**Web reachability:** `/admin/subscription` is a `ProtectedRoute role="admin"` (`App.tsx:363,120-150`) — every non-platform role (incl. `employee`) can open it; the "Administration" nav group is rendered without a role/permission check (`navigation.tsx:92-104`). `/platform/subscriptions` requires `platform_owner` (`App.tsx:234,137-139`).

---

## 5. Limit-enforcement matrix

Classification: **Enforced** / **Partially enforced** / **UI-only** / **Stored-unused** / **Obsolete (removed scope)** / **Missing**.

| Limit | Configured source | Current-usage source | Enforced? | Enforcement paths | Bypass paths | Error code | Atomic under concurrency? | Class |
|---|---|---|---|---|---|---|---|---|
| Administrators | `subscriptions.adminsLimit` ← `plans.adminsLimit` | none computed | **No** | none — `users.service.ts:140-172` (`createUser`) and `invitations.service.ts:57-145` (`createInvitation`) never count roles | every path | — | n/a | Stored-unused (local V9: `admin` created with `adminsLimit=1` already used → 201) |
| Employees | `subscriptions.employeesLimit` | none | **No** | none | every path (`POST /users`, `POST /invitations`, invitation accept `invitations.service.ts:241-325`) | — | n/a | Stored-unused (V9: two employees with `employeesLimit=0` → 201, 201) |
| Total users | `subscriptions.usersLimit` (literal 1 at creation, never updated by upgrade) | `companies.repository.ts:9-14` counts users for display only | **No** | none | every path | — | n/a | Stored-unused |
| Contacts | `subscriptions.contactsLimit` | `contacts.repository.ts:141-147` (originals, not deleted) | **Partially** | **CSV import only**: `import.service.ts:411-421` (`total + newOriginals > limit` → 400) | `POST /contacts` (`contacts.service.ts:172-…`, no check; V9: 3 created with limit 2), scan→contact save, duplicate merge, **parallel imports** (V9: two concurrent 2-row imports with limit 6 and 3 used → both `200 imported 2`, final count 7) | `400` text "Import would exceed the plan contact limit (N); …" (no machine code) | **No** — read-count then insert, no lock/transaction | Partially enforced |
| Leads | none in schema (`subscriptions`/`plans` have no leads limit) | — | **No** | none (`leads.service.ts:228-…`, `import.service.ts:480-…` `commitLeads` has no check) | — | — | n/a | Missing (no configured limit exists) |
| Events / exhibitions | `subscriptions.eventsLimit` | none | **No** | none (`events.service.ts:36-43`) | every path | — | n/a | Stored-unused (V9: 2 events with limit 1 → 201, 201) |
| Scans (single) | `subscriptions.scansLimit` (literal 50, never updated) | `companies.scansUsed` (`scans.repository.ts:126-134`) | **No** | none — `scans.service.ts:107-108` increments unconditionally; only image validity and the AI layer gate the call | every path | — | increment is a single SQL `+1` (atomic) but nothing compares it | Stored-unused (V9: scan accepted at `scansUsed=5`, `scansLimit=1`; counter went to 6, display column stayed 0) |
| Batch capture (`POST /scans/batch-analyze`) | same | **not counted** | **No** | none — `capture-batch.service.ts:140-143` calls the AI provider per item, creates no scan row, touches no counter | itself | — | n/a | Missing (V9: 2-item batch → 202, `companies.scansUsed` unchanged, `ai_invocations` written) |
| Manual contact creation writes a `scans` row | — | `contacts.service.ts:235,267` insert `captureSource: manual` rows | — | — | — | — | — | Note: `scans` row count ≠ `scansUsed` (V9: 4 rows vs counter 6) |
| Imports (row volume) | literal `MAX_ROWS = 5000` (`import.service.ts:32,76`) | — | Enforced (per file) | `preview/validate/commit` | repeat imports | `400` | per request | Enforced (not plan-based) |
| Storage (documents/images/exports) | `subscriptions.storageLimitMb` | none — no per-tenant byte accounting exists (`documents.service.ts`, `documentStorage.ts`, `export.service.ts` grep) | **No** | only a per-file cap `MAX_DOCUMENT_SIZE = 25 MB` (`documentStorage.ts:7,98-100`, 413) and scan image cap 10 MB (`image-validation.ts:12,92-96`) | unlimited file count | `413` per file | n/a | Stored-unused (upload paths could not be exercised locally: storage `not_configured`) |
| API usage | `subscriptions.apiLimit` | none | **No** | `middlewares/rateLimit.ts:9-52` are **auth-only** IP/email limiters (`app.ts:144-149`); no per-tenant API metering | all non-auth routes | `429` (auth only) | n/a | Stored-unused. Public API keys are **Obsolete (removed scope, 8C)** — this column has no remaining purpose. |
| AI budgets vs subscription limits | `ai_settings.monthlyTokenBudget` / `monthlyCostBudgetMicroUsd` (tenant-set, `null` = unlimited) | `ai_invocations` ledger + reservations | **Yes, independently** | `ai.service.ts:138-…` (`reserveBudgetIfConfigured`), reservation-based admission | none within the AI layer | `AI_BUDGET_EXCEEDED` / `AI_RATE_LIMITED` | reservation-based | Enforced — **but unrelated to plan**: no plan sets an AI budget; a `free` tenant has unlimited AI unless it configures its own budget |
| Plan feature flags | `plans.features` jsonb | — | **No** | none (no consumer) | — | — | n/a | Stored-unused |
| Workflow-created records | tasks / follow-ups / notifications only (`lib/workflows/actions.ts:9-11,217,241,267,301-303`) | — | n/a | never creates contacts/leads/events/users | — | — | — | Not applicable (no limited entity is created by workflows) |

**Summary:** 0 limits fully enforced against plan configuration; 1 partially (contacts, import only, racy); 9 stored-unused/missing; 1 obsolete (API usage, removed scope); AI budgets enforced but decoupled from plans.

---

## 6. Lifecycle matrix

| Transition | API / UI | Permitted actor | Data written | Access effect | Audit event | Background processing | Idempotent | Transaction | Status |
|---|---|---|---|---|---|---|---|---|---|
| Tenant creation (self-registration) | `POST /auth/register` (non-production only); no UI in production | anonymous | `companies` (`free/trial`, `trialEndsAt=+trialDays`), `subscriptions` (`free/trial`, limits), `users` (primary_admin) | full access until trial end | activity log `company_created`; `user.login` on login | none | no (unique email 4xx) | **no** (three inserts, `auth.service.ts:231-250`) | Implemented (dev/test only) |
| Tenant creation (platform) | `POST /companies`; **no web dialog** (grep `useCreateCompany` in web: none) | platform owner | `companies` only, `status='trial'`, **`trialEndsAt=NULL`** | full access, **never expires** | `company.post` + activity log | none | no | no | **Partial / unsafe** (no subscription row, no trial end) |
| Trial start | implicit in creation | — | see above | — | — | none | — | — | Partial |
| Trial expiry | none; evaluated lazily on login/request/refresh from `companies.trialEndsAt` (`company-access.ts:20-22`) | — | **nothing written**; `companies.status` stays `trial` | login/request/refresh 403 "Your free trial has ended. Please choose a plan to continue." (V8) | none | **none** (`scheduler.ts:82-95`: followUpReminders, maintenance, exportSchedules, workflowAlerts, aiUsageAlerts only) | — | — | Partial (blocking works, no state, no notification, no self-service path) |
| Activation (trial → paid) | `POST /subscriptions/upgrade` | **any tenant member** (V3, V15) | `subscriptions.plan/status/limits/renewalDate`, `companies.plan/status='active'` | unblocks a lapsed trial **only if the user can reach the endpoint — they cannot, login is blocked** (V8) | `subscription.upgrade` | none | yes (rewrites) | **no** | **Unsafe** (unpaid, unauthorized, non-transactional) |
| Upgrade | same endpoint | same | same | none (plan is not enforced) | same | none | yes | no | Unsafe |
| Downgrade | same endpoint accepts a cheaper plan (no ordering check, `subscriptions.service.ts:54-55`) | same | same; no proration, no usage check against the lower limits | none | same | none | yes | no | Unsafe / absent as a distinct concept |
| Renewal | none; `renewalDate` is cosmetic (`Subscription.tsx:41`) | — | — | — | — | none | — | — | **Absent** |
| Cancellation at period end | none | — | — | — | — | — | — | — | **Absent** |
| Immediate cancellation | none via API; only a direct DB write of `companies.status='cancelled'` | — | — | read-only: login 200, GET 200, mutations 403 "Your account is read-only. Reactivate your subscription to make changes." (V7) — **but the reactivation path (`/subscriptions/upgrade`) is itself blocked by `blockReadOnlyMutations`** (`routes/subscriptions.ts:10`; V7) | none | none | — | — | **Partial / contradictory** |
| Failed / pending payment | none | — | — | — | — | — | — | — | **Absent** |
| Suspension | `POST /companies/:id/suspend`; Companies page action (`Companies.tsx:29-45,174`) | platform owner | `companies.status='suspended'`; `subscriptions.status` untouched (V6) | login/request/refresh 403 "Your company account has been suspended. Please contact support." (V6; `test/session-security.test.ts:113-134`) | `company.post` + activity `company_suspended` | none | yes | single update | Implemented (companies only) |
| Expiry (`expired`) | none via API; only direct DB write | — | — | login 403 "Your subscription has expired. Please renew to continue." (V8) | none | none | — | — | Partial (state reachable only by hand) |
| Grace period | none (no column, no logic) | — | — | — | — | — | — | — | **Absent** |
| Reactivation | `POST /companies/:id/activate` (platform) sets `active` regardless of prior state (`companies.service.ts:122-124`); tenant self-reactivation impossible while blocked/read-only | platform owner | `companies.status='active'` | restores existing sessions (`session-security.test.ts:126-133`) | `company.post` + activity `company_activated` | none | yes | single update | Implemented (platform-only, no subscription sync) |
| Deletion | `DELETE /companies/:id` | platform owner | hard delete + cascade of every tenant table (`companies.repository.ts:43-48`) | immediate | `company.delete` (audit rows are not cascaded: `audit_logs`, `activity_logs`, `ai_invocations` keep orphan/`NULL` references) | none | yes | single statement | Implemented (irreversible, no soft-delete/retention) |

---

## 7. Provider and payment capability matrix

All rows verified by repository grep (imports, routes, env, dependencies, tests) — **not** inferred from column names.

| Capability | Present? | Evidence |
|---|---|---|
| Provider SDK / dependency (Stripe, Moyasar, HyperPay, Paddle, PayPal, Tap, Checkout.com, Chargebee, LemonSqueezy) | **No** | `grep -ri` across every `package.json` (excluding `node_modules`): no match |
| Provider configuration / env vars | **No** | `.env.example` (only the registration note at L88-89); `config.ts` has no billing keys (L160 comment: pricing is "cost VISIBILITY only (never billing)") |
| Checkout / payment session creation | **No** | no route, service or client code; no "checkout" string in `artifacts/` or `lib/` |
| Signed webhooks / event ingestion | **No** | `grep -ri webhook artifacts/api-server/src`: none (also removed-scope note in `docs/STAGE_3_ROADMAP.md:163,220` — *provider* webhooks remain allowed, none exist) |
| Replay / idempotency for provider events | **No** | n/a (no ingestion) |
| Payment attempts / transactions table | **No** | `lib/db/src/schema/` listing: no payments/invoices/transactions table |
| Invoices / receipts / credit notes | **No** | "Invoice" appears only as a *document category* label (`documentStorage.ts:49,69`) |
| Billing periods / cadence (monthly, yearly) | **No** | only `renewalDate = today + 1 month` (`subscriptions.service.ts:57-58`); `plans` has `priceMonthly` only |
| Auto-renewal | **No** | no scheduler task (`scheduler.ts:82-95`) |
| Taxes / VAT | **No** | `companies.vatNumber` is a profile field only (`companies.ts:11`) |
| Discounts / coupons | **No** | none |
| Refunds | **No** | none |
| Failed-payment recovery / dunning | **No** | none; no `past_due` state in any enum |
| Customer billing portal | **No** | tenant page is read-only display (`Subscription.tsx`) |
| Provider event history / reconciliation | **No** | none |
| Provider identifiers | **Columns only** | `subscriptions.stripeCustomerId/stripeSubscriptionId` (`subscriptions.ts:23-24`), never read or written |
| Notification categories `billing`, `subscription` | **Labels only** | `notifications.service.ts:9-20`; no emitter with either category (grep) |

**Real-provider status: none.** The roadmap's own audit (`lead-capture-pro-master-phase-1-9-roadmap-audit.md:42,80,139`) already records this; the code confirms it.

---

## 8. UI and fabricated-data register

| Surface | Element | What it shows | Truth | Evidence |
|---|---|---|---|---|
| `/platform/subscriptions` | "In Trial" KPI and Trial slice | `Math.floor(totalCompanies * 0.15)` | invented; real `status='trial'` count is never queried | `Subscriptions.tsx:26,33,106` |
| same | "Churned" KPI / Cancelled slice | `total − active − fakeTrial` | arithmetic on an invented number | `:27,35,115` |
| same | "Past Due" slice and tab | `Math.floor(active * 0.05)`; no such state exists in the data model | invented | `:34,206` |
| same | MRR card | `stats.monthlyRevenue` = hard-coded `{free:0, starter:29, professional:99, enterprise:299}` × plan counts; `business` → 0; `plans.priceMonthly` ignored | simulated (comment "Simulate monthly revenue", `platform.service.ts:12-14`); local V12: adding a `business` company changed revenue by 0, `starter` by +29 | `Subscriptions.tsx:23,76`, `platform.service.ts:13-14` |
| same | "+8.2% MoM" | string literal | fabricated | `:78` |
| same | "MRR Overview" chart | `GET /platform/revenue-trend` (`1200 + (11−i)*450 + random(0..300)`) then `value × (1 + i×0.02)` | random on every call (V12: first value 1494 then 1247) | `platform.service.ts:24-36`, `Subscriptions.tsx:55-58` |
| same | "Revenue by Plan" pie | fixed 55 % / 35 % / 10 % split of MRR | fabricated | `:38-42` |
| same | "Subscription List" table | 10 rows "Company N Inc", random users (5–54), MRR 999/49/99, random renewal dates, statuses by index | entirely fake; not one real tenant | `:44-53,226-253` |
| same | status filter tabs | filter the fake rows | non-functional against real data | `:201-209,226-227` |
| same | "Manage" button | no handler | non-functional | `:248-250` |
| same | page subtitle "Manage billing and track recurring revenue" | there is nothing to manage | misleading | `:65` |
| `/platform` dashboard | MRR / ARR cards, "MRR Growth" chart, "Active vs Churned" pie | same simulated `monthlyRevenue`, `arr = mrr × 12`, random trend; "Churned" = every non-`active` company (trial companies count as churned) | simulated / mislabelled | `Dashboard.tsx:33-34,44,70-77,99-100,141-142`; `platform.service.ts:19` |
| `/platform` dashboard | scan trend | `40 + random(0..120)` per day | random (V12: 117 then 83) | `platform.service.ts:38-47` |
| `/platform/companies` | Plan filter | omits `business` | incomplete vs contract enum | `Companies.tsx:106-110` |
| `/admin/subscription` | Status badge | `subscriptions.status` (`active` for a cancelled or suspended tenant — V6/V7) | wrong record | `Subscription.tsx:21-23` |
| same | Plan name | `subscriptions.plan` (`free` for a platform-created `professional` company — V1) while the sidebar on the same screen shows `companies.plan` | contradictory | `Subscription.tsx:27` vs `AdminLayout.tsx:78,90` |
| same | "Scans Usage X / Y" and progress bar | `subscriptions.scansUsed` (never incremented) / `scansLimit` (literal 50) | stale on both sides (V9: shows 0 while real counter is 6) | `Subscription.tsx:34,37` |
| same | progress bar when unlimited | constant `value={10}` | placeholder | `:39` |
| same | "Monthly limit resets on {renewalDate \| 'billing cycle'}" | nothing resets anything | misleading | `:41` |
| same | absence of any action | no upgrade/cancel/manage control although the API allows unpaid upgrade to anyone | — | whole file |
| Sidebar / Organization page | plan badge | `companies.plan` (label map includes `business`) | can disagree with Subscription page | `SidebarFooter.tsx:4-14`, `Organization.tsx:83-84` |
| Notifications page / mobile | "Billing" and "Subscription" categories | labels with no producer | dead categories | `Notifications.tsx:20-31`, `notification-center.ts:14-24` |

---

## 9. Security, tenant-isolation, concurrency and audit findings

| ID | Finding | Severity | Evidence |
|---|---|---|---|
| S1 | **Unpaid, unauthorized plan change.** `POST /subscriptions/upgrade` has no permission check and no payment step; an `employee` with `{}` permissions (who is denied `POST /contacts` by the matrix) changed the tenant to `starter` and raised `contactsLimit` 2 → 100. | **P0** | `routes/subscriptions.ts:25`, `subscriptions.service.ts:50-74`; local V3 (`403` on contacts, `200` on upgrade) |
| S2 | **Platform Owner firewall gap.** `/subscriptions` lacks `requireTenantUser` while every CRM router mounts it (`routes/ai.ts:22`, `contacts.ts`, `scans.ts`, … — 29 mounts). Locally the platform owner (`companyId = 1`) read company 1's subscription and rewrote it to `starter` through the ordinary tenant route. Whether the hosted platform owner has a `companyId` is *unknown*. | **P0** | `routes/subscriptions.ts:9-10` vs `requireTenantUser` mount list; local V14 (state restored by hand afterwards, one `subscription.upgrade` audit row for company 1 remains in the local DB) |
| S3 | **Non-transactional dual write.** Upgrade updates `subscriptions` then `companies` as separate statements; a failure between them leaves the two disagreeing. When no subscription row exists the first statement is a no-op and the second still runs. | P0 (integrity) | `subscriptions.service.ts:60-72`, `subscriptions.repository.ts:29-39`; local V4 |
| S4 | **GET with side effects.** `GET /subscriptions/current` inserts a row; the insert is unguarded (`insertSubscription` plain insert, unique on `company_id`). Eight parallel first reads locally all returned 200 with one row — the race was **not reproduced** locally, but no code prevents it (a lost race would surface as a 500 through `errorHandler.ts:44-56`). | P1 | `subscriptions.service.ts:8-25`, `subscriptions.repository.ts:20-23`; local V2 |
| S5 | **Lazy row defaults to `free/active` regardless of `companies.plan`/`status`.** A `professional/trial` company reports `free/active`. | P0 (integrity) | local V1 |
| S6 | **Import limit is check-then-insert without a lock.** Two concurrent imports each passed the check and the tenant ended at 7 contacts with limit 6. | P1 | `import.service.ts:414-421`; local V9 |
| S7 | **Read-only tenants cannot reactivate.** `blockReadOnlyMutations` is mounted on `/subscriptions` before the upgrade route, so the message "Reactivate your subscription to make changes" points to an action the same middleware forbids. | P1 | `routes/subscriptions.ts:10,25`, `requireAuth.ts:318-326`; local V7 |
| S8 | **Blocked tenants have no self-service path.** Suspended/expired/lapsed-trial users cannot log in (`auth.service.ts:127-133`), refresh (`sessions.ts:132-144`) or call any route (`requireAuth.ts:110-113`), so "Please choose a plan to continue" / "Please renew to continue" are unreachable instructions. | P1 | local V6, V8 |
| S9 | **Platform-created companies never expire** (`status='trial'`, `trialEndsAt NULL`, trial check requires a date). | P1 | `companies.service.ts:43-57`, `company-access.ts:20`; local V1 |
| S10 | **`suspendCompany` / `activateCompany` / `PATCH plan` never touch `subscriptions`**; `PATCH` silently drops `status`/`suspendedReason` that the contract accepts. | P1 | `companies.service.ts:77-124`; local V5, V6 |
| S11 | **Audit coverage.** Upgrade writes `subscription.upgrade` with `{plan}` but not the previous plan; company mutations write `company.<method>` rows with the path (entity id present for `/companies/:id/*`, absent for `POST /companies`); suspend/activate also write `activity_logs`. Direct DB state changes (the only way to reach `cancelled`/`expired`) are unaudited by definition. Audit rows are **not** removed on company deletion (no FK), which is correct for an append-only trail. | P2 | `lib/audit.ts:16-50`, `routes/subscriptions.ts:27`; local V3, V4, V6 |
| S12 | **Read-only state invisible to clients.** `/auth/me` omits `readOnly`/`companyStatus`; web and mobile have no read-only banner or guard (grep). | P2 | `auth.service.ts:32-52`; web/mobile grep |
| S13 | **Background jobs bypass the lifecycle gate by design** (`loadAuthUserById` comment) — a cancelled tenant's scheduled exports/workflows keep running. | P2 (policy) | `requireAuth.ts:183-184` |
| S14 | **Hard delete of a tenant** is a single unconfirmed platform call with full cascade and no retention window. | P2 | `companies.repository.ts:43-48` |
| S15 | Contract/response mismatch: `stripe*` columns returned but undeclared; `subscriptionDistribution[].status` carries plan ids. | P2 | §3.4 |

Tenant isolation of the subscription **data** itself is intact: `findSubscriptionByCompanyId(user.companyId)` (`subscriptions.service.ts:6-8,51-52`) — a tenant cannot address another tenant's row. The isolation defect is the platform-owner reach (S2), not cross-tenant reach.

---

## 10. Test-coverage gaps

| Area | Existing coverage | Gap |
|---|---|---|
| `/subscriptions/*` | **none** — `grep -ri subscription artifacts/api-server/test artifacts/web-app/e2e` returns nothing | lazy insert, plan listing, upgrade authorization, upgrade side effects, no-row upgrade, plan validation |
| Suspend / activate | `test/session-security.test.ts:113-134` (refresh + `/auth/me` blocked, restored on activate); `test/tenant-isolation-matrix.test.ts:242-245` (tenant admin 403) | subscription-row sync, audit rows, activity rows |
| Trial expiry / expired / cancelled read-only | none | login 403 messages, read-only mutations, reactivation dead-end |
| Limits | `test/import-perms.test.ts` (permissions and mapping only) | contacts import limit, concurrency, every other limit (all unenforced) |
| Platform stats | `test/role-firewall.test.ts:28-39` (403 for tenants, 200 for owner) | revenue correctness (cannot be tested — simulated) |
| Registration | `test/registration-lockdown.test.ts` (production lockdown) | subscription row shape on registration |
| Platform owner reach into `/subscriptions` | none (`test/privacy-platform-owner.test.ts` does not include `/subscriptions`) | S2 |
| Web | no Playwright spec opens `/admin/subscription` or `/platform/subscriptions` | fabricated data would pass unnoticed |
| Documentation | `docs/PROJECT_FILE_MAP.md:94` names `test/services.test.ts` (`:1-33`: scan URL + login input validation) | wrong reference — reported, not silently corrected |

---

## 11. Prioritized findings

### P0 — security and data integrity (provider-independent, fix before anything else)

| ID | Finding | Refs |
|---|---|---|
| P0-1 | Any tenant member can change the plan for free (`POST /subscriptions/upgrade` without permission or payment). | S1 |
| P0-2 | `/subscriptions` is outside the Platform Owner firewall (`requireTenantUser` missing). | S2 |
| P0-3 | Upgrade is a non-transactional dual write that also mutates `companies` when no subscription row exists. | S3 |
| P0-4 | Lazy `GET /subscriptions/current` insert defaults every tenant to `free/active`, contradicting `companies.plan/status`. | S5 |
| P0-5 | No single source of truth: `companies` gates access, `subscriptions` is displayed, nothing reconciles them; no FK/enum constraints on `plan`/`status`. | §2.2, §3.1 |

**Count: 5**

### P1 — provider-independent lifecycle correctness

| ID | Finding | Refs |
|---|---|---|
| P1-1 | Platform-created companies get no subscription row and no trial end (never expire). | S9, §3.2 |
| P1-2 | Suspend / activate / plan edit never sync `subscriptions`; `PATCH` drops `status`/`suspendedReason`. | S10 |
| P1-3 | Cancelled (read-only) tenants are told to reactivate but the endpoint is blocked; blocked tenants have no self-service path at all. | S7, S8 |
| P1-4 | No cancel, downgrade, renew, reactivate, trial-set or limit-override endpoints; no scheduled trial/renewal processing. | §6 |
| P1-5 | Limits stored but unenforced (users/admins/employees/events/scans/storage); contacts limit only on import and racy; batch capture uncounted; `scansLimit`/`usersLimit` never updated by upgrade. | §5, S6 |
| P1-6 | `plans` table never seeded; empty on a fresh DB; hosted content unknown. | §3.3 |
| P1-7 | `scansUsed` duplicated and permanently stale on the tenant page. | §3.1 |
| P1-8 | `/auth/me` does not expose read-only/status; no client handling. | S12 |
| P1-9 | Zero automated tests for subscriptions; file map cites a non-existent test. | §10 |

**Count: 9**

### P2 — provider, invoicing and commercial

| ID | Finding | Refs |
|---|---|---|
| P2-1 | No payment provider, checkout, webhooks, idempotent event ingestion, payment attempts. | §7 |
| P2-2 | No invoices/receipts/credit notes, billing periods, auto-renewal, tax/VAT, coupons, refunds, dunning, billing portal, reconciliation. | §7 |
| P2-3 | Platform revenue/MRR/ARR/churn/trends and the Platform Subscriptions page are simulated or hard-coded; `business` missing from the revenue map and the plan filter; `plans.priceMonthly` unused. | §8 |
| P2-4 | Inert `stripe_*` columns; undeclared in the contract; `PlatformStats.subscriptionDistribution.status` carries plan ids. | §3.4, S15 |
| P2-5 | Dead `billing`/`subscription` notification categories; audit rows lack previous-plan metadata. | §8, S11 |

**Count: 5**

---

## 12. Bounded B20 recommendation

**B20 — Subscription Lifecycle Integrity (provider-independent).** Do **not** integrate a payment provider in B20. Scope, in order:

1. **Authorization and firewall (P0-1, P0-2):** mount `requireTenantUser` on `/subscriptions`; gate `POST /subscriptions/upgrade` behind `requirePermission("subscriptions","manage")` (catalog entry already exists at `lib/rbac.ts:31`) and, pending the owner's decision in §13-A, either (a) remove the tenant-facing unpaid upgrade entirely or (b) restrict it to `primary_admin` as an explicit *platform-managed* request that does **not** self-activate.
2. **Single source of truth (P0-3/4/5):** decide (§13-E) that `subscriptions` becomes authoritative for plan/status/limits/trial and `companies.plan/status` become derived (or are dropped from writes); wrap every dual write in one transaction; replace the lazy insert with an explicit row created at company creation (both paths) and a repair for existing companies; add FK `subscriptions.plan → plans.id` (and `companies.plan` while it remains) plus status CHECKs after the repair.
3. **Platform-managed lifecycle endpoints (P1-1..4):** platform-owner-only `set plan`, `set trial end`, `cancel (read-only)`, `expire`, `reactivate`, `override limits`, each auditing before/after state and syncing both records inside the transaction; one scheduled sweep that transitions lapsed trials to `expired` and emits a `subscription` notification.
4. **Enforcement (P1-5):** enforce the limits the owner confirms (§13-F) in the service layer with a locked count-then-insert (`SELECT … FOR UPDATE` on the subscription row or a serialized advisory lock), covering create, invite, import, scan (single **and** batch) and returning a machine error code; drop or hide limits that stay unenforced.
5. **Truthful display (P1-7/8, P2-3):** show `companies`-derived usage or a real aggregate; expose `readOnly`/`companyStatus` on `/auth/me`; replace fabricated platform revenue/subscription views with real counts (or remove them until billing exists).
6. **Plans seed (P1-6):** a checked-in, idempotent seed for `plans` with the owner's authoritative prices/limits (§13-F/G).
7. **Tests (P1-9):** API tests for every item above; a Playwright spec for `/admin/subscription`.

Explicitly **out of B20**: provider selection, checkout, webhooks, invoices, taxes, coupons, refunds, dunning, billing portal (all P2, blocked on §13-A/B/C/D).

---

## 13. Owner decisions required

| ID | Decision | Why it blocks work |
|---|---|---|
| A | **Manual / platform-managed billing vs online self-service payment** (or both, by plan). | Determines whether any tenant-facing plan-change endpoint should exist, and whether B20 step 1 removes or restricts it. |
| B | **Payment provider** (only if A includes online payment): Stripe, Moyasar, HyperPay, or other — not chosen by this audit. | Provider dictates webhook model, supported countries/currencies, tax handling, and the schema for payment attempts/invoices. |
| C | **Countries and currencies** to sell in (e.g. USD only, SAR/AED, EUR) and whether prices are per currency. | `plans.currency` is a single column; multi-currency needs a price table. |
| D | **Billing cadence**: monthly only, yearly, or both; proration rules on upgrade/downgrade. | `renewalDate = +1 month` is the only cadence in code. |
| E | **Authoritative record**: confirm `subscriptions` becomes the single source of truth and `companies.plan/status` become derived/read-only. | Pre-condition for B20 steps 2–3. |
| F | **Authoritative limits per plan** (admins, employees, contacts, events, scans, storage) and **which are enforced** (block vs warn). | `subscriptions`/`plans` values are unseeded locally; enforcement cannot be built against unknown numbers. |
| G | **Authoritative prices** per plan, including `business`, and whether `enterprise` is priced or "contact us". | Hard-coded map disagrees with the `plans` table and omits `business`. |
| H | **Trial duration** and whether platform-created companies also get a trial. | Today: 14 days by fallback for self-registration, none for platform-created. |
| I | **Cancellation and grace policy**: period-end vs immediate, read-only duration, data-retention window before deletion. | Today: cancelled = read-only forever; deletion = immediate hard delete. |
| J | **Tax / VAT**: whether the platform invoices with VAT (KSA/UAE 15 %/5 % etc.), which entity invoices, and whether `companies.vatNumber` is required at checkout. | Invoice model depends on it. |
| K | **API usage limit**: confirm removal of `apiLimit` (public API keys are removed scope). | Otherwise it remains a dead column. |
| L | **Hosted data check**: authorize a read-only inspection of hosted `plans`, `companies.plan/status`, `subscriptions` and the platform owner's `companyId` before B20 migrations. | Unknown in this audit by instruction. |

---

## 14. Explicit exclusions and deferred items

* **Not implemented, by instruction:** no lifecycle, schema, API, client, UI, seed or test change; no provider selection; no merge/deploy; no hosted access.
* **Removed scope, not counted as pending:** Customer Portal, Custom Domains, Public Developer Platform (public API keys / customer webhooks — hence `apiLimit` is obsolete), Generic Integration Marketplace, mobile administration/billing screens (`replit.md:45`, `docs/STAGE_3_ROADMAP.md:163,220`).
* **Deferred to after §13:** provider integration, invoices/receipts, tax, coupons, refunds, dunning, billing portal, reconciliation, multi-currency pricing, seat-based licensing.
* **Not exercised locally:** document/export storage paths (storage `not_configured` locally — the absence of a storage quota was established by code reading only); real email; real Gemini (stub provider used for the scan probe); hosted behavior of any kind.
* **Not reproduced locally:** the concurrent first-read unique-constraint race (S4) — eight parallel requests all succeeded; the defect is stated from code, not observation.
* **Documentation contradictions reported, not fixed in B19:** `docs/PROJECT_FILE_MAP.md:94` (test reference), `docs/PROJECT_TECHNICAL_BRIEF.md:456` ("subscription lifecycle") — both corrected in Batch 20.

---

## 15. Local verification record

All runs against the localhost stack (API 8080 behind the :80 gateway, isolated dev Postgres). Disposable tenants "B19 Disposable A–E" and users `*@b19.test` were created through the API and deleted afterwards (cascade) together with their audit/activity rows, login attempts and three temporary `plans` rows (`description='B19-DISPOSABLE'`; `plans` was empty before and after). Leftover-row scan across every table with a `company_id` column: none.

| Probe | Observation |
|---|---|
| S0 | `plans` rows before: 0; `GET /subscriptions/plans` → `[]`. |
| V1 | `POST /companies {plan: professional}` → 201, `status=trial`, `trialEndsAt=null`; subscription rows: 0. First `GET /subscriptions/current` by its admin → `free/active`, `scansLimit 50`, `contactsLimit 2`. Drift: `professional/trial` vs `free/active`. |
| V2 | 8 parallel first reads → all 200, one row (race not reproduced). |
| V3 | Employee (`{}` permissions): `POST /contacts` → 403; `POST /subscriptions/upgrade {starter}` → **200**, `renewalDate` +1 month, `contactsLimit` 100; both tables `starter/active`; audit `subscription.upgrade user=b19-a-emp@b19.test meta={"plan":"starter"}`. Upgrade to a plan without a `plans` row → `400 Invalid plan`; non-enum → 400. |
| V4 | Company with no subscription row: upgrade → **200 with empty body**; `companies` → `starter/active`; subscription rows still 0; audit row written. |
| V5 | `PATCH /companies/:id {plan: enterprise, status: suspended, suspendedReason}` → 200, `plan=enterprise`, `status` unchanged (`active`), `suspendedReason=null`; subscription still `starter`. |
| V6 | Suspend → `companies=suspended`, `subscriptions=active`; existing token `/auth/me` 403; login 403 "Your company account has been suspended. Please contact support."; activate → `active`; activity types `company_created,company_suspended,company_activated`; audit `company.patch`, `company.post` (suspend), `company.post` (activate) with entity id. |
| V7 | `status=cancelled` (direct DB): login 200, `GET /contacts` 200, `POST /contacts` 403 "Your account is read-only. Reactivate your subscription to make changes.", `POST /subscriptions/upgrade` → same 403; `GET /subscriptions/current` still `active`; `/auth/me` exposes no read-only field. |
| V8 | `expired` → login 403 "Your subscription has expired. Please renew to continue."; `trial` + lapsed date → 403 "Your free trial has ended. Please choose a plan to continue." |
| V9 | Registered tenant with free-plan limits (contacts 2, events 1, employees 0, admins 1, scans 50): 3 contacts → 201×3; 2 events → 201×2; 2 employees + 1 admin → 201×3; invitation → 201. Import of 2 rows → `400 Import would exceed the plan contact limit (2); 3 used, 2 new.` Limit raised to 6 in DB, two parallel 2-row imports → both `200 imported 2`, final count **7**. Stub AI; `scansLimit=1`, `scansUsed=5` → `POST /scans` → **201 completed**; `companies.scansUsed=6`, `subscriptions.scansUsed=0`; batch-analyze of 2 items → 202, counter unchanged, `ai_invocations` written; `GET /subscriptions/current` shows `scansUsed 0`. Storage: `not_configured`. |
| V12 | `monthlyRevenue` 1722 → +`business` company 1722 → patched to `starter` 1751; `subscriptionDistribution` keys are plan ids; revenue trend first value 1494 then 1247; scan trend 117 then 83 (random). |
| V14 | Platform owner (local `companyId=1`): `GET /subscriptions/current` → company 1's row; `POST /subscriptions/upgrade {starter}` → **200**, company 1 rewritten to `starter` with starter limits. Restored by hand to `enterprise` with the original limits afterwards; the resulting `subscription.upgrade` audit row for company 1 was left in place. |
| V15 | Role `admin` with `{}` permissions → upgrade **200**; trial columns retained after activation. |

### Gate results

Run on the audited tree after the verification probes (no code changed). Stub AI provider only; no real email, Gemini, GCS mutation, APK build or deploy.

| Gate | Result |
|---|---|
| Typecheck — API, web, libs, mobile, scripts | PASS (all five, exit 0) |
| API production build | PASS |
| Targeted suites (`services`, `auth-security`, `session-security`, `privacy-platform-owner`, `tenant-isolation-matrix`, `role-firewall`, `registration-lockdown`, `import-perms`, `b12-crm-lifecycle`) against a fresh API process | 9 files, **152 / 152 passed** |
| Full API suite, once, fresh API process | **1005 passed, 9 failed, 28 skipped of 1042** — the 9 failures and 18 of the skips are the documented storage-gated set (`documents.test.ts` 6 failed / 18 skipped, `ocr-pipeline.test.ts` 1, `executive-intelligence.test.ts` 2; local object storage `not_configured`). Nothing else failed. |
| Full Playwright suite, once (fresh API process, gateway :80) | **129 / 129 passed** |
| Web production build | PASS |
| Mobile unit tests | **114 / 114 passed** (10 files) |

---

*End of B19 audit.*
