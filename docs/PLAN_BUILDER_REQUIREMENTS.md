# Subscription & Plan Builder — Platform Owner requirements (PB-1 … PB-5)

**Status: PENDING CORE ROADMAP FEATURE — NOT STARTED.** The dynamic Subscription & Plan Builder is a committed product
capability of Lead Capture Pro, not an optional enhancement. This document is the durable owner-facing requirements
baseline for it. It defines requirements only: **no schema is created or changed by this document, no production
subscription is touched, no batch number is assigned (B1–B26 are not renumbered), and nothing here is part of the B25
object-storage track or its ops branches.**

Legend used in every section:

| tag | meaning |
|---|---|
| **APPROVED** | exists today in the product, owner-confirmed as completed (grounded in `develop` `e559b002` and the records `B20_SUBSCRIPTION_LIFECYCLE.md`, `B21_PLATFORM_OWNER_ADMIN.md`, `B23_FINAL_RECONCILIATION.md`) |
| **REQUIRED** | the owner's stated scope of the Plan Builder (must be delivered) |
| **PROPOSED** | this document's detail for a REQUIRED item — unapproved until the owner confirms it |
| **DEFAULT** | the recommended answer to an unresolved owner decision; applies unless the owner decides otherwise |

Sequencing: after the B25 storage track (Stage 2A closure → mobile R1/R2 deployment → Stage 2B). Each phase PB-1 … PB-5 is
one product batch on `develop` from the approved baseline, API-spec-first (`lib/api-spec/openapi.yaml` → Orval → generated
Zod), with API tests and platform-portal Playwright coverage. No ops tooling change. The mobile client only reads the
resolved entitlements.

---

## PB-1 — Requirements and data model

### PB-1.1 APPROVED baseline (do not rebuild)
| area | what exists today |
|---|---|
| Fixed plan catalog | five stable plan ids `free · starter · professional · business · enterprise` in `plans` (seeded insert-if-missing; operator edits never overwritten); per-plan limits `admins / employees / contacts / events / scans / storage_mb` (NULL = unlimited); `features` jsonb (empty today); `trial_days` (14); `is_active`; `sort_order` |
| Subscription lifecycle | one `subscriptions` row per company; statuses `trialing · active · past_due · cancelled · expired · suspended`; ONE entitlement resolver → `full / read_only / blocked`; owner actions plan / trial / activate / past-due / cancel / expire / suspend / reactivate / limits / convert-to-manual / sync; legacy mirror columns on `companies` written only inside the subscription transaction; an audit row per change; a subscription events feed |
| Manual billing | `billing_source = manual`; platform-owner managed state; no provider involved |
| Stripe integration | `billing_source = stripe`; hosted Checkout / Billing Portal only when a verified price exists; signed webhooks with livemode enforcement; one reconciliation path; a fake provider for tests; live Stripe NOT activated (owner decision) |
| Trial management | `trial_started_at / trial_expires_at`; default 14 days; owner-started and owner-changed trials; the manual-trial expiry sweep (system actor, audit evidence) |
| Per-tenant resource overrides | `subscriptions.limit_overrides` (effective limit = override ?? plan limit ?? unlimited); scan reservations and capacity assertions through the entitlements service |
| Price mappings | `plan_prices` (plan FK, provider, unique provider price id, interval, currency, amount, mode, active, `verified_at`); register / patch / verify; Checkout accepts only an active verified internal mapping |

### PB-1.2 REQUIRED capabilities (owner-stated scope)
Create plan · Edit draft plan · Duplicate plan · Publish version · Archive / deprecate plan · Monthly / annual pricing ·
Feature entitlement matrix · User / admin / contact / event / storage limits · AI / OCR allowances · Trial duration and
grace rules · Upgrade / downgrade policy · Grandfathering existing customers · Stripe price mappings · Manual-billing
support · Audit / activity history · Safe tenant migration · Published-plan immutability.

### PB-1.3 Invariants (REQUIRED; wording PROPOSED)
1. A **published plan version is immutable**: limits, entitlements, trial policy and price set never change; any change is a new draft version.
2. A tenant references **exactly one published version**; nothing moves a tenant implicitly.
3. Price or entitlement changes **never affect an existing tenant** until an explicit, audited migration or the tenant's own plan change takes effect (grandfathering by default).
4. Retiring a version keeps serving its subscribers; a version with subscribers can never be deleted.
5. The five fixed plan ids are permanent; their seeded catalog becomes **version 1** of each.
6. Provider prices are deactivated, never deleted; a deactivated price is never accepted by Checkout.
7. Every rule is enforced in the API (not only the UI), covered by API tests and platform-portal e2e tests.
8. The single entitlement resolver remains the only decision point for access; no second resolver, budget or limit system.

### PB-1.4 Data model (PROPOSED — requires explicit owner approval before any implementation; nothing is created here)
| object | proposal |
|---|---|
| `plans.status` | `draft · published · archived` (text, default `published` for the five seeded rows); `is_active` kept and mirrored for compatibility |
| `plan_versions` | `id, plan_id FK, version int, snapshot jsonb (limits + feature matrix + trial policy + price summary), published_at, published_by, retired_at`; unique `(plan_id, version)` |
| `subscriptions.plan_version_id` | nullable FK; NULL = "the current published version" during the transition; back-filled to version 1 by the repair command (dry-run first) |
| `plan_prices.plan_version_id` | nullable FK; NULL = applies to every version of the plan (today's behaviour) |
| `plan_versions.trial_policy` | jsonb: `trial_days, eligible, once_per_company, end_outcome` |
| `features` matrix | the existing `features` jsonb typed as the fixed feature catalog (keys enumerated in code; `on / off`) |
| unchanged | `companies` mirror columns, the resolver's inputs, the audit model, the ops tooling, the mobile client |

### PB-1.5 Owner decisions with recommended DEFAULTS
| id | decision | DEFAULT (applies unless the owner decides otherwise) |
|---|---|---|
| U1 | versioning model | immutable published snapshots (`plan_versions`), never in-place edits |
| U2 | which features are plan-gated | a fixed catalog enumerated in code: `ai.assistant`, `ai.command_center`, `workflow.intelligence`, `executive.intelligence`, `exports.scheduled`, `nfc.capture`, `documents`, `api.access`; none gated until a version says so |
| U3 | storage limit enforcement | informational in PB-1…PB-3; enforced from PB-4 using the object inventory (`storage_objects.size_bytes` per company) |
| U4 | AI / OCR allowances | plan-driven defaults that SEED the existing Enterprise AI Layer budget per tenant; operators keep the per-tenant override |
| U5 | end-of-trial outcome | `blocked` (today's behaviour) with a configurable `read_only` grace of 0 days by default |
| U6 | downgrade with excess usage | block the change and show the blocking resources; never silently delete data |
| U7 | first-batch scope | PB-1 alone (no schema change: plan administration over the existing columns), then PB-2 with the data-model approval |

---

## PB-2 — Dynamic plans and version management

### PB-2.1 Create plan (REQUIRED; flow PROPOSED)
Platform Owner → Plans → "New plan" → name, slug (never one of the five fixed ids; immutable after creation), description,
sort order → saved as a **DRAFT** (not assignable, not visible to tenants). A draft carries limits, entitlements, trial
policy and prices, all editable until publication. Audit row `plan.create`.

### PB-2.2 Edit draft plan
Open a draft → change any field → "Save draft" (audit `plan.update`). A published version is never edited in place: "Edit"
on a published plan creates a **new draft version** pre-filled from the current published version.

### PB-2.3 Duplicate plan
"Duplicate" on any plan (draft or published) → a new draft plan with a new slug, copying limits, entitlements and trial
policy; copied provider prices are marked **unverified** (verification is never copied). The audit row records the source
plan and version.

### PB-2.4 Publish version
"Publish" on a draft → validation (every provider price verified in the active provider mode; limits consistent;
entitlement keys from the fixed catalog; trial policy complete) → an **immutable published version** (version number,
`published_at / by`, audit `plan.publish`) → the plan becomes assignable to NEW tenants. Tenants on an earlier version are
NOT moved (PB-4.3). The seeded catalog becomes version 1 of each fixed plan through the repair command (dry-run first).

### PB-2.5 Archive / deprecate plan
"Retire" on a published version → not assignable to NEW tenants; existing subscribers keep it unchanged until migrated;
the last published version of a plan cannot be retired while the plan is assignable. "Archive" on a plan requires zero
subscribers or an explicit migration target (PB-4.5). Provider prices of a retired version are deactivated, never
deleted. The five fixed ids can be archived only with a migration target and never deleted.

### PB-2.6 Published-plan immutability (REQUIRED)
Enforced by the API: PATCH on a published version → 409; price changes on a published version → a new draft; the snapshot
is what the resolver reads for every subscriber of that version.

---

## PB-3 — Feature entitlements and usage limits

### PB-3.1 Feature entitlement matrix (REQUIRED; detail PROPOSED)
Per draft version: a matrix over the fixed feature catalog (U2) → `on / off`. Keys are enumerated in code, never free
text. The existing single entitlement resolver consumes the matrix together with the subscription status; the permission
middleware and the mobile client only read the resolved result.

### PB-3.2 Usage limits (REQUIRED)
Per draft version: `admins`, `employees` (users), `contacts`, `events`, `scans per usage window`, `storage_mb`. The
existing per-tenant `limit_overrides` stay on top of the version's limits (effective = override ?? version ?? unlimited).
Storage: informational until U3's enforcement phase (DEFAULT: PB-4).

### PB-3.3 AI / OCR allowances (REQUIRED)
Per draft version: `scans_per_window` (exists) plus `ai_invocations_per_window` and / or `ai_budget_minor` that SEED the
existing Enterprise AI Layer budget for the tenant (U4). Rules: no second budget system; Google Gemini 2.5 Flash through
the Enterprise AI Layer stays the only provider; operators may still override per tenant; usage analytics never store
prompt or response content.

### PB-3.4 Trial duration and grace rules (REQUIRED)
Per draft version: `trial_days`, `eligible` (yes / no), `once_per_company`, `end_outcome` (`blocked` today; optional
`read_only` grace of N days — U5). The single resolver remains the only decision point; the expiry sweep keeps its
system-actor audit evidence.

---

## PB-4 — Billing integration and tenant transitions

### PB-4.1 Monthly / annual pricing and Stripe price mappings (REQUIRED)
Per draft version → prices by period (`month`, `year`; PROPOSED: `interval_count` for multi-month) per currency. Stripe:
an existing verified `plan_prices` mapping or "register + verify now"; the provider price id stays unique; Checkout accepts
only the version's active verified mapping. Publication is blocked while any provider price of the version is unverified
or belongs to another provider mode. Live Stripe activation stays a separate owner decision (B20 §13).

### PB-4.2 Manual-billing support (REQUIRED)
A manual version price = a platform-managed amount with no provider; manual tenants are never touched by provider
events; the owner's lifecycle actions (activate / past-due / cancel / expire / suspend / reactivate) remain the manual path;
`sync` remains the owner's manual reconciliation.

### PB-4.3 Grandfathering existing customers (REQUIRED)
Publishing a new version or changing prices NEVER changes an existing tenant's version, limits, entitlements or price. A
tenant moves only through an explicit migration (PB-4.5) or its own upgrade / downgrade (PB-4.4). PROPOSED: a "Tenants on
this version" view per version.

### PB-4.4 Upgrade / downgrade policy (REQUIRED)
Owner (manual billing): Subscriptions → tenant → "Change plan" → a published version → effective immediately or at period
end (PROPOSED) → audit row with before / after version. Stripe: the tenant uses the Billing Portal; webhook reconciliation
maps the provider price to the internal version; proration is delegated to the provider. Downgrade whose target limits are
below current usage: DEFAULT U6 = blocked with the blocking resources listed; never silent data deletion.

### PB-4.5 Safe tenant migration (REQUIRED)
Explicit owner action per version: dry-run first (counts; blocked tenants by reason) → execute → one audit row per tenant
with before / after version. Bulk migration is dry-run first, never silent, never automatic on publish. Rules: no tenant is
migrated to a draft or retired version; a migration never changes `billing_source`; a provider price that maps to no
published version is surfaced to the owner, never auto-created.

### PB-4.6 Audit / activity history (REQUIRED)
Every create / edit / duplicate / publish / retire / archive / price / migration action is an append-only audit row in the
existing audit model (actor, before / after, version). A per-tenant plan history (versions, instants, actor) is queryable
by the owner (`GET /platform/subscriptions/:companyId/plan-history`, PROPOSED).

---

## PB-5 — Owner UI, testing and release

### PB-5.1 Owner UI (REQUIRED; layout PROPOSED)
Platform portal (`/platform`): Plans list (status, versions, subscribers, prices) → plan detail (draft editor: general,
limits, entitlement matrix, allowances, trial policy, prices; published versions read-only with "New draft from this
version") → version actions (publish, retire, migrate with dry-run) → tenant subscription detail gains "Change plan" and
"Plan history". Platform-owner only; tenants see their resolved plan on the existing Subscription page. Light / dark; the
existing design system; no new design tokens.

### PB-5.2 Testing (REQUIRED)
API suite: immutability (409 on a published version), validation on publish (unverified price, unknown feature key,
inconsistent limits), grandfathering (publish does not move a tenant), migration dry-run / execute / blocked reasons,
downgrade guard, manual vs Stripe paths with the fake provider, audit rows per action, resolver outputs per matrix / status.
Playwright (platform portal): create → edit → duplicate → publish → retire; tenant change-plan with history; isolation
(tenant portal never sees plan administration). Mobile: unchanged (reads entitlements only). No production data in tests.

### PB-5.3 Release (REQUIRED)
One product batch per phase on `develop` from the approved baseline; hosted dev deployment through the existing
`deploy-dev-vps` workflow; a hosted read-only verification that the five seeded plans are version 1 and every live
subscription resolves exactly as before the batch (no entitlement change for any existing tenant); repair command with
dry-run evidence before the back-fill; rollback = redeploy the previous SHA (schema additions are additive and nullable).

### PB-5.4 Explicit non-goals of this document
No implementation, no schema, no OpenAPI change, no production subscription mutation, no renumbering of B1–B26, no change
to the B25 ops branches, no live Stripe activation, no second AI / budget / resolver system.
