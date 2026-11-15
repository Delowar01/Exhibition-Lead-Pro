# Plan Builder — Platform Owner Operator Guide

Scope: the Subscription & Plan Builder as implemented on the Batch 39–43 branch chain
(read-only catalog → versioned plans → entitlements, allowances and trial policy →
pricing, plan / version changes, tenant migration, plan history → release hardening).
The code is authoritative; where this guide and the code disagree, the code wins and
the contradiction must be reported, not papered over.

This guide describes **local and reviewed behaviour**. Nothing in it claims that the
Plan Builder is deployed, released, or has been exercised against production data.

Audience: the **Platform Owner** (`platform_owner` role). Every screen below lives in
the Platform portal (`/platform/plans`, `/platform/subscriptions`, `/platform/companies`),
which is **English-only by product scope** (the web portals carry no localization
layer; EN / AR with RTL is a mobile-client scope — see `B23_FINAL_RECONCILIATION.md` §7.2).

---

## 1. Concepts and data model

| Term | Meaning |
| --- | --- |
| **Plan** | A catalog entry identified by a slug (`^[a-z][a-z0-9-]{1,39}$`). The five fixed ids (`free`, `starter`, `professional`, `business`, `enterprise`) are reserved: they can be versioned but never created, deleted or archived without a migration target. Status: `draft`, `published`, `archived`. |
| **Version** | An immutable **snapshot** of a plan: display fields, limits, feature matrix + enforcement mode, AI allowances, trial policy, manual price summaries, captured provider price mappings. States: `draft` (editable, at most one per plan), `published` (immutable), `retired` (published but no longer assigned). Exactly one published, non-retired version is the plan's **current** version. |
| **Pin** | A subscription references one published version (`subscriptions.plan_version_id`). A subscriber keeps its version until a plan / version change or a migration moves it (**grandfathering** — publishing never moves anyone). A `NULL` reference is a legacy subscription that still resolves from the plan row until the backfill pins it (§11). |
| **Limits** | `contacts`, `events`, `admins`, `employees`, `scans`, `storageMb`; `null` = unlimited. The single resolver applies tenant **limit overrides** (`subscriptions.limit_overrides`) on top of the pinned snapshot. `admins` can never be 0. |
| **Features** | `ai.assistant`, `ai.command_center`, `workflow.intelligence`, `executive.intelligence`, `exports.scheduled`, `nfc.capture`, `documents`, `api.access`. Enforcement mode `legacy` (grandfathered: every feature allowed, flags recorded only) or `enforced` (the matrix is applied; the API answers `403 FEATURE_NOT_ENTITLED`). An enforced denial holds on every entry point of the feature: `documents` also covers an organization's document list and the private file bytes; `nfc.capture` covers an NFC scan and a contact saved as an NFC capture (manual contact creation is never gated); `workflow.intelligence` and `executive.intelligence` also cover the AI Assistant's answers and suggestions, the recurring workflow alerts and executive report files. The assistant routes need **both** `ai.assistant` and `ai.command_center`: a version that enables exactly one leaves the assistant unavailable — the web shows its not-included state, the mobile app hides the entry (validation warning `ASSISTANT_FEATURES_COUPLED`). |
| **Allowances** | `aiTokensPerMonth`, `aiCostMicroUsdPerMonth` — the **cap** of the tenant's monthly budget in the existing Enterprise AI Layer. Without a tenant budget the allowance applies; a tenant admin may set a **lower** budget; a higher one is refused (`400 AI_BUDGET_EXCEEDS_PLAN_ALLOWANCE`) and a higher stored value is capped; for a real provider only a model the platform can price is accepted (`400 AI_MODEL_NOT_SUPPORTED`), so the cost allowance always applies. A version without allowances (every version 1) leaves the tenant's own setting untouched. To give one tenant more, assign a version with a higher allowance — there is no per-tenant AI override. No second budget system exists. |
| **Trial policy** | `trialDays`, `eligible`, `oncePerCompany`, `endOutcome` (`blocked` or `read_only`), `readOnlyGraceDays` (1–90, required with `read_only`). |
| **Prices** | Provider mappings (`plan_prices`) are **plan-wide** (`planVersionId` null) or **bound to one draft version**; binding is verified against the provider and frozen at publication. Manual price summaries (`snapshot.manualPrices`, at most 8, one per period) are display / audit only — the product never bills them. |

Every mutation writes an append-only audit row (`plan.create`, `plan.duplicate`,
`plan.archive`, `plan.publish`, `plan_version.create / update / delete / retire`,
`subscription.set_plan`, `subscription.migrate_version`, `plan_version.migrate`,
`plan_version.backfill`, `subscription.pin_version`).

## 2. Access, roles and the platform firewall

* Every Plan Builder endpoint sits behind `requireAuth` + `requireRole("platform_owner")`
  (`/platform/plans*`, `/platform/subscriptions*`, `/platform/billing*`). Tenant roles get
  `403`, anonymous callers `401`.
* The platform owner never reaches tenant CRM data through these routes: the endpoints
  read subscriptions, plans, prices, audit rows and **usage counts** only.
* The portal redirects a tenant admin away from `/platform/*` before the layout mounts;
  the API refuses regardless (browser-proven by the `zb` / `zc` / `zd` / `ze` suites).

## 3. Create a plan

`/platform/plans` → **New plan** → id (slug), display name, description → *Create draft plan*.

* API: `POST /platform/plans` → `201` with the plan and its first draft (`v1`).
* A fixed id is refused (`INVALID_PLAN_ID`); a malformed slug is refused by the generated
  Zod schema (`400`).
* The plan is **not assignable** until its first version is validated and published.
* **Duplicate** copies the current published version (limits, features, trial policy,
  display fields, manual price summaries) into a new draft plan; provider prices are never
  copied (a price belongs to exactly one plan).

## 4. Edit a draft version

Open a plan → version list → the draft row → the editor (`version-editor`):

* display name / description / sort order;
* limits per resource (blank = unlimited; `LIMIT_INVALID`, `LIMIT_ADMINS_ZERO`);
* feature matrix with the enforcement selector (`FEATURE_UNKNOWN`, `FEATURE_ENFORCEMENT_INVALID`);
* AI allowances (`ALLOWANCE_INVALID`);
* trial policy (`TRIAL_DAYS_INVALID`, `TRIAL_GRACE_REQUIRED`, `TRIAL_READ_ONLY_GRACE`, …);
* manual price summaries (`MANUAL_PRICE_INVALID`, `MANUAL_PRICE_DUPLICATE`, `MANUAL_PRICES_TOO_MANY`).

*Save draft* → `PATCH /platform/plans/{planId}/versions/{versionId}`. A published or retired
version answers `409 VERSION_IMMUTABLE`; field-level issues come back as
`400 VERSION_INPUT_INVALID` with `context.issues` and are shown next to the form.
*Validate* → `POST …/validate` returns `errors`, `warnings`, `blockers`, `publishable`.

## 5. Prices: manual summaries and provider mappings

* **Manual summaries** are entered on the draft (monthly / annual / other periods;
  currency; amount in minor units; optional label). They are frozen into the snapshot at
  publication and copied into later drafts.
* **Provider mappings** are registered on `/platform/subscriptions` → *Provider price
  mappings* → plan (+ optional draft version) + provider price id → *Register*. The server
  verifies the price with the provider (`PRICE_UNVERIFIED`, `PRICE_MODE_MISMATCH`,
  `PRICE_NOT_RECURRING`, `PRICE_NOT_FIXED`, `PROVIDER_UNAVAILABLE`). Binding to a non-draft
  version is refused (`409 VERSION_NOT_DRAFT`); a draft with bound prices cannot be deleted
  (`409 VERSION_HAS_PRICES`). Published pricing changes only by deactivation.
* Tenant checkout offers plan-wide prices and the prices bound to the plan's **current**
  published version only (`400 PRICE_NOT_AVAILABLE` otherwise). A verified webhook on a
  version-bound price pins exactly that version; a plan-wide price never moves an already
  pinned subscriber.

## 6. Validate and publish (immutability and grandfathering)

*Publish…* opens a confirmation that lists the validation result and the tenant impact.
Publication (`POST …/publish`) is atomic under row locks:

* refused while the version is invalid (`409 VERSION_INVALID`), when legacy subscribers are
  unpinned (`409 UNPINNED_SUBSCRIBERS` — run the backfill first, §11), or when the plan is
  archived (`PLAN_ARCHIVED`);
* publication validation also checks pricing (`NO_PROVIDER_PRICE` warning, `PRICE_UNVERIFIED`,
  `PRICE_MODE_MISMATCH`, `PRICE_DUPLICATE_PERIOD`, `PRICE_INCONSISTENT`, `MANUAL_PRICE_SHADOWED`);
* the published version becomes immutable and **current**; existing subscribers are never
  moved (`subscribersMoved` is always 0). New assignments take the new version from now on.

Two concurrent publishes of the same draft yield exactly one `200` and one `409`.

## 7. Retire, archive, delete a draft

* **Retire** (`POST …/retire`): the version stops being assigned; every pinned tenant keeps
  its exact entitlements. The plan must keep one published version
  (`409 LAST_PUBLISHED_VERSION`) and, like publish, is refused while a subscriber still
  references the plan row (`409 UNPINNED_SUBSCRIBERS` — run the backfill first); the
  confirmation shows the kept subscribers and which version becomes current.
* **Delete draft** (`DELETE …/versions/{id}`): drafts only (`VERSION_PUBLISHED`,
  `VERSION_HAS_SUBSCRIBERS`, `VERSION_HAS_PRICES`). Deleting the only version of a
  never-published plan removes the plan.
* **Archive plan** (`POST /platform/plans/{id}/archive`): published, non-fixed plans with no
  subscribers, no open draft and no live checkout (`409 PLAN_HAS_OPEN_CHECKOUTS` — wait
  for it to complete or to pass its expiry; an abandoned checkout stops counting then, at
  the latest 24 hours after it was started); the fixed five require a migration target
  (`ARCHIVE_REQUIRES_MIGRATION_TARGET`). Nothing is deleted. An archived plan can no longer
  be assigned or bought. If a provider event still arrives for one of its registered prices
  (a purchase made while it was sellable, or a provider-side price change), the tenant is
  reconciled onto the plan's published version, the audit row carries
  `planArchived: true` and the API logs `PROVIDER_PRICE_ON_ARCHIVED_PLAN`. That tenant is
  provider-managed (set-plan and migration refuse it): move it by changing its provider
  subscription to a price of a current plan.

## 8. Change a tenant's plan or version

`/platform/subscriptions` → *Manage* (or the deep link `?company=<id>` from the company
detail) → *Change plan*:

* pick the plan and the target version (published or explicitly retired; a draft is refused
  with `409 VERSION_NOT_PUBLISHED`, a foreign version with `404 VERSION_NOT_FOUND`);
* the dialog shows the **read-only preview** (`POST …/plan/preview`): limit comparison with
  override precedence and **measured** usage, blocking resources, unmeasurable resources
  (never reported as verified), lost / gained features, trial outcome, allowance source;
* a blocked downgrade (`409 DOWNGRADE_BLOCKED` — usage exceeds a target limit) disables the
  confirmation and deletes nothing; a tenant override can lift it;
* a feature-only downgrade needs the explicit checkbox (`409 FEATURE_DOWNGRADE_CONFIRMATION_REQUIRED`);
* provider-managed subscriptions are refused (`409 MANAGED_BY_PROVIDER`) — their plan follows
  the provider price;
* the change is applied **immediately** under the row lock with in-transaction verification
  (`500 PLAN_CHANGE_VERIFICATION_FAILED` rolls back and writes no audit). No period-end
  scheduling, proration or invoicing exists (decision D1: immediate only).

## 9. Migrate tenants between versions

Plan → published version → **Migrate tenants…** (manual-billing tenants only):

1. **Scope**: every tenant on a source version, or an explicit company-id list (≤ 200).
2. **Dry run (read-only)**: per-tenant reasons — `ELIGIBLE`, `ALREADY_ON_VERSION`,
   `PROVIDER_MANAGED`, `TRANSITION_NOT_ALLOWED`, `NOT_ON_SOURCE_VERSION`, `DOWNGRADE_BLOCKED`,
   `FEATURE_DOWNGRADE_CONFIRMATION_REQUIRED`, `SUBSCRIPTION_MISSING` — plus a **digest** over
   every material input (target / source refs, confirmation flag and, per tenant, the current
   plan + version refs, state, limit overrides, measured usage against the target limits,
   feature matrix / enforcement, trial policy, allowances, blockers, lost features). Changing
   any input in the dialog invalidates the review.
3. **Execute**: the button arms an inline confirmation that states the consequence
   (immediate, audited, no automatic undo). Execution sends the reviewed digest; the server
   recomputes a fresh dry run and refuses a stale review (`409 DRY_RUN_STALE`,
   `expectedDigest` returned) or an empty one (`409 NOTHING_TO_MIGRATE`).
4. Each eligible tenant is migrated in its **own transaction**: the row is locked, the review
   input is recomputed inside the lock and compared with the reviewed per-tenant digest —
   a tenant that changed meanwhile is **skipped** (`CHANGED_SINCE_DRY_RUN`, the changed inputs
   are listed), never guessed. Post-change verification failures roll that tenant back.
5. **Result classification** (one server-side status; the per-tenant outcomes, the summary
   and the audit rows agree):

   | `status` | Meaning |
   | --- | --- |
   | `complete` | every eligible tenant migrated; `complete: true` |
   | `partial` | some migrated, some skipped / failed / rolled back (`incompleteReasons`) |
   | `concurrently_changed` | nothing migrated; every eligible tenant changed since the review |
   | `failed` / `rolled_back` | nothing migrated; the reason is the error / verification class |
   | `dry_run` | no execution |

   Ineligible tenants carry the outcome `ineligible` with their reviewed reason. `complete`
   is **never** true while any eligible tenant was skipped, failed or rolled back.

Every migrated tenant gets a `subscription.migrate_version` audit row (migration id,
reviewed digest); the batch gets a `plan_version.migrate` summary row carrying the status.

## 10. Plan history

Manage dialog → *Show N changes*. `GET /platform/subscriptions/{companyId}/plan-history`
projects the tenant's plan-relevant audit rows (created, direct change, version change,
repair, migration, provider sync, backfill pin) with actor, timestamp, reason, from / to
plan + version, limits before / after, tightened / loosened limits, lost / gained
features, migration reference.

**The reason you type is visible to the tenant.** It is stored in the tenant's own audit
trail and shown to tenant users who may view security audit entries. Write it for that
audience; keep internal notes elsewhere.

* **Server-side cursor pagination**: `limit` (1–200, default 50), `order` (`asc` default,
  `desc`), `cursor` (opaque, from an entry or `nextCursor`). The page is keyed on
  `(created_at, id)` over the **relevant** rows only, so thousands of ordinary audit rows
  (limit edits, logins, AI calls…) never hide a plan change. `total` counts the relevant
  rows of the whole history; `original` is always the oldest relevant row.
* A malformed cursor, a cursor of another tenant or an out-of-range limit answers `400`
  (`INVALID_CURSOR`, `INVALID_LIMIT`, `INVALID_ORDER`); an empty `cursor=` is the first page.
* The UI shows the newest 25 first and appends older pages with **Load more**.

## 11. Version-1 backfill and database identity

Before any publish on a plan with legacy (`NULL`-reference) subscribers, run the backfill:
`artifacts/api-server/scripts/backfill-plan-versions.ts` creates `v1` of every published
plan from the plan row and pins every legacy subscription to it, verifying in **one**
transaction that no tenant's effective limits, overrides, status, access mode, billing
source, trial / period dates, provider price, feature entitlements or trial policy changed
(verdicts `APPLIED`, `DRY_RUN_OK`, `INCOMPLETE`, `INTEGRITY_ERROR`, `VERIFICATION_FAILED`;
any mismatch rolls the whole run back; a second run is idempotent). The CLI refuses to apply
without `--expect-database`, `--expect-host` for a non-loopback host, `--confirm-production`
where required, and the database identity checks of `docs/PLAN_VERSION_BACKFILL_RUNBOOK.md`
(forwarded ports and tunnels are detected). **Never run it against production without a
separate written authorization** — see `docs/PLAN_BUILDER_RELEASE_REHEARSAL.md`.

## 12. Troubleshooting and error codes

| Symptom | Cause / action |
| --- | --- |
| *Cannot publish yet* with `UNPINNED_SUBSCRIBERS` | legacy subscribers exist → run the backfill (§11) on the same database first |
| `409 DRY_RUN_STALE` on execute | data changed since the review → run the dry run again and review the new digest |
| Migration status `partial` / `concurrently_changed` | read the per-tenant `changedSinceReview` list; re-run a dry run for the remaining tenants; nothing was guessed |
| `409 DOWNGRADE_BLOCKED` | measured usage exceeds a target limit → raise the target, add a tenant override, or keep the tenant where it is; nothing is deleted |
| `409 MANAGED_BY_PROVIDER` | the subscription follows a provider price → change it through the provider / checkout, not the platform set-plan |
| `403 FEATURE_NOT_ENTITLED` reported by a tenant | the pinned version is `enforced` and denies the feature → check the version's matrix; `legacy` grandfathers everything |
| `400 AI_BUDGET_EXCEEDS_PLAN_ALLOWANCE` reported by a tenant admin | the tenant tried to set an AI budget above the pinned version's allowance → a lower value is accepted; a higher allowance needs another plan version |
| `409 PLAN_HAS_OPEN_CHECKOUTS` on archive | a tenant is mid-checkout for the plan → wait until the checkout completes or expires, then archive |
| Migration row skipped with `CHANGED_SINCE_DRY_RUN`, changed input `target` | the target plan was archived or the target version retired after the dry run → choose a current target and run a new dry run |
| `400 INVALID_CURSOR` | the cursor is malformed, from another tenant or no longer relevant → reload the first page |
| `PRICE_UNVERIFIED` / `PRICE_MODE_MISMATCH` | the provider price could not be verified or belongs to the other provider mode → fix the mapping before publishing |
| `SUBSCRIPTION_PLAN_VERSION_INVALID` in logs | a subscription references a missing / foreign / unpublished version → the resolver fails closed; a same-plan set-plan repairs the reference and audits it |

Other codes: `PLAN_NOT_FOUND`, `VERSION_NOT_FOUND`, `SOURCE_VERSION_NOT_FOUND`,
`INVALID_VERSION_ID`, `INVALID_COMPANY_IDS`, `SCOPE_TOO_LARGE`, `MIGRATION_SCOPE_REQUIRED`,
`INVALID_CONFIRMATION`, `INVALID_TRANSITION`, `NAME_INVALID`, `DESCRIPTION_INVALID`,
`SORT_ORDER_INVALID`, `LIMITS_INVALID`, `FEATURES_INVALID`, `ALLOWANCES_INVALID`,
`TRIAL_POLICY_INVALID`.

The error contract is in `lib/api-spec/openapi.yaml`; the codes added by the release
corrections (`AI_BUDGET_EXCEEDS_PLAN_ALLOWANCE`, `AI_MODEL_NOT_SUPPORTED`,
`PLAN_HAS_OPEN_CHECKOUTS`, the warning `ASSISTANT_FEATURES_COUPLED`) are documented in this
guide. The proofs are the API suites
`b39-*`, `b40-*`, `b41-*`, `b42-*`, `b44-*` and the Playwright specs `zb`, `zc`, `zd`, `ze`, `zf`.
