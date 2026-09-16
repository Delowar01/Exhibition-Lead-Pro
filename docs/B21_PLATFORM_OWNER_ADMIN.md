# Batch 21 — Platform Owner Admin Panel

**Scope:** the central Elite Platform Owner admin panel (`/platform`) for tenant list, search, status, plan, subscription, limits and management — built on the Batch 20 canonical subscription model and the existing platform-owner routes. Base: `develop` `d9e1449` (B20 Correction 4); branch `claude/b21-platform-owner-admin`.

**Reused, not reinvented:** every subscription mutation still goes through `services/subscription-lifecycle.service.ts` (row lock, transition table, mirror, before/after audit) via `/platform/subscriptions/*`; company create / update / suspend / activate / delete stay on `/companies/*` behind `requireRole("platform_owner")`, `blockReadOnlyMutations` and `auditMutations("company")`. No billing policy was added or changed; Stripe and hosted self-service billing remain disabled. **No schema change** (the extended company profile fields already existed as columns).

**Where this document and the code disagree, the code is authoritative.**

---

## 1. What the panel now does

| Screen | Route | Behaviour |
|---|---|---|
| Companies (tenant list) | `/platform/companies` | Server-side pagination (20 / page, real total), search by name, canonical **status** and **plan** filters (resolved against the `subscriptions` row, never the legacy mirror), per-row canonical status + access badges and aggregate counts (users / contacts / scans — never customer records). Row → tenant detail. Row menu: open, manage subscription (shared manager), suspend / reactivate behind a confirmation dialog. **New company** dialog (name, plan, industry, country, primary contact) → `POST /companies` creates the company **and** its manual 14-day trial in one transaction, then opens the tenant page. Loading (skeleton), empty (with/without filters) and error (retry) states are explicit. |
| Tenant detail (new) | `/platform/companies/:id` | Header with canonical status / access, **Edit profile**, **Manage subscription**, **Suspend / Reactivate** (confirmed). Cards: **Subscription** (plan, billing source, trial / period end, access message, suspension reason, usage against effective limits, allowed actions), **Administrators and members** (tenant accounts with role / active state; link to the filtered Users directory; **Add primary admin**), **Administrative activity** (audit trail, §3), **Profile** (all company columns), **Footprint** (aggregate counts only), **Danger zone** (delete behind a type-the-name confirmation). Invalid id, loading, 404 and error states are explicit. |
| Subscription manager (shared) | `components/platform/SubscriptionManager.tsx` | The B20 detail + lifecycle-confirmation dialog extracted into one component used by the Subscriptions screen, the Companies list and the tenant page. Actions are exactly the server-reported `allowedActions`; every action confirms first; a failed detail load shows an error state with retry. `/platform/subscriptions?company=<id>` deep-links into it. |
| Users (cross-tenant) | `/platform/users` | Server-side pagination with the real total ("Showing a–b of n"), search by **name or e-mail**, role filter, `?companyId=` filter (chip with the company name, clearable; linked from the tenant page), company links to the tenant page. The placeholder "Invite user" button, the dead row menu and the page-derived counters were removed — every control is functional and every number is server truth. |
| Subscriptions | `/platform/subscriptions` | Unchanged behaviour (list, metrics, provider status, price mappings) now rendered through the shared manager; company names link to the tenant page; list load errors show a retry state. |

Nothing on the panel exposes customer CRM data to the platform owner: reads are limited to company records, canonical subscriptions, aggregate counts, tenant **accounts** (team administration, which the owner already managed through `/users`) and the administrative audit trail below. `/contacts`, `/leads`, `/events`, `/subscriptions/*` etc. stay behind `requireTenantUser` (403 for the owner) — re-proven in `test/b21-platform-admin.test.ts`.

## 2. API changes (contract-first: `lib/api-spec/openapi.yaml` → Orval)

| Change | Where |
|---|---|
| `GET /companies/{id}/audit` (new, platform owner only) → `CompanyAuditList { items[], total, limit: 50 }` | `routes/companies.ts`, `services/companies.service.ts#listCompanyAudit`, `repositories/audit.repository.ts#listCompanyAuditByEntityTypes` |
| `Company` / `CompanyInput` / `CompanyUpdate` expose the existing profile columns `legalName`, `registrationNumber`, `timezone`, `currency`, `primaryContactName`, `primaryContactEmail` (the services already persisted them; the contract and the generated clients now know them) | `openapi.yaml`, generated `lib/api-zod`, `lib/api-client-react` |
| `GET /users?search=` matches **name or e-mail**; `companyId` remains honoured for the platform owner only | `repositories/users.repository.ts#list` |
| A tenant account created **by the platform owner** is recorded on the tenant's trail as `team.account_created` (`entityType team`, metadata `{ role, createdByPlatform: true }` — never the e-mail, name or password) | `services/users.service.ts#createUser` (same transaction as the insert) |

No new tables, columns, packages, environment variables or billing settings.

## 3. Administrative audit trail (platform view)

`GET /companies/:id/audit` returns the **50 newest** rows (plus the total) of the tenant's administrative trail: rows written *for* the tenant (`audit_logs.company_id = id`) with `entity_type ∈ {subscription, company, team}`, plus platform-owner requests *on* the tenant (router-level `company.*` rows carry the owner's company id — null — and the target id as `entity_id`).

**Correction 1 — tenant attribution of user actions.** A mutation on `/users/:id…` (roles, enable / disable, profile / role patch, delete, force-logout, reset-password) is recorded with the **verified target user's company id** (`auditMutations("team", { companyIdResolver })` in `routes/users.ts`: the target row is looked up after the request succeeded — including a just soft-deleted row — and used only when `canAccessCompany(actor, target.companyId)` holds; otherwise the actor's company is kept). One row per action, so a platform owner's role or active-state change appears once on the affected tenant's trail (and in that tenant's Security Center) and never on another tenant's. Requests without a target (`POST /users`, `PATCH /users/me`) keep the actor's company as before; the platform-created account is still attributed through `team.account_created`. Metadata stays `{ path, method }` — no passwords, IP addresses or user details. CRM modules (`contacts`, `leads`, …) are never projected even though their rows exist in the append-only table; `ip_address` is never returned; `metadata` is reduced to the allow-list `before, after, changed, reason, plan, trialDays, trialExpiresAt, limits, path, method, eventType, outcome, providerClosed, rule, role, createdByPlatform`. The lifecycle service itself records only the `before/after {status, plan, billingSource}` pair and the **names** of changed fields (the operator's suspension text never enters the trail).

## 4. Authorization and tenant safety

* Every panel route inherits the existing guards: `requireAuth` → `requireRole("platform_owner")` (403 for tenant admins and employees, no existence leakage) → `blockReadOnlyMutations` → `auditMutations`.
* Tenant boundaries are untouched: a tenant admin's `/users` list ignores a foreign `companyId`, never lists other tenants or platform accounts, and gets 404 for a foreign user id; a tenant admin cannot create accounts in another company or escalate to `platform_owner`.
* The web `ProtectedRoute` role routing keeps tenant users away from `/platform/*` (UX only — server RBAC stays authoritative).
* Delete remains the platform-level hard delete (`ON DELETE CASCADE` wipes the tenant) — now only reachable through a type-the-name confirmation that spells out the consequence; suspension is offered as the non-destructive alternative.

## 5. Tests

| Suite | Proves |
|---|---|
| `artifacts/api-server/test/b21-platform-admin.test.ts` (19) | extended profile on create / read / update (plan & status never editable there), list pagination + search + canonical filters, cross-tenant user administration (company filter, name-or-e-mail search, tenant admin boundaries, primary-admin creation with attribution + real login, no foreign create / escalation), lifecycle through the existing routes with before/after audit, suspend blocks login + reactivate restores, audit projection rules (entity allow-list, no CRM rows, no IP, key allow-list, cap 50), 404s, delete cascade without touching neighbours, 403 matrix for tenant admin + employee on every panel read/mutation, platform owner still fenced from CRM |
| `artifacts/web-app/e2e/z-platform-admin.spec.ts` (6) | real platform-owner form login; list search / totals / filters; onboarding dialog → tenant page (status, access, plan, usage, audit); edit profile; add primary admin with shown-once password → that admin signs in; owner disable / enable of that account shown on the tenant's trail (Correction 1); plan change through the shared manager (confirmed) → reflected + audited; suspend / reactivate (confirmed) → API access follows; manage from the list; Users directory company chip + e-mail search; Subscriptions deep link; tenant admin redirected away + API 403; delete with type-the-name confirmation → 404 afterwards |

Regression suites re-run with the batch: `b20-subscriptions`, `privacy-platform-owner`, `audit`, `tenant-isolation-matrix`, `role-firewall`, `org-foundation`, `b20c4-effective-permissions`, `b20-structural`, `auth-security` (API); `x-billing`, `m-role-routing`, `o-portal-hosts`, `a-route-access`, `n-newtab-auth`, `f-responsive`, `g-dark-mode` (Playwright).

## 6. Limitations and non-goals

* Tenant branding by company id (`/companies/:id/branding`, Batch 18) has an API but still no platform-side screen — tenants manage it themselves; not part of this batch.
* The audit view is the 50 newest administrative entries (no paging / filtering); the tenant's own Security Center keeps the full searchable trail.
* No invitation e-mail for a platform-created administrator: the panel generates an initial password shown once (SMTP stays optional); the administrator changes it after signing in.
* Deleting a tenant is immediate and permanent (existing API semantics); there is no soft-delete or grace period.
* No Stripe activation, no hosted operation, no AI, no mobile administration, no Customer Portal, no custom domains, no B22.
