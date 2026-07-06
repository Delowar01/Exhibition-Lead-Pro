# Stage 5A — Enterprise AI Intelligence

Status: **COMPLETE**. Full-workspace typecheck clean (api-server, web-app, mobile, libs); pre-merge gate green (**23 files / 383 tests**).

## Scope

Delivered per-entity, reviewable AI intelligence over a tenant's **own** CRM data
(leads, contacts, organizations). Every change is **additive** — existing auth/RBAC,
tenant isolation, and API/DB contracts are preserved, and no existing behavior
changes by default.

### Safety contract (non-negotiable, enforced end-to-end)
- **No fabricated data.** AI derives insights ONLY from data already present in the
  tenant's CRM. When the record has insufficient signal, the model returns
  "Not enough information" rather than inventing content.
- **Suggestions, never writes.** Insights never overwrite CRM fields. Nothing is
  applied automatically. Accepting a recommendation is an explicit, **audited** user
  action; dismissing is also audited.
- **Full provenance on every recommendation:** confidence (0–100 or null),
  reasoning, source (`ai` | `deterministic`), provider, model, prompt key + prompt
  version, `generatedAt`, and `lastAnalysisAt`.

## What shipped

### Data model (additive — one new table, no changes to existing tables)
- `ai_insights` — per-tenant (`company_id`, tenant boundary, cascade delete) store of
  reviewable recommendations, keyed by (`entity_type`, `entity_id`, `insight_type`)
  and **upserted** on re-analysis (no duplicate rows). Carries the full provenance set
  above plus `status` (`suggested` | `accepted` | `dismissed`), `accepted_by_id`
  (set-null FK to users), and `accepted_at`. `data` is a structured, feature-specific
  JSONB payload. Applied via `db push`.

### Insight engines (7 types; 2 deterministic, 5 AI)
- **Deterministic (always run, `source="deterministic"`, no provider):**
  - `missing_info` — data-completeness gaps (missing fields, completeness %).
  - `duplicate_intelligence` — near-duplicate detection (normalized name/email/phone).
- **AI (`source="ai"`, provenance-stamped, per-feature isolated):**
  - `lead_intelligence`, `opportunity_potential`, `smart_classification` (leads).
  - `contact_intelligence`, `smart_classification` (contacts).
  - `company_intelligence` (organizations).
- Each AI feature runs in isolation: a disabled/failing/timeout feature is captured in
  the response's `aiErrors[]` and never blocks the other features or the deterministic
  insights. `relationship_intelligence` is intentionally deferred.

### API (`ai` tag in `openapi.yaml`, Orval-regenerated)
- `GET  /ai/insights/overview` — tenant-wide review summary (status counts + recent).
- `POST /ai/insights/{entityType}/{id}/analyze` — (re)generate all applicable insights.
- `GET  /ai/insights/{entityType}/{id}` — list stored insights for one entity.
- `POST /ai/insights/{id}/accept` — record an audited acceptance (status→accepted).
- `POST /ai/insights/{id}/dismiss` — dismiss a recommendation (audited).

Schemas added: `AiInsight`, `AiInsightsListResponse`, `AiInsightError`,
`AiAnalyzeResponse`, `AiInsightsOverviewResponse`. Generated hooks:
`useGetAiInsightsOverview`, `useAnalyzeAiInsights`, `useGetAiInsights`,
`useAcceptAiInsight`, `useDismissAiInsight`.

Guards are **path-scoped** to `/ai/insights` (avoiding the documented router-level
guard-leak): `requireTenantUser` (AI operates ONLY on a tenant's own CRM — the
platform operator is excluded), `blockReadOnlyMutations` (generate/accept/dismiss
respect the cancelled-company read-only lifecycle), and `auditMutations("ai_insights")`
(every non-GET is an audited action). Per-route permissions: `view` (overview + list),
`generate` (analyze), `accept` (accept + dismiss). Cross-tenant access returns **404**
(not 403), matching the existing existence-hiding convention.

### Web (`artifacts/web-app`)
- `components/AiInsightsPanel.tsx` — analyze/re-analyze, accept/dismiss, source badge
  (AI / Rule-based), confidence tones, generic data renderer, and a provenance footer
  (model, prompt version, analyzed-at).
- Integrated into `LeadDetail` (sidebar), `ContactDetail`, and `CompanyDetail`
  (`entityType="organization"`).
- `pages/admin/AiInsightsReview.tsx` — tenant-wide review overview; route
  `/admin/ai-insights` + "AI Insights" nav entry in `AdminLayout`.

### Mobile (`artifacts/mobile`, EN + AR parity)
- `components/AiInsightsSection.tsx` — self-contained section using
  `useColors`/`useLocale`/`FONT`/Feather (SVG icons), a generic renderer, and
  `Alert.alert` + `Haptics` feedback (no toast on mobile). Relies on the global
  `MutationCache.onSuccess` invalidation (no per-call invalidation added).
- Integrated into `app/pipeline/[id].tsx` (lead) and `app/contact/[id].tsx` (contact).
- Added an `aiInsights` i18n block to `en.json` and `ar.json` (full RTL parity).

## Tests
- New `test/ai-insights.test.ts` (13 tests): analyze (deterministic + AI, `aiErrors[]`
  present), unknown-entityType 400, non-existent 404, near-duplicate detection, list,
  re-analyze upsert (no duplicate rows), audited accept (status + `acceptedById` +
  `acceptedAt`), dismiss (status + `acceptedById` cleared), cross-tenant accept 404,
  overview (tenant-scoped), cross-tenant analyze/list 404, and employee
  deny-by-default write RBAC (403 on generate). Assertions focus on the deterministic
  engines so the suite is not flaky when the LLM is slow/unconfigured. All fixtures use
  throwaway tenants torn down in `afterAll`.
- Backend independently verified via live smoke test during development (analyze
  produced 5 insights, audited accept, overview, cross-tenant 404 — all pass).

## Deviations from plan
- `relationship_intelligence` was **deferred** (documented as a future insight type),
  keeping Stage 5A focused on per-entity intelligence.
- Insight engines live in `artifacts/api-server/src/services/ai-insights.service.ts` +
  `repositories/ai_insights.repository.ts` (server-only), consistent with the Stage 5.0
  decision to keep AI code in the api-server until a second consumer exists.

## Operational notes
- Run `pnpm --filter @workspace/api-spec run codegen` after any `openapi.yaml` edit and
  `pnpm --filter @workspace/db run push` after schema edits (both done).
- Gate procedure unchanged: restart the `artifacts/api-server: API Server` workflow (and
  truncate `login_attempts` if stale) before running the full suite **once**. The Stage 5A
  gate run was green at 23 files / 383 tests.
