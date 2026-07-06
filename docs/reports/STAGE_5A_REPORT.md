# Stage 5A — Enterprise AI Intelligence

Status: **COMPLETE**. Full-workspace typecheck clean (api-server, web-app, mobile, libs); pre-merge gate green (**23 files / 398 tests**).

Three code-review scope gaps have since been closed: (A) `duplicate_intelligence` now also
covers **scanned business cards** (a new `business_card` entity type over the `scans`
table); (B) `relationship_intelligence` now surfaces the **full deterministic pattern
set** (decision makers / multiple decision makers, repeat interactions across events,
customer status, previously-visited, multi-employee engagement, connected/sibling leads);
(C) batch analysis now runs on the **existing in-process job queue** (`getQueue()` +
`AI_ANALYZE_ENTITY_JOB`), not an ad-hoc mechanism.

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

### Insight engines (8 types; 3 deterministic, 5 AI)
- **Deterministic (always run, `source="deterministic"`, no provider):**
  - `missing_info` — data-completeness gaps (missing fields, completeness %).
  - `duplicate_intelligence` — near-duplicate detection (normalized name/email/phone).
    Covers contacts, leads, organizations, AND **scanned business cards** (the
    `business_card` entity type over `scans`, matched on shared `contactId` / normalized
    email / phone / name+company). Detection only — never auto-merges.
  - `relationship_intelligence` — link + pattern derivation over EXISTING CRM rows
    (`ai-relationships.service.ts`). Beyond the base links (a contact's colleagues +
    linked leads + events; a lead's contact/org/sibling leads + capture event; an
    organization's contacts + leads), it surfaces the full deterministic pattern set:
    **decision makers** (title regex) and **multiple decision makers** at a company,
    **repeat interactions** across events, **customer status** (existing/inactive from
    the record's own status), **previously visited**, and **multi-employee engagement**
    (distinct `assignedToId` counts — count-based, NEVER cross-currency value summing).
    Confidence 100, human reasoning, and an honest "no related records" message when a
    record has no links — pure fact derivation, NO LLM, NO fabricated data.
- **AI (`source="ai"`, provenance-stamped, per-feature isolated):**
  - `lead_intelligence`, `opportunity_potential`, `smart_classification` (leads).
  - `contact_intelligence`, `smart_classification` (contacts).
  - `company_intelligence` (organizations).
- Each AI feature runs in isolation: a disabled/failing/timeout feature is captured in
  the response's `aiErrors[]` and never blocks the other features or the deterministic
  insights.

### Batch processing (`ai-batch.service.ts`)
- `POST /ai/insights/batch` (re)analyzes ALL records of one entity type (lead/contact/
  organization/**business_card**) in the tenant. It enqueues one `AI_ANALYZE_ENTITY_JOB`
  per entity on the **existing shared in-process job queue** (`getQueue()`, registered in
  `lib/jobs/handlers.ts`) with `maxAttempts: 1`; the per-job handler updates the batch
  counters and finalizes without ever throwing, so a failed entity is soft-recorded and
  never dead-letter-storms. The `jobs` map is retained for polling only. Jobs are
  tenant-stamped and only visible to callers who can access the job's company (404 — not
  403 — for another tenant's job). Enumeration uses `tenantScope` (never a raw `companyId`
  scope). Reuses `analyzeEntity`, which collects — never throws on — per-feature AI
  failures, so a batch degrades gracefully. Bounded to 500 entities / 20 retained errors
  / 200 retained jobs. Clients poll
  `GET /ai/insights/batch/{jobId}` for progress; `GET /ai/insights/batch` lists jobs.
  All batch routes are `ai_insights` `generate`/`view` permission-gated.

### API (`ai` tag in `openapi.yaml`, Orval-regenerated)
- `GET  /ai/insights/overview` — tenant-wide review summary (status counts + recent).
- `POST /ai/insights/{entityType}/{id}/analyze` — (re)generate all applicable insights.
- `GET  /ai/insights/{entityType}/{id}` — list stored insights for one entity.
- `POST /ai/insights/{id}/accept` — record an audited acceptance (status→accepted).
- `POST /ai/insights/{id}/dismiss` — dismiss a recommendation (audited).
- `POST /ai/insights/batch` — start a tenant-wide batch (re)analysis of one entity type.
- `GET  /ai/insights/batch` — list batch jobs visible to the caller's tenant.
- `GET  /ai/insights/batch/{jobId}` — poll one batch job's status/progress.
  (Batch routes are registered BEFORE `/{entityType}/{id}` so the param route does not
  swallow the static `/batch` sub-paths.)

Schemas added: `AiInsight`, `AiInsightsListResponse`, `AiInsightError`,
`AiAnalyzeResponse`, `AiInsightsOverviewResponse`, `AiBatchStartRequest`, `AiBatchJob`,
`AiBatchListResponse`. Generated hooks: `useGetAiInsightsOverview`, `useAnalyzeAiInsights`,
`useGetAiInsights`, `useAcceptAiInsight`, `useDismissAiInsight`, `useStartAiInsightsBatch`,
`useListAiInsightsBatches`, `useGetAiInsightsBatch`.

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
- `test/ai-insights.test.ts`: analyze (deterministic + AI, `aiErrors[]` present),
  unknown-entityType 400, non-existent 404, near-duplicate detection, list, re-analyze
  upsert (no duplicate rows), audited accept (status + `acceptedById` + `acceptedAt`),
  dismiss (status + `acceptedById` cleared), cross-tenant accept 404, overview
  (tenant-scoped), cross-tenant analyze/list 404, and employee deny-by-default write
  RBAC (403 on generate). The scope-gap closure added: **business_card duplicate
  intelligence** (seeds two same-email scans via direct DB insert — no AI OCR call —
  asserts a deterministic `duplicate_intelligence` row with only that insight type; plus
  non-existent 404 and cross-tenant 404), **broadened relationship patterns** (two
  decision-maker colleagues at a shared company → `multipleDecisionMakers` +
  `existing_customer` status), and a **business_card batch** run on the shared queue
  (enqueue → poll to `completed`, all scans succeed). Assertions focus on the
  deterministic engines so the suite is not flaky when the LLM is slow/unconfigured.
  All fixtures use throwaway tenants torn down in `afterAll`.
- Backend independently verified via live smoke test during development (analyze
  produced 5 insights, audited accept, overview, cross-tenant 404 — all pass).

## Deviations from plan
- None outstanding. `relationship_intelligence` and batch processing (originally the
  deferred scope gap) are now fully implemented, tested, and shipped: a deterministic
  relationship engine wired into `analyzeEntity` for all three entity types, plus a
  tenant-scoped in-process batch runner with start/list/get endpoints, a web Batch AI
  Operations page (`/admin/ai-batch`), and EN/AR mobile insight labels.
- Insight engines live in `artifacts/api-server/src/services/ai-insights.service.ts` +
  `repositories/ai_insights.repository.ts` (server-only), consistent with the Stage 5.0
  decision to keep AI code in the api-server until a second consumer exists.

## Operational notes
- Run `pnpm --filter @workspace/api-spec run codegen` after any `openapi.yaml` edit and
  `pnpm --filter @workspace/db run push` after schema edits (both done).
- Gate procedure unchanged: restart the `artifacts/api-server: API Server` workflow (and
  truncate `login_attempts` if stale) before running the full suite **once**. The Stage 5A
  gate run was green at 23 files / 398 tests.
