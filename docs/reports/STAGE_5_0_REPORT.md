# Stage 5.0 — AI Platform Foundation

Status: **COMPLETE**. Typecheck (full workspace) clean; pre-merge gate green (21 files / 334 tests).

## Scope

Delivered the provider-agnostic AI foundation only. **Excluded** (future stages 5A–5F):
external enrichment providers, pgvector/embeddings, and all downstream AI feature work.
Every change is **additive** — existing auth/RBAC, tenant isolation, and API/DB contracts
are preserved, and existing AI features (card OCR, lead scoring, contact enrichment)
behave identically by default.

## What shipped

### Data model (additive, no changes to existing tables)
- `ai_settings` — per-tenant (`company_id`) AI configuration: enable flag, per-feature
  flags, optional monthly token/cost budgets, optional provider/model override. Absent
  row = effective defaults (everything enabled) so behavior is unchanged until a tenant
  opts to customize.
- `ai_invocations` — append-only usage/cost ledger. One row per provider call: feature,
  provider, model, prompt key/version, status, token counts, `estimated_cost_micro_usd`
  (integer micro-USD for float-free precision), latency, optional confidence, redacted
  error. `company_id` is nullable — system/non-tenant calls are invisible to tenant reads
  and only surface in platform-owner aggregates. Never updated or deleted (like `audit_logs`).

### AI abstraction
- Provider-agnostic AI module (adapter interface + Gemini adapter + prompt registry +
  invocation recording) with a per-call context (`ctx`) carrying tenant/user/feature so
  every call is attributed and ledgered.
- `src/lib/ai.ts` refactored to route `extractCardData` / `scoreLead` / `enrichContact`
  through the abstraction while preserving existing signatures, timeouts, and graceful
  degradation (scans still 502 on OCR failure; contact creation still degrades to a null
  lead score on AI failure). `ctx` is threaded from `scans`/`contacts`/`leads` services.
- Runtime provider/model is resolved from the tenant's **effective** `ai_settings`
  (`resolveSettings`) when company context is present, falling back to platform defaults
  for system calls. This is the **same** resolver that backs `GET /ai/settings` and
  `GET /ai/health`, so what a tenant sees reported is exactly what executes — no
  reports-one-model-runs-another drift. (Fix applied after code review flagged the
  original `callJson` hardcoding global config.)
- `config.ai` centralizes provider/model/env resolution
  (`AI_INTEGRATIONS_GEMINI_API_KEY` / `AI_INTEGRATIONS_GEMINI_BASE_URL`).

### API (`ai` tag in `openapi.yaml`, Orval-regenerated)
- `GET /ai/settings` — effective settings (tenant users).
- `PATCH /ai/settings` — update settings (**primary_admin only**, read-only-blocked, audited).
- `GET /ai/usage` — tenant usage aggregation (totals, by-feature, recent).
- `GET /ai/health` — provider config + last-24h reliability (tenant users).
- `GET /ai/platform/usage` — platform-wide aggregate incl. per-company breakdown
  (**platform_owner only**).

Guards mirror existing modules and are **path-scoped** to avoid the documented
router-level guard-leak. Validation is performed inside the service (no `validateBody`),
returning 400 on unknown flags / negative budgets.

### Web
- Admin `/admin/ai` — AI Settings + health + usage dashboard (form editable by
  primary_admin; read-only for others).
- Platform `/platform/ai` — platform-wide AI usage/cost intelligence.
- Nav entries added to Admin + Platform layouts; routes wired in `App.tsx`.

## Tests
- New `test/ai-platform.test.ts`: effective-settings defaults, primary_admin-only PATCH
  (RBAC), per-feature flag persistence, usage aggregation + micro-USD cost math, provider
  health, cross-tenant ledger isolation, and the platform-owner tenant firewall
  (blocked from tenant reads, allowed on the platform aggregate). All fixtures use
  throwaway tenants torn down in `afterAll`.
- Existing AI path verified green via the `contacts-ai` suite (extraction/scoring/enrichment
  through the refactored context-threaded path).

## Deviations from plan
1. **AI abstraction lives in `artifacts/api-server/src/ai/`**, not a separate `lib/*`
   package. It is currently server-only; promoting it to a shared lib is unnecessary until
   a second consumer exists.
2. **Raised the general auth-surface rate ceiling for the dev/test server only.** The
   pre-merge suite already consumed ~98/100 of `authRateLimiter` (the general `/api/auth`
   ceiling, which counts *all* requests) on a single clean run — 2 requests of headroom.
   Any new test file needing auth tokens (like this one) tipped it to a nondeterministic
   `429`. `AUTH_RATE_MAX` is env-overridable by design and no test asserts the 100 value,
   so the api-server `dev` script now sets `AUTH_RATE_MAX=${AUTH_RATE_MAX:-100000}`.
   This is **dev-only** (production runs `start` directly and keeps the default 100) and
   leaves the real credential-abuse guards untouched and testable: the login-failure
   limiter (`LOGIN_RATE_MAX=20`, failures-only) and the per-account DB brute-force lockout
   (`LOGIN_MAX_ATTEMPTS=5`).

## Operational notes
- Run `pnpm --filter @workspace/api-spec run codegen` after any `openapi.yaml` edit and
  `pnpm --filter @workspace/db run push` after schema edits (both done).
- Gate procedure unchanged: restart the `artifacts/api-server: API Server` workflow before
  the full suite. If the demo tenants ever start returning `429` on login, the
  `login_attempts` table has accumulated stale lockout rows across many runs — truncate it
  (dev only) and restart; it survives workflow restarts because it is DB-backed.
