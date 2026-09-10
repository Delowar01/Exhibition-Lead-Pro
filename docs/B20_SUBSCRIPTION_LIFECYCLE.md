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
**New tables:** `plan_prices` (plan FK, provider, `provider_price_id` UNIQUE, product, interval, interval_count, currency, `unit_amount_minor`, nickname, active, `verified_at`, created_by), `billing_checkout_sessions` (company/subscription FK cascade, plan price FK, `idempotency_key` UNIQUE, `provider_session_id` UNIQUE, status creating|open|completed|expired|failed — intent states since Correction 1), `billing_provider_events` (`event_id` UNIQUE, type, provider created, received/processed, status received|processed|ignored|failed, outcome, failure code, attempts, company/subscription refs — **no payload**), `subscription_usage_reservations` (company FK cascade, resource, quantity, `idempotency_key` UNIQUE, status pending|consumed|released, scan id, expires/consumed/released timestamps).
**Deprecated, retained (never read for access or enforcement):** `subscriptions.scans_used`, `scans_limit`, `users_limit`, `admins_limit`, `employees_limit`, `contacts_limit`, `events_limit`, `storage_limit_mb`, `api_limit`, `trial_ends_at` (date), `renewal_date` (date); `companies.plan`, `status`, `trial_ends_at`, `scans_used`.
**Correction 1 — final integrity constraints (additive, applied in a SECOND stage after the repair has run, §12/§16.7):** `subscriptions.plan → plans.id` FK, CHECKs `subscriptions_status_chk` (`trialing|active|past_due|cancelled|expired|suspended`), `subscriptions_billing_source_chk` (`manual|stripe`), `subscriptions_status_before_suspension_chk` (null or a non-suspended canonical status); `plan_prices` CHECKs provider (`stripe`), interval (`day|week|month|year`), `interval_count > 0`, `unit_amount_minor >= 0`, currency `^[a-z]{3}$`, `provider_mode` (`test|live`) + new column `provider_mode` (NOT NULL default `test`); `billing_checkout_sessions` plan FK, CHECKs provider / status (`creating|open|completed|expired|failed`) / `provider_mode`, new column `provider_mode`, status default `creating`, partial UNIQUE `billing_checkout_sessions_current_ux (company_id) WHERE status in ('creating','open')`; `billing_provider_events` CHECKs provider / `provider_mode` / status (`received|processed|ignored|failed`) / outcome (null or `applied|duplicate|stale|unbound|unsupported|mismatch|no_change|conflict|price_unmapped`) / `attempts >= 1`, new column `provider_mode`; `subscription_usage_reservations` CHECKs resource (`scans`), status (`pending|consumed|released`), `quantity > 0`. Every earlier uniqueness / partial index is kept; no column is removed, renamed or retyped.

Push classification, stage 1 (B20 additive schema `4f42931`, rehearsed on the scratch copy of the hosted B18 schema): 39 statements — 4 CREATE TABLE, 1 default change, 20 ADD COLUMN, 5 FK on the new tables, 7 CREATE INDEX, 2 partial unique indexes; **no DROP / RENAME / type change / NOT NULL on an existing column / data statement**. Stage 2 (Correction 1 tip): 27 statements — 3 ADD COLUMN (`provider_mode` ×3, defaulted), 1 default change, 2 FK, 20 CHECK, 1 partial unique index; no destructive statement; second pass "No changes detected" (both the local dev DB and the scratch rehearsal).

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
| `BILLING_STRIPE_MODE` | **explicit expected Stripe mode** `test` \| `live` (Correction 1). Default: `live` in production, `test` elsewhere; production may use `test` only by setting it explicitly. Enforced on every Price (registration), Checkout Session, Subscription and Event `livemode`; must agree with the `sk_`/`rk_` key prefix; the fake provider is test mode only. Never inferred from user input |
| `BILLING_RETURN_URL` (fallback `APP_BASE_URL`) | trusted return origin for Checkout/Portal; validated centrally by `validateBillingReturnUrl` (Correction 1): absolute `http(s)` URL without credentials / query / fragment; **production requires HTTPS and refuses localhost / loopback; there is no implicit localhost fallback anywhere**; development may use an explicit `http://localhost…`. Invalid → Checkout and Portal unavailable with the stable reason `RETURN_URL_INVALID` (platform status shows `RETURN_URL_MISSING|INVALID|INSECURE|LOCALHOST`); manual billing, `/readyz` and every other feature stay healthy |
| `BILLING_AUTOMATIC_TAX` | off until the tax policy is approved |
| `BILLING_WEBHOOK_MAX_BODY_BYTES` (256 KiB) · `BILLING_USAGE_RESERVATION_TTL_MS` (10 min) | limits |
| `JOBS_SUBSCRIPTION_SWEEP_DELAY_MS` (20 s) · `JOBS_SUBSCRIPTION_SWEEP_INTERVAL_MS` (15 min) | sweep cadence |

Selection truth table (`resolveBillingProviderSelection`, unit-tested): unset/none → unavailable `NOT_CONFIGURED`; stripe without key → `STRIPE_SECRET_KEY_MISSING`; stripe without webhook secret → `STRIPE_WEBHOOK_SECRET_MISSING`; invalid `BILLING_STRIPE_MODE` → `STRIPE_MODE_INVALID`; key prefix disagreeing with the mode → `STRIPE_MODE_KEY_MISMATCH`; fake in production → `FAKE_PROVIDER_FORBIDDEN`; fake with `live` mode → `FAKE_PROVIDER_TEST_MODE_ONLY`; unknown value → `UNKNOWN_PROVIDER`. `GET /platform/billing/status` reports `stripeMode`, `returnUrlConfigured` and `returnUrlReason` (never the URL or a key). When unavailable: Checkout/Portal/price registration answer `503 PROVIDER_UNAVAILABLE`, the webhook answers 503, tenants see "not available", and `/readyz` is unaffected. The official `stripe` SDK is imported only by `stripe-provider.ts` and `fake-provider.ts` (structural test). Frontends never call Stripe.

---

## 8. Checkout, Portal and webhook mapping

**Checkout (`POST /subscriptions/checkout {planPriceId}`)** — the browser sends only the internal active price-mapping id; price ids, amounts, currencies and URLs are resolved server-side. Correction 1 made the orchestration **durable and provider-call-free under locks** (§16.1): a short transaction validates and finds-or-creates ONE durable checkout intent, the provider customer / session are created outside any transaction with keys derived from stable identifiers, and the returned URL is never stored. `success_url/cancel_url = BILLING_RETURN_URL/admin/subscription?checkout=success|cancelled`, metadata = opaque internal ids only (companyId, subscriptionId, checkoutId, planId — never e-mail). Provider failure → `502 PROVIDER_ERROR`, entitlement untouched. **No local entitlement changes at Checkout time.**

**Portal (`POST /subscriptions/portal`)** — only for provider-managed rows with a linked customer; trusted return URL; audited (`subscription.portal_opened`).

**Webhook (`POST /api/v1/billing/stripe/webhook`, alias `/api/billing/stripe/webhook`)** — raw body (`express.raw`, mounted before `express.json`), signature verified with the official SDK against `STRIPE_WEBHOOK_SECRET`: 400 `SIGNATURE_MISSING` / `SIGNATURE_INVALID` / `EVENT_MALFORMED` / `BODY_INVALID`, 413 oversized, 503 provider unavailable, 200 for processed / duplicate / ignored, **500 on a temporary failure so Stripe retries** (the durable event row is marked `failed` with a sanitized code; the next delivery of the same id is retried, a processed id answers `duplicate` with no second mutation).

| Event | Handling |
|---|---|
| `checkout.session.completed` | locates the local intent by its recorded provider session id, or — when the request crashed before saving it — by a VALIDATED `checkoutId` / `client_reference_id` (both must agree; non-terminal intent without another session; same customer and mode) and attaches the session id atomically — only after the resolved tenant is proven to own that intent (company + canonical subscription + customer), so a foreign intent can never inherit a session id; completes the intent (`providerSubscriptionId` recorded), links the customer, applies the authoritative provider subscription fetched **before** the transaction (the intent is the ownership proof, §16.3) |
| `customer.subscription.created` / `updated` | resolve by bound ids, server metadata or the local intent referenced by `metadata.checkoutId` (all must agree → otherwise `mismatch`), apply the provider's current object |
| `customer.subscription.deleted` | apply the delivered object (provider no longer holds it) |
| `invoice.paid` / `invoice.payment_failed` | re-read the referenced provider subscription (the subscription object is the authority) and apply |
| anything else | `unsupported` (200, recorded as ignored) |

Outcomes recorded per event: `applied`, `no_change`, `duplicate`, `stale` (older than the newest applied event — out-of-order safe), `unbound`, `mismatch`, `unsupported`, `conflict` (a second LIVE provider subscription for a company — §16.3), `failed` (with `outcome = price_unmapped` for an unregistered price — §16.5). Every event row carries the verified `provider_mode`. Tenants are **never** identified by e-mail. The race-safe processing algorithm is in §16.4.

**Provider → canonical status:** `trialing→trialing`, `active→active`, `past_due→past_due`, `unpaid→past_due`, `paused→past_due`, `canceled→cancelled`, `incomplete`/`incomplete_expired`/unknown → **entitlement unchanged**. The plan follows the **verified** price mapping the subscription is billed on (inactive mappings still resolve existing subscriptions); a live subscription on an **unregistered** price is a sanitized failure (`PROVIDER_PRICE_UNMAPPED`, 500 → Stripe retries; nothing changes until the operator registers the price — §16.5); a terminal event still cancels without any price. Provider events are audited as `subscription.provider_sync` by actor `system:stripe-webhook` with the event type and opaque id only.

---

## 9. Idempotency summary

| Concern | Key / guard |
|---|---|
| Webhook deliveries | `INSERT … ON CONFLICT (event_id) DO NOTHING` claim inside the processing transaction + `FOR UPDATE` on the existing row (no 23505 inside a transaction); only new or `failed` rows are processed; conditional failure upsert (`WHERE status = 'failed'`); `attempts` +1 per attempt; ordering by provider `created` vs `provider_event_created_at` |
| Checkout | one durable intent per company (`billing_checkout_sessions_current_ux` partial UNIQUE over `creating|open`), provider session key `checkout:<sha256("checkout|"+companyId+"|"+intentId)>` (deterministic per intent — a retry or a concurrent request sends the SAME key), `provider_session_id` UNIQUE |
| Provider customer | `customer:<sha256("customer|"+companyId)>` (stable per company — a retry after a local failure re-sends the same key and receives the same customer), `stripe_customer_id` partial UNIQUE |
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
2. **Stage 1 — B20 additive schema** (`pnpm --filter @workspace/db run push` from commit `4f42931`, i.e. `git checkout 4f42931 -- lib/db/src/schema` on a throw-away checkout, or the `wt-b20` worktree procedure of the rehearsal script) — additive statements only (§5, 39 statements, 0 destructive); take the usual backup first. **Do not push the Correction 1 schema before the repair has run**: its `subscriptions.plan` FK and status CHECK would fail on the legacy `free/trial` row and the empty plan catalog.
3. `tsx scripts/repair-subscriptions.ts` (dry-run; expect `plannedUpdates 1`, rule `trial_lapsed`, 0 conflicts) → `--apply` (seeds the 5-plan catalog in the same transaction) → verify `plannedUpdates 0 / alreadyCanonical 1`. Expected effect on the single hosted row: `trial → trialing` with the same lapsed end → **blocked exactly as today**, then the sweep marks it `expired` within one cadence; the platform owner starts a trial / activates it from `/platform/subscriptions`.
4. **Stage 2 — Correction 1 schema** (`pnpm --filter @workspace/db run push` from the correction commit) — 27 additive statements (3 defaulted columns, 1 default change, 2 FK, 20 CHECK, 1 partial unique index; §5); a second push must report "No changes detected". Rehearsed end-to-end on a scratch database representing the hosted B18 state (§16.7): no deletion, rewrite or manual edit of any row at any stage.
5. Restart the API (plan catalog seeded at start; sweep registered). Set `BILLING_STRIPE_MODE` explicitly (`live` in production once Stripe is approved) and make sure `BILLING_RETURN_URL` is an explicit HTTPS origin — otherwise tenant Checkout/Portal stay unavailable (`RETURN_URL_*`) while manual billing works.
6. Leave `BILLING_PROVIDER` unset (manual billing only) until the commercial decisions below are made; never store app secrets in GitHub.
7. Delete the temporary remote branch `ops/b20-hosted-inspection` manually (the git proxy cannot delete remote branches).

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
| `test/b20-lifecycle-unit.test.ts` (35, +`RETURN_URL_INVALID` capability cases) | resolver, transition table, provider mapping, usage window, limit precedence, repair rules, audit sanitization, payload normalization, offline signature verification, provider selection |
| `test/b20-structural.test.ts` (19) | no legacy-column reads on the gate path, webhook before JSON parser, SDK confinement, reads never write, no simulated UI metrics |
| `test/b20-subscriptions.test.ts` (26) | transactional creation, authorization/isolation, tombstone, GET-never-writes, every manual transition with its access effect, audit, limit overrides, list/metrics/stats, sweep, repair dry-run/apply/abort, registration |
| `test/b20-billing-stripe.test.ts` (19) | fake provider status, server-verified prices, serialized idempotent Checkout (`open` intents), Portal gating, webhook transport (400/413/duplicate/unsupported), lifecycle through signed events (bind, active, past due, stale, invoices, mismatch, unbound, **conflict**, suspension shadow, cancellation, convert-to-manual, re-bind only with server metadata), manual-op refusal, revenue, retry after provider failure, no secret leaks |
| `test/b20c1-billing-durability.test.ts` (29) | Correction 1: customer / session retry with the same remote objects, process-style retry on the durable intent, concurrent same-price → one remote session, price switch expires the old session at the provider first, provider expiry failure → no replacement, cancelled subscription self-recovery through Checkout in both event orders, stray subscription / forged metadata never take over, late old-subscription event ignored, recorded conflict, unknown price (Portal change) fails closed and applies after registration, an unproven new subscription is unbound, live-mode price / webhook rejected without data change, barrier-based concurrent identical deliveries, failed duplicate never downgrades processed, retry after genuine failure exactly once, rollback keeps entitlement + retryable, fail-closed limit service (`SUBSCRIPTION_MISSING` / `SUBSCRIPTION_PLAN_INVALID`), workflow runs refuse cancelled / past_due / suspended tenants with zero side effects and never replay, final DB constraints reject invalid direct writes, fault hooks reset |
| `test/b20c2-checkout-ownership.test.ts` (12) | Correction 2: crash after session creation + different-price request recovers through the same key and expires the original first (peak open remote sessions = 1); recovery / expiry / idempotency-conflict failures leave the intent current with no replacement or second session; same-price retry resolves to the original session; crash after provider expiration recovers; concurrent same/different-price requests (barrier) never exceed one open session; cached creation reply never trusted; metadata-only, missing, nonexistent, expired, failed, cross-company, wrong-customer, wrong-mode, wrong-price and A-vs-B checkout ids never bind; both legitimate orders plus the id-less-intent completion bind exactly once; wrong-livemode retrieval fails safely across webhook / invoice / manual sync / reconciliation; every provider call proven outside transactions |
| `test/b20c1-config-unit.test.ts` (28) | `resolveBillingStripeMode`, `stripeKeyMode`, provider selection with mode enforcement, `validateBillingReturnUrl` across production/development combinations |
| `test/b20-limits-concurrency.test.ts` (12) | parallel creates/imports/events/users/invitations/role changes/scans/batches never exceed a limit; releases and retries |
| `e2e/l-ocr-scan.spec.ts` (2) | (Correction 1 hygiene) records the deterministic reservation keys it creates and deletes exactly those in `afterAll`, asserting none remain |
| `e2e/x-billing.spec.ts` (13) | truthful tenant page, permission gating, Checkout → webhook → Portal, read-only rendering, platform list/detail/confirmations, dashboard/companies truthfulness, isolation/role routing, responsive light/dark without overflow or console errors |

---

## 16. Correction 1 — Stripe durability, webhook concurrency and canonical integrity

### 16.1 Durable Checkout (intent states, stable keys, durability boundary)

`billing_checkout_sessions` rows are **durable Checkout intents**: `creating` (intent persisted, no provider session linked yet) → `open` (provider session id + expiry linked) → `completed` (`checkout.session.completed` verified; `provider_subscription_id` recorded) | `expired` (expired at the provider, then locally) | `failed` (definitive provider refusal / mode mismatch). The partial unique index `billing_checkout_sessions_current_ux` allows **one** `creating|open` intent per company at the database.

`createCheckout` (`services/subscriptions.service.ts`) never calls the provider while a transaction or row lock is open:

1. **Short transaction** — lock the canonical subscription, validate price (active, registered, same `provider_mode`), capabilities, find-or-create the intent (`INSERT … ON CONFLICT DO NOTHING` on the partial index; a concurrent loser re-reads). Audit `subscription.checkout_started`. Commit.
2. **Provider customer** (outside any transaction) with the stable key `customer:<sha256("customer|"+companyId)>`; then a short transaction links `stripe_customer_id` (409 `PROVIDER_CUSTOMER_MISMATCH` if another id is already linked). A retry after a local failure re-sends the same key and receives the same customer — never a second one.
3. **Provider session** (outside any transaction) with the intent-derived key `checkout:<sha256("checkout|"+companyId+"|"+intentId)>`; metadata = opaque ids only. A transient provider failure keeps the intent `creating` (the retry reuses the key); a definitive refusal marks it `failed`; a session in the wrong `livemode` marks it `failed` (502 `PROVIDER_MODE_MISMATCH`).
4. **Short transaction** links `provider_session_id` + `expires_at` (`creating → open`). Concurrent requests that created the SAME session with the SAME key are tolerated; anything else → 409 `CHECKOUT_IN_PROGRESS`.
5. The hosted URL is returned only after the durable link and is **never stored**.

**Reuse rules (same price):** an intent with a KNOWN provider session id is resolved **authoritatively** (`retrieveCheckoutSession`, never a cached reply): `open` → `reused` (a `creating` row left behind by a crashed request is linked on the spot); `complete` → reconciled (409 `CHECKOUT_ALREADY_COMPLETED`); `expired` → local `expired`, a fresh intent follows; unknown at the provider / other → 502 `PROVIDER_ERROR` and the intent **stays current**. An intent WITHOUT a session id replays the creation with its stable key, persists the returned id (compare-and-set, intent still non-terminal) and then also retrieves the current state before linking (`creating → open`) — the creation reply may be an idempotent replay of a session that has since expired or completed.

**Replacement rules (different price) — Correction 2 recovery algorithm (`closeIntent`).** Invariant: a `creating` intent whose provider session id was never stored is **never** retired or replaced until the remote state behind its stable idempotency key has been resolved authoritatively; at every externally visible boundary at most one remote Checkout session per company is open; no provider call runs inside a transaction or under a row lock.

1. *Recover the session id* (only when it is missing): if the intent never had a provider customer, no session could have been created → local `expired` without any provider call. Otherwise replay the ORIGINAL creation (`checkout.sessions.create`) with the intent-derived key `checkout:<sha256("checkout|"+companyId+"|"+intentId)>` and parameters rebuilt from the durable intent + server configuration (customer, price mapping, return URLs, `client_reference_id`, opaque metadata, automatic-tax flag — nothing is stored; no URL, secret or PII). Same key + identical parameters → the same session (or it is created now if the original request never reached the provider); a parameter mismatch (configuration changed since), transient failure or timeout → 502 `PROVIDER_ERROR`, **intent stays current, no replacement**. The reply is used only for the session id.
2. *Persist the id* through a short compare-and-set transaction (`attachProviderSession`: non-terminal row, no other session id) keeping the intent non-terminal; a concurrent request that changed the row → 409 `CHECKOUT_IN_PROGRESS`.
3. *Settle the remote session* from a fresh retrieval: `open` → `checkout.sessions.expire` at the provider and confirm; a "not open" answer (concurrent closer) is re-checked by retrieving again and accepted only when the state is `expired`; `complete` → reconcile (customer link, intent completed, provider subscription applied under proof) and refuse the replacement (409 `CHECKOUT_ALREADY_COMPLETED`); `expired` → proceed; missing / unknown / failed → 502 `PROVIDER_ERROR`, intent stays current.
4. *Local closure* (`creating|open → expired`, audit `subscription.checkout_expired` with `providerClosed`) — only now may the different-price intent be inserted (the loop re-enters step 1 of §16.1).

A crash after the provider expiration but before the local transition leaves a non-terminal row whose remote state is `expired`; the next request (same or different price) resolves it from the provider and moves on without a second expiration. Operational note: Stripe idempotency keys and Checkout sessions both expire after 24 h, so a replay that conflicts (configuration drift) is bounded — after 24 h the replay simply creates a new session that is closed in the same pass while the original has expired on its own.

The fake provider keeps a real remote-session registry (`remoteSessions()`, `remoteOpenSessionCount()`, `remoteMaxOpenSessionCount()` high-water mark, `expireCheckoutSession`) and Stripe-faithful idempotency (same key + same parameters → the ORIGINAL reply is replayed; same key + different parameters → `StripeIdempotencyError:idempotency_key_parameters_mismatch`), so tests observe provider-side state and never trust a cached reply.

### 16.2 Return URL and Stripe mode

See §7. **Correction 2 — mode enforcement paths:** `applyProviderState` asserts `remote.livemode === (BILLING_STRIPE_MODE === "live")` before any decision or write, and the resolved price mapping's persisted `provider_mode` must equal the configured mode; this covers `checkout.session.completed` reconciliation, `customer.subscription.*`, invoice-triggered subscription retrieval, tenant/platform manual sync and direct Checkout reconciliation. A signed event / primary object in the wrong mode is still rejected `400 LIVEMODE_MISMATCH` (no ledger row, no mutation); a **retrieved** subscription in the wrong mode raises `ProviderModeMismatchError` → webhook: transaction rolled back, failure row `PROVIDER_MODE_MISMATCH`, 500 (retryable); manual sync: 409 `PROVIDER_MODE_MISMATCH`; Checkout reconciliation: 502 `PROVIDER_MODE_MISMATCH` (intent not completed, no replacement). Nothing is mutated — subscription, Checkout row, company mirror or audit — and no provider object, full id, URL or payload is logged or returned. `resolveBillingStripeMode` / `stripeKeyMode` / `validateBillingReturnUrl` are pure and unit-tested. Every `plan_prices`, `billing_checkout_sessions` and `billing_provider_events` row records the verified `provider_mode`; a price whose `livemode` disagrees with the configured mode is refused at registration (400 `PRICE_MODE_MISMATCH`) and can never be used for Checkout; a webhook whose event or object `livemode` disagrees is rejected `400 LIVEMODE_MISMATCH` before any read or write and is **not recorded**.

### 16.3 Cancelled provider subscription — self-service recovery and ownership

Terminal provider statuses (`canceled`, `incomplete_expired`) keep the binding for history but **do not permanently occupy it**. `applyProviderState` (`services/subscription-lifecycle.service.ts`):

| Local binding | Incoming provider subscription | Result |
|---|---|---|
| customer disagrees | any | `mismatch` (nothing changes) |
| older than the newest applied event | any | `stale` |
| bound, same id | any | applied (status/plan/period follow the provider) |
| bound **live**, different id | live | **`conflict`** — recorded (`billing_provider_events.outcome = conflict`, audit `subscription.provider_conflict`, platform detail `providerConflict`); the operator resolves it in Stripe; nothing changes |
| bound live or terminal, different id | terminal | `unbound` (late/foreign event) |
| bound **terminal**, different id | live **and linked** | **replaced** (audit `subscription.provider_replaced` with the masked old ref); status/plan/period/customer/price re-derived |
| bound terminal, different id | live, not linked | `unbound` |
| unbound (manual row) | live and linked | bound |
| unbound | anything else | `unbound` |

**Ownership proof (`linkageProven`, Correction 2) requires a REAL local Checkout record.** Metadata `companyId + subscriptionId` only *locates* a tenant and never binds on its own; metadata that disagrees with the located tenant or with the supplied checkout id disproves ownership outright. Candidate rows: the intent completed by the same `checkout.session.completed`, the intent referenced by `checkoutId` (metadata / `client_reference_id`), and a completed intent already recording the incoming provider subscription id.

| Relationship | Required |
|---|---|
| row company / subscription | = the located tenant's company and canonical subscription |
| row state | `creating` \| `open` (current intent) or `completed` — `expired` / `failed` never prove |
| provider customer | row customer (when known) = remote customer (= the bound customer) |
| provider mode | row `provider_mode` = configured mode (and the remote object passed the livemode assertion) |
| price | row price mapping's provider price = remote subscription price |
| provider session id | when both known, row session = the session in hand |
| provider subscription id | row value null or = the incoming subscription (a completed Checkout bound to A never authorizes B) |
| Checkout event ids | `client_reference_id` and metadata `checkoutId` must agree |

Both event orders work: `customer.subscription.created` before or after `checkout.session.completed` (the latter also completes an id-less intent left by a crash — §8). A random subscription for the same customer never takes over; binding by e-mail or customer id alone stays forbidden; a late event for the old subscription never overwrites the new binding.

### 16.4 Race-safe webhook processing

```
verify signature → mode check → fast duplicate read (no lock)
→ fetch provider state OUTSIDE any transaction (session, subscription)
→ [test fault point webhook.beforeClaim]
→ transaction:
     INSERT billing_provider_events … ON CONFLICT (event_id) DO NOTHING
     if no row: SELECT … FOR UPDATE existing → not failed → `duplicate` (no mutation) | failed → attempts+1, status received
     lock the subscription row; resolve; applyProviderState; write audit; status processed|ignored (+ outcome)
     [test fault point webhook.beforeCommit]
   commit
→ on any error: the transaction rolled back; recordProviderEventFailure OUTSIDE it —
   INSERT failed (attempts 1) ON CONFLICT DO UPDATE … WHERE status = 'failed' (attempts+1, sanitized code)
   → a concurrently processed / ignored row is never downgraded; answer 500 so Stripe retries.
```

No 23505 is ever raised inside the transaction; no provider call waits under a lock; two simultaneous deliveries of one event produce exactly one mutation and one audit transition (`applied` + `duplicate`), attempts increment exactly once per attempt, a rollback leaves the entitlement unchanged and the event retryable. Proven with a barrier-based real-PostgreSQL concurrency test.

### 16.5 Verified price requirement

A new binding or a plan change requires a registered `plan_prices` row (inactive mappings resolve existing subscriptions but never open Checkout). Ownership proof comes first (§16.3): a new subscription whose price differs from its Checkout intent is `unbound`. A proven or already-bound live subscription on an unregistered price → `ProviderPriceUnmappedError`: no change, event row `failed / price_unmapped / PROVIDER_PRICE_UNMAPPED` (masked, never the full Price id), 500 (Stripe retries), platform detail `providerPriceUnmapped` diagnostics; after the operator registers the price the retried delivery applies exactly once. Manual sync answers 409 `PROVIDER_PRICE_UNMAPPED`. A terminal event still cancels without any price.

### 16.6 Fail-closed entitlement services and background work

`entitlements.service.ts`: `assertCapacity`, `reserveScans`, `effectiveLimitsFor` and `usageReport` throw `SubscriptionIntegrityError` (409) — `SUBSCRIPTION_MISSING` when the company has no canonical row, `SUBSCRIPTION_PLAN_INVALID` when the plan row is missing. **Never unlimited.** (The plan FK makes the latter unreachable for new writes; the service still refuses.)

Workflow engine (`lib/workflows/engine.ts`): before **every** action the canonical entitlement is re-read (`loadTenantAccess`); `read_only` / `blocked` → no action executes (no email, notification, CRM mutation), the action row and the run are marked `failed` with `SUBSCRIPTION_NOT_WRITABLE` (`retryable: false`, access mode + reason recorded), history is retained, the queue never replays it; after reactivation a **new** event runs normally.

Other background handlers reviewed (Correction 1) — all now re-read the canonical entitlement through `lib/company-access.ts` (`tenantWritable`, `assertTenantWritable`, `writableCompanyIds`) and perform tenant side effects only for `full` access: follow-up reminders (push + `followUpNotifiedOn` marker), scheduled exports (artifact + storage), workflow alerts and AI usage alerts (notification + mirrored e-mail; the legacy `companies.status` filter, which mapped `past_due` to `active`, is gone), executive report jobs, and the four batch AI jobs (analysis, copilot, capture, workflow analysis — the enqueued principal snapshot is no longer trusted at execution time). Not gated by design: the email delivery job (its payload carries no tenant; every producer is gated), maintenance retention, the AI ledger retry (accounting of a call that already happened), subscription sweep (the lifecycle authority) and workflow recovery (re-enqueues only; execution is gated in the engine).

### 16.7 Two-stage activation rehearsal (scratch database)

`scratchpad/rehearsal-b20c1.sh` (not committed; procedure documented in §12): a fresh database received the pre-B20 schema (`c2cd467`, 68 tables — the hosted B18 fingerprint), the hosted-like data (0 plans, 1 company, 1 legacy `free/trial` subscription with a lapsed end), then **stage 1** (`4f42931`: 39 additive statements, 0 destructive), the repair (dry-run `plannedUpdates 1 / trial_lapsed` → apply → verify `plannedUpdates 0 / alreadyCanonical 1`; plan catalog 5 rows; row `free / trialing / manual`, `trial_expires_at` = the legacy end, `usage_anchor_at` set, no provider ids), then **stage 2** (Correction 1: 27 additive statements — 3 defaulted columns, 1 default change, 2 FK, 20 CHECK, 1 partial unique index; 0 destructive), 28 CHECK/FK constraints verified in `pg_constraint`, the three partial unique indexes present, the row unchanged, `status='trial'` / `plan='gold'` / `billing_source='paypal'` rejected, and a second push reporting **"No changes detected"**. No row was deleted, rewritten or edited by hand at any stage.

### 16.8 Test-data hygiene

`e2e/l-ocr-scan.spec.ts` computes the deterministic reservation keys of the two fixture uploads (`scan:<companyId>:<userId>:<sha256(dataUrl)[:32]>`), records them, deletes exactly those rows in `afterAll` (never a company-wide delete; safe when a test fails midway) and asserts none remain. Test-only fault hooks (`lib/billing/test-faults.ts`) are inert unless set, unavailable in production and reset after every test.

