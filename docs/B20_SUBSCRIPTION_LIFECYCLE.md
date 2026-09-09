# Batch 20 — Subscription Lifecycle Integrity and Hybrid Stripe Billing

**Scope:** the canonical subscription model, its lifecycle, the access policy it drives, platform-owner manual operations, the Stripe billing boundary (hosted Checkout, hosted Billing Portal, signed idempotent webhook, server-verified price mappings), real limit machinery with non-blocking defaults, truthful metrics, the repair command for pre-B20 rows, and the hosted activation prerequisites. Base: B19 audit commit `6ed74fc` on `develop` parent `c2cd467`; branch `claude/b20-subscription-lifecycle`.

**Accepted owner decisions:** hybrid billing (platform owners manage subscriptions manually; authorized tenant admins may use Stripe self-service where prices are configured); real limit machinery with **non-blocking defaults**; 14-day trial for every new company; access policy `trialing`/`active` → full, `past_due`/`cancelled` → read-only, `expired`/`suspended` → blocked; tenant data is **never** deleted automatically.

**Where this document and the code disagree, the code is authoritative** (`artifacts/api-server/src/lib/billing/lifecycle.ts` owns the pure rules; `services/subscription-lifecycle.service.ts` is the only writer).

---

## 1. Canonical model

* **One row per company** in `subscriptions` (`company_id` UNIQUE, FK → `companies` ON DELETE CASCADE). It is the **only** record consulted for plan, status, billing source, trial/period, limit overrides and — through the shared resolver — the tenant's access mode.
* `companies.plan`, `companies.status`, `companies.trial_ends_at` (and `subscriptions.trial_ends_at`, `renewal_date`) are **write-only compatibility mirrors** written in the same transaction as every canonical change. Nothing on the access path reads them (`test/b20-structural.test.ts` proves it for `requireAuth`, `lib/sessions.ts`, `auth.service.ts`, `lib/company-access.ts`).
* Every company-creation path (`POST /companies` by the platform owner, `POST /auth/register` where enabled) inserts the company **and** its subscription in **one transaction**: `manual`, `trialing`, `trial_expires_at = now + 14 days`, `usage_anchor_at = now`, no provider identity, `limit_overrides = {}`. An invalid plan rolls the whole creation back.
* A company **without** a row resolves to **blocked** (`SUBSCRIPTION_MISSING`) — fail closed. The repair command (§6) guarantees a row for every pre-B20 company before the new API serves traffic; reads never lazily insert.

### States, sources, plans

| Field | Values |
|---|---|
| `status` | `trialing` · `active` · `past_due` · `cancelled` · `expired` · `suspended` (legacy `trial` is read as `trialing` until repaired) |
| `billing_source` | `manual` (platform-managed) · `stripe` (provider-managed) |
| `plan` | stable catalog `free` · `starter` · `professional` · `business` · `enterprise` (seeded insert-if-missing at API start and by the repair; all plan limit defaults are **NULL = unlimited**) |

### Tenant projection (`GET /subscriptions/current`)

`plan`, `status`, `billingSource`, `accessMode`, `accessReasonCode`, `accessMessage`, trial / period / cancellation timestamps, `providerLinked`, `providerSubscriptionLinked`, `billing { providerConfigured, selfServiceCheckoutEnabled, checkoutAvailable(+reason), portalAvailable(+reason), managedByPlatform }`, `limits[] { resource, limit, source }`, `usage { window, resources[] }`. Provider ids, secrets and URLs are never included; the platform detail adds masked refs (`cus_…1234`) only.

---

## 2. Access matrix (single resolver: `resolveEntitlement`)

| Canonical state | Access | Reason code | Notes |
|---|---|---|---|
| `trialing`, trial end in the future or unset | **full** | — | |
| `trialing`, trial end elapsed | **blocked** | `TRIAL_ENDED` | until the sweep marks it `expired` or the owner acts |
| `active` | **full** | — | `cancelAtPeriodEnd=true` never blocks by itself |
| `past_due` | **read-only** | `PAST_DUE` | reads allowed; mutations 403 (`blockReadOnlyMutations`) |
| `cancelled` | **read-only** | `SUBSCRIPTION_CANCELLED` | |
| `expired` | **blocked** | `SUBSCRIPTION_EXPIRED` | login refused, every request 403 with the code |
| `suspended` | **blocked** | `SUBSCRIPTION_SUSPENDED` | platform-imposed; shadows provider state |
| no row | **blocked** | `SUBSCRIPTION_MISSING` | fail closed |
| unknown status | **blocked** | `UNKNOWN_STATUS` | |

Applied at login (`auth.service.ts`), on every request (`requireAuth`), and on refresh-token rotation (`lib/sessions.ts`). The login/`/auth/me` responses carry a `subscription` summary (plan, status, billing source, access mode, reason, message, trial/period end).

Legacy mirror vocabulary written back to `companies.status`: `trialing→trial`, `past_due→active`, others unchanged.

---

## 3. Transition table (pure; `checkTransition` / `allowedActions`)

| Action | From | To | Allowed for source | Route |
|---|---|---|---|---|
| `set_plan` | any | unchanged | manual | `POST /platform/subscriptions/:id/plan` |
| `start_trial` | trialing, expired, cancelled | trialing | manual | `POST …/trial` (`trialDays` 1–365 or `trialExpiresAt`) |
| `activate` | trialing, past_due, cancelled, expired | active | manual | `POST …/activate` |
| `mark_past_due` | active | past_due | manual | `POST …/past-due` |
| `cancel` | trialing, active, past_due | cancelled | manual | `POST …/cancel` |
| `expire` | trialing, active, past_due, cancelled | expired | manual | `POST …/expire` |
| `suspend` | any but suspended | suspended (remembers `statusBeforeSuspension`) | manual, stripe | `POST …/suspend {reason}` |
| `reactivate` | suspended | restores `statusBeforeSuspension` (elapsed manual trial → expired; Stripe rows resume the last provider status) | manual, stripe | `POST …/reactivate` |
| `set_limits` | any | unchanged | manual, stripe | `PUT …/limits {limits}` |
| `convert_to_manual` | any | unchanged, source → manual | stripe, **only when no live provider subscription remains** (verified against the provider; `LIVE_PROVIDER_SUBSCRIPTION` otherwise) | `POST …/convert-to-manual` |
| `sync_provider` | any | provider state applied | stripe | `POST …/sync` |
| `sweep_expire_trial` | trialing (trial end elapsed) | expired | manual (system only) | scheduler job `subscriptionSweep` |

Refusals are `409` with `INVALID_TRANSITION`, `MANAGED_BY_PROVIDER`, `NOT_PROVIDER_MANAGED`, `NO_RESTORE_STATE`, `LIVE_PROVIDER_SUBSCRIPTION`, `NO_PROVIDER_SUBSCRIPTION` or `PROVIDER_SUBSCRIPTION_NOT_FOUND`. `companies/:id/suspend` and `/activate` (used by the platform Companies screen) call the same service (`activate` = reactivate when suspended). `PATCH /companies/:id` no longer accepts `plan`/`status`. `POST /subscriptions/upgrade` is a **410 `BILLING_UPGRADE_RETIRED` tombstone** that touches no state.

Every change runs in one transaction with the row locked (`FOR UPDATE`), writes the mirror, and writes an audit row (`audit_logs`, `entityType=subscription`, metadata `before/after {status, plan, billingSource}` + `changed[]` field names; suspension reason is the only free text, single-line and capped at 200 chars; never provider ids, secrets, payloads or PII).

---

## 4. Ownership rules (hybrid model)

* **Manual (`billing_source = manual`)** — the platform owner owns the lifecycle through the routes above. Tenants can read their subscription, usage and verified prices; with `subscriptions:manage` they may start Checkout when eligible.
* **Stripe (`billing_source = stripe`)** — the provider owns status, periods and cancellation; the platform owner may only suspend/reactivate, override limits, sync, or convert to manual after the provider subscription ended. Manual status routes answer `409 MANAGED_BY_PROVIDER`.
* **Suspension shadow** — while suspended, provider updates change only `statusBeforeSuspension` / `providerStatus` / periods; access stays blocked until the platform reactivates, which resumes the provider's last reported status.
* **Takeover of a manual row** — a provider event binds a manual row (no bound provider subscription) **only** when it describes a **live** provider subscription (`trialing`, `active`, `past_due`, `unpaid`, `paused`). A late or terminal event about an old, detached subscription is `unbound` and changes nothing; a **new** live subscription for the same Stripe customer (re-subscribed via Checkout/Portal) binds again.
* **Capabilities** (`resolveBillingCapabilities`): Checkout is offered iff provider available ∧ `BILLING_SELF_SERVICE_CHECKOUT=true` ∧ ≥1 active verified price ∧ no live provider subscription ∧ status ∈ {trialing, cancelled}; the Portal iff provider available ∧ source stripe ∧ customer linked ∧ status ∉ {expired, suspended}. Checkout/Portal are the only mutations a read-only tenant may reach (billing recovery).
* **Tenant firewall** — `/subscriptions/*` is behind `requireTenantUser` (platform operators get 403 even with a `companyId`), reads need `subscriptions:view`, self-service needs `subscriptions:manage`; `primary_admin` bypasses the matrix, `admin`/`employee` with `{}` are denied. The server matrix is exact (`manage` alone does not grant reads — same convention as B17 workflows). `/platform/subscriptions` and `/platform/billing` are `platform_owner` only.

---

## 5. Schema changes (all additive; classification recorded from the local push)

**`subscriptions` — new columns:** `billing_source` (NOT NULL default `manual`), `trial_started_at`, `trial_expires_at`, `current_period_starts_at`, `current_period_ends_at`, `cancel_at_period_end` (NOT NULL default false), `canceled_at`, `ended_at`, `past_due_since`, `suspended_at`, `suspended_reason`, `status_before_suspension`, `status_changed_at` (NOT NULL default now), `usage_anchor_at`, `limit_overrides` (jsonb NOT NULL default `{}`), `stripe_price_id`, `provider_status`, `provider_synced_at`, `provider_event_created_at`; `status` default → `trialing`.
**Indexes:** `subscriptions_status_idx`, `subscriptions_billing_source_idx`, partial UNIQUE `subscriptions_stripe_customer_ux` / `subscriptions_stripe_subscription_ux` (WHERE NOT NULL — one Stripe customer/subscription binds to at most one company).
**`plans`:** `scans_limit` added; `price_monthly`, `currency`, `api_limit` deprecated (never read).
**New tables:** `plan_prices` (plan FK, provider, `provider_price_id` UNIQUE, product, interval, interval_count, currency, `unit_amount_minor`, nickname, active, `verified_at`, created_by), `billing_checkout_sessions` (company/subscription FK cascade, plan price FK, `idempotency_key` UNIQUE, `provider_session_id` UNIQUE, status created|completed|expired|failed), `billing_provider_events` (`event_id` UNIQUE, type, provider created, received/processed, status received|processed|ignored|failed, outcome, failure code, attempts, company/subscription refs — **no payload**), `subscription_usage_reservations` (company FK cascade, resource, quantity, `idempotency_key` UNIQUE, status pending|consumed|released, scan id, expires/consumed/released timestamps).
**Deprecated, retained (never read for access or enforcement):** `subscriptions.scans_used`, `scans_limit`, `users_limit`, `admins_limit`, `employees_limit`, `contacts_limit`, `events_limit`, `storage_limit_mb`, `api_limit`, `trial_ends_at` (date), `renewal_date` (date); `companies.plan`, `status`, `trial_ends_at`, `scans_used`.
**Deferred by design:** a DB FK `subscriptions.plan → plans.id` and status CHECK constraints — a push adding them would fail on an environment whose plan catalog has not been seeded / whose legacy `trial` rows have not been repaired. Add them in a later batch after every environment has run the repair.

Local push classification (Drizzle `push` on a scratch copy, then the local dev DB): 41 statements — 4 CREATE TABLE, 1 default change, 22 ADD COLUMN, 5 FK on new tables, 7 CREATE INDEX, 2 partial unique indexes; **no DROP / RENAME / type change / NOT NULL on an existing column / data statement**; second pass "No changes detected".

---

## 6. Repair algorithm (`artifacts/api-server/scripts/repair-subscriptions.ts`)

Explicit operator command, never run from startup or a request. Dry-run by default, `--apply` to write, `--company=<id>` to scope either mode to one company (targeted repair; used by the tests). Rules (pure, unit-tested in `lib/billing/repair-rules.ts`):

* **R1** seed the five stable plans (insert-if-missing).
* **R2** company **without** a subscription → create ONE manual row from the legacy company columns so nobody gains or loses access: `trial` + future `trial_ends_at` → `trialing` (same end); `trial` + past end → `trialing` (same end; blocked, then swept to `expired`); `trial` + NULL end → `active` (never expired before; **no new trial is invented**); other legacy states → the same canonical state.
* **R3** existing row → legacy `trial` → `trialing`; status from `companies.status` (the pre-B20 access authority) when they disagree; plan from `companies.plan`; trial end = `companies.trial_ends_at ?? subscriptions.trial_ends_at`; `billing_source=manual`; `trial_started_at`/`usage_anchor_at` backfilled from `created_at`; mirrors re-synced.
* **R4** **abort before any write** (exit 2) on: duplicate rows per company, populated `stripe_*` ids, a plan outside the catalog, an unknown status.
* **R5** idempotent: canonical rows are skipped; after `--apply` a verification plan must be empty (exit 3 otherwise).

Output is aggregate JSON only (counts by rule; no names, e-mails or ids beyond the scoped company id). Audit rows `subscription.repair_create` / `subscription.repair_update` are written per changed row.

**Local evidence:** dry-run `companies=93 subscriptions=93 plannedUpdates=93` (`legacy_active 16`, `trial_lapsed 24`, `trial_future 53`), conflicts 0 → `--apply` updated 93 → verify `plannedUpdates 0, alreadyCanonical 93`; plans = 5. `test/b20-subscriptions.test.ts` re-proves create / normalise / abort on a scoped disposable company on every run.

---

## 7. Provider configuration (fail-closed)

| Variable | Meaning |
|---|---|
| `BILLING_PROVIDER` | `none` (default) · `stripe` · `fake` (offline deterministic provider; refused in production) |
| `STRIPE_SECRET_KEY` | read only by the provider factory (`lib/billing/provider.ts`); never logged/audited/returned |
| `STRIPE_WEBHOOK_SECRET` | required for `stripe` **and** `fake`; official SDK signature verification |
| `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` | optional portal configuration |
| `BILLING_SELF_SERVICE_CHECKOUT` | master switch for tenant Checkout (default off) |
| `BILLING_RETURN_URL` (fallback `APP_BASE_URL`) | trusted return origin for Checkout/Portal; never taken from a request |
| `BILLING_AUTOMATIC_TAX` | off until the tax policy is approved |
| `BILLING_WEBHOOK_MAX_BODY_BYTES` (256 KiB) · `BILLING_USAGE_RESERVATION_TTL_MS` (10 min) | limits |
| `JOBS_SUBSCRIPTION_SWEEP_DELAY_MS` (20 s) · `JOBS_SUBSCRIPTION_SWEEP_INTERVAL_MS` (15 min) | sweep cadence |

Selection truth table (`resolveBillingProviderSelection`, unit-tested): unset/none → unavailable `NOT_CONFIGURED`; stripe without key → `STRIPE_SECRET_KEY_MISSING`; stripe without webhook secret → `STRIPE_WEBHOOK_SECRET_MISSING`; fake in production → `FAKE_PROVIDER_FORBIDDEN`; unknown value → `UNKNOWN_PROVIDER`. When unavailable: Checkout/Portal/price registration answer `503 PROVIDER_UNAVAILABLE`, the webhook answers 503, tenants see "not available", and `/readyz` is unaffected. The official `stripe` SDK is imported only by `stripe-provider.ts` and `fake-provider.ts` (structural test). Frontends never call Stripe.

---

## 8. Checkout, Portal and webhook mapping

**Checkout (`POST /subscriptions/checkout {planPriceId}`)** — the browser sends only the internal active price-mapping id; price ids, amounts, currencies and URLs are resolved server-side. Under the subscription row lock: eligibility re-checked, an open unexpired session for the same price is **reused**, exactly one provider customer per company is created (idempotency key `customer:<sha256>`), a local session row is inserted with an opaque `checkout:<sha256(company|price|uuid)>` key, `success_url/cancel_url = BILLING_RETURN_URL/admin/subscription?checkout=success|cancelled`, metadata = opaque internal ids only (companyId, subscriptionId, checkoutId, planId — never e-mail). Provider failure → `502 PROVIDER_ERROR`, transaction rolled back, entitlement untouched. **No local entitlement changes at Checkout time.**

**Portal (`POST /subscriptions/portal`)** — only for provider-managed rows with a linked customer; trusted return URL; audited (`subscription.portal_opened`).

**Webhook (`POST /api/v1/billing/stripe/webhook`, alias `/api/billing/stripe/webhook`)** — raw body (`express.raw`, mounted before `express.json`), signature verified with the official SDK against `STRIPE_WEBHOOK_SECRET`: 400 `SIGNATURE_MISSING` / `SIGNATURE_INVALID` / `EVENT_MALFORMED` / `BODY_INVALID`, 413 oversized, 503 provider unavailable, 200 for processed / duplicate / ignored, **500 on a temporary failure so Stripe retries** (the durable event row is marked `failed` with a sanitized code; the next delivery of the same id is retried, a processed id answers `duplicate` with no second mutation).

| Event | Handling |
|---|---|
| `checkout.session.completed` | closes the local checkout row, links the customer, fetches the authoritative provider subscription and applies it |
| `customer.subscription.created` / `updated` | resolve by bound ids or server metadata (all must agree → otherwise `mismatch`), fetch the provider's current object, apply |
| `customer.subscription.deleted` | apply the delivered object (provider no longer holds it) |
| `invoice.paid` / `invoice.payment_failed` | re-read the referenced provider subscription (the subscription object is the authority) and apply |
| anything else | `unsupported` (200, recorded as ignored) |

Outcomes recorded per event: `applied`, `no_change`, `duplicate`, `stale` (older than the newest applied event — out-of-order safe), `unbound`, `mismatch`, `unsupported`, `failed`. Tenants are **never** identified by e-mail.

**Provider → canonical status:** `trialing→trialing`, `active→active`, `past_due→past_due`, `unpaid→past_due`, `paused→past_due`, `canceled→cancelled`, `incomplete`/`incomplete_expired`/unknown → **entitlement unchanged**. The plan follows the **verified** price mapping the subscription is billed on; an unmapped price never changes the plan. Provider events are audited as `subscription.provider_sync` by actor `system:stripe-webhook` with the event type and opaque id only.

---

## 9. Idempotency summary

| Concern | Key / guard |
|---|---|
| Webhook deliveries | `billing_provider_events.event_id` UNIQUE (23505 → duplicate); failed rows retried; ordering by provider `created` vs `provider_event_created_at` |
| Checkout | one open session per company (row lock, reuse), opaque `checkout:<sha256>` idempotency key, `provider_session_id` UNIQUE |
| Provider customer | `customer:<sha256>` idempotency key, `stripe_customer_id` partial UNIQUE |
| Scan reservations | `scan:<company>:<user>:<sha256(image)[:32]>` and `batch:<company>:<job>:<item>`; a consumed reservation within the TTL is honoured as already paid (client retry), released on validation/OCR failure or no-card, batch reserves every image item up front and releases all on any failure |
| Lifecycle sweep | `FOR UPDATE SKIP LOCKED` batches; the transition predicate is false on a second pass; dispatched through the durable recurring-sweep job with a cadence-bucket dedupe key |

---

## 10. Limit semantics (non-blocking defaults)

* Resources: `contacts`, `events`, `admins`, `employees`, `scans`, `storageMb`. Effective limit = `limit_overrides[resource]` ?? `plans.<resource>_limit` ?? **unlimited (null)**. The seeded catalog leaves every default NULL, so nothing is enforced until the platform owner sets an override (`PUT /platform/subscriptions/:id/limits`) or a plan default is configured.
* Enforcement lives in **one** place (`services/entitlements.service.ts#assertCapacity`), called **inside** the mutation transaction under a per-tenant+resource advisory lock (`pg_advisory_xact_lock(hashtext('b20:<company>:<resource>'))`) so parallel requests — and a CSV import racing a direct create — contend on the same boundary. Wired into: `POST /contacts`, `POST /imports/commit` (whole import all-or-nothing), `POST /events`, `POST /users` + `POST /invitations` (role family `admins` = admin/primary_admin, `employees` = employee; pending unexpired invitations count; acceptance excludes its own invitation), `PATCH /users/:id` role-family changes, `POST /scans` (reservation before any provider work) and `POST /scans/batch-analyze` (per image item).
* Error: `409 LIMIT_EXCEEDED` with `context { resource, limit, used, requested }`.
* Scan usage window: the current billing period when one exists, otherwise the calendar-month window anchored at `usage_anchor_at` → `trial_started_at` → `created_at` (day-of-month clamped). Usage = completed/processing OCR scan rows (manual entries excluded) + counted reservations without a scan row.
* **Storage is reported but not enforced or measured** (`measurable:false`, `enforced:false`): object storage is external and not metered durably. `apiLimit` is obsolete (public API keys are removed scope).
* `GET /subscriptions/usage` returns the same calculation the enforcement uses (`used`, `limit`, `remaining`, `source`, `enforced`, `measurable`, details).

---

## 11. Truthful metrics rules

* Revenue (`/platform/subscriptions/metrics`, `/platform/stats`) is computed **only** from `active` provider-managed subscriptions bound to a verified price mapping; otherwise `available:false` with `NO_VERIFIED_PRICES`, `NO_ACTIVE_PROVIDER_SUBSCRIPTIONS`, `UNPRICED_SUBSCRIPTIONS` or `MIXED_CURRENCIES` (`PARTIAL_UNPRICED` when some live rows are unpriced). Never an estimate, never a zero presented as revenue.
* `/platform/revenue-trend` reports `available:false, reason NO_REVENUE_HISTORY` (no invoice history is stored); `/platform/scan-trend` is real daily OCR counts.
* Counts by canonical status / plan / billing source come from the subscriptions table; `activeCompanies` = active + trialing; the tenant page shows verified prices only (`unit_amount_minor` from the provider).
* Removed from the web portals: `Math.random`, hard-coded prices/revenue, percentage-derived "inactive/suspended" splits, fabricated rows, growth percentages, non-functional "Manage"/"Add Company"/upgrade buttons (structural test + `e2e/x-billing.spec.ts`).

---

## 12. Hosted activation prerequisites (NOT performed in B20)

Hosted read-only inspection (ops branch `ops/b20-hosted-inspection` @ `9375d8c`, run #2 id 34360691499, SELECT-only under `default_transaction_read_only=on`): plans 0, subscriptions 1, companies 1, users 2; `free/trial` on both records; no missing/duplicate/orphan rows, no drift, no provider ids anywhere, no CHECK/plan FK, schema fingerprint `e839d03d928fa46c20797329d2779e3e`. The single hosted row is a lapsed trial (both dates equal).

When the batch is approved for the hosted environment, in this order:

1. Fast-forward `develop` and let the existing deploy workflow build the new image (never `export-ready`/`main`).
2. Schema push (`pnpm --filter @workspace/db run push`) — additive statements only (§5); take the usual backup first.
3. `tsx scripts/repair-subscriptions.ts` (dry-run; expect 1 update `trial_lapsed`, 0 conflicts) → `--apply` → verify `plannedUpdates 0`. Expected effect on the single hosted row: `trial → trialing` with the same lapsed end → **blocked exactly as today**, then the sweep marks it `expired` within one cadence; the platform owner starts a trial / activates it from `/platform/subscriptions`.
4. Restart the API (plan catalog seeded at start; sweep registered).
5. Leave `BILLING_PROVIDER` unset (manual billing only) until the commercial decisions below are made; never store app secrets in GitHub.
6. Delete the temporary remote branch `ops/b20-hosted-inspection` manually (the git proxy cannot delete remote branches).

---

## 13. Remaining commercial decisions (required before Stripe goes live)

Plan prices per plan (incl. `business`; `enterprise` priced or "contact us"), currencies (single vs per-currency prices), monthly vs annual cadence and proration on plan change, trial policy for Stripe Checkout (`trial_period_days` vs the manual 14-day trial), tax/VAT policy (`BILLING_AUTOMATIC_TAX`, invoicing entity, `companies.vatNumber` at Checkout), the Stripe account + Billing Portal configuration, **production price ids** to register through `/platform/billing/prices`, dunning/grace windows beyond Stripe's defaults, and which plan limit defaults (if any) become non-null.

---

## 14. Non-goals of B20 (unchanged)

No live Stripe credentials or prices, no hosted Checkout activation, no tax, coupons, refunds, invoices, dunning, multi-currency UX, no automatic deletion, no Customer Portal restore, no public API-key billing, no AI, no mobile, no custom domains, no B21.

---

## 15. Test coverage map

| Suite | What it proves |
|---|---|
| `test/b20-lifecycle-unit.test.ts` (35) | resolver, transition table, provider mapping, usage window, limit precedence, repair rules, audit sanitization, payload normalization, offline signature verification, provider selection |
| `test/b20-structural.test.ts` (19) | no legacy-column reads on the gate path, webhook before JSON parser, SDK confinement, reads never write, no simulated UI metrics |
| `test/b20-subscriptions.test.ts` (26) | transactional creation, authorization/isolation, tombstone, GET-never-writes, every manual transition with its access effect, audit, limit overrides, list/metrics/stats, sweep, repair dry-run/apply/abort, registration |
| `test/b20-billing-stripe.test.ts` (19) | fake provider status, server-verified prices, serialized idempotent Checkout, Portal gating, webhook transport (400/413/duplicate/unsupported), lifecycle through signed events (bind, active, past due, stale, invoices, mismatch, unbound, suspension shadow, cancellation, convert-to-manual, re-bind), manual-op refusal, revenue, retry after provider failure, no secret leaks |
| `test/b20-limits-concurrency.test.ts` (12) | parallel creates/imports/events/users/invitations/role changes/scans/batches never exceed a limit; releases and retries |
| `e2e/x-billing.spec.ts` (13) | truthful tenant page, permission gating, Checkout → webhook → Portal, read-only rendering, platform list/detail/confirmations, dashboard/companies truthfulness, isolation/role routing, responsive light/dark without overflow or console errors |
