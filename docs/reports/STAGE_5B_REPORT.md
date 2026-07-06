# Stage 5B — Enterprise AI Sales Copilot

Status: **COMPLETE**. Full-workspace typecheck clean (api-server, web-app, mobile, libs);
pre-merge gate (`test` + `typecheck`) green.

Builds directly on Stage 5A (Enterprise AI Intelligence). Where 5A produces per-entity
*insights* (what is true about a record), 5B produces reviewable *sales artifacts* (what
to say / do next) — draft emails, WhatsApp messages, call/meeting prep, proposals,
follow-up plans, coaching, and summaries — grounded in the tenant's own CRM data.

## Scope

Delivered a per-entity AI Sales Copilot over a tenant's **own** CRM data (leads,
contacts, organizations, scanned business cards). Every change is **additive** — existing
auth/RBAC, tenant isolation, and API/DB contracts are preserved, and no existing behavior
changes by default.

### Safety contract (non-negotiable, enforced end-to-end)
- **No fabricated data.** Every generator assembles context ONLY from records already
  stored in the tenant. Deterministic cores derive from real fields; LLM generators are
  instructed to work strictly from the supplied CRM context.
- **Never auto-sends, never auto-writes the CRM.** Every output is a DRAFT the user must
  explicitly review and act on. Using a draft is an explicit, **audited** action; so are
  edit and dismiss. The OS handoff (see below) opens the user's own mail/WhatsApp app —
  Copilot itself sends nothing.
- **Soft-degrade, never 500.** The 6 LLM-only output types degrade to HTTP 200 with
  `content.unavailable` when the provider is unavailable. `followup`/`coaching` always
  return a grounded deterministic core (confidence 100) even with no LLM.
- **Full provenance on every output:** `source` (`ai` | `deterministic`), `provider`,
  `model`, `promptKey`, `promptVersion`, `confidence`, `reasoning`, `generatedAt`. A
  deterministic-only row NEVER masquerades as AI (provider/model/promptKey stay null);
  `source` flips to `ai` only when the LLM actually succeeds.

## What shipped

### Data model (additive — one new table, no changes to existing tables)
- `ai_copilot_outputs` — per-tenant (`company_id`, tenant boundary, cascade delete) store
  of reviewable draft outputs, keyed by (`entity_type`, `entity_id`, `output_type`) and
  **upserted** on re-generation (no duplicate rows). Carries the full provenance set above
  plus `status` (`generated` | `edited` | `used` | `dismissed`), `edited_content` (JSONB),
  `used_by_id` (set-null FK to users), and `used_at`. `content` is a structured,
  output-type-specific JSONB payload. Applied via `db push`.

### Output types (8) over entity types (4), gated by an APPLICABLE matrix
- **Deterministic cores (always grounded, best-effort AI phrasing on top):**
  - `followup` — a grounded next-action plan (channel + suggested date + basis) for leads
    and contacts. Deterministic core is always present; when the LLM succeeds it layers a
    phrased `recommendedAction` + `draftMessage` and `source` flips to `ai`.
  - `coaching` — deterministic risk/opportunity signals + summary + recommendations for
    leads and contacts.
- **LLM-only (soft-degrade to 200):** `email`, `whatsapp`, `call_prep`, `meeting_prep`,
  `proposal`, `summary`. Applicability per entity is enforced by the APPLICABLE matrix in
  `ai-copilot.service.ts` (e.g. `followup` is not offered on organizations; `summary` is
  offered on business cards).

### API (all under `/ai/copilot`, `ai_copilot` module: view / generate / use)
- `POST /ai/copilot/{entityType}/{id}/{outputType}` — generate (or re-generate) one output
  (`generate` perm). `outputType` is a **path** segment; the request body is optional and
  carries only `language` / `tone` / `instructions` grounding hints.
- `GET /ai/copilot/{entityType}/{id}/panel` — aggregated panel for one entity (`view`
  perm): available output types, the deterministic suggested action + coaching signals,
  Stage 5A insights for the entity, and stored outputs.
- `GET /ai/copilot/{entityType}/{id}` — list stored outputs for one entity (`view` perm).
- `GET /ai/copilot/overview` — company-wide status counts + recent outputs (`view` perm).
- `PATCH /ai/copilot/outputs/{id}` — store human edits, status → `edited` (`use` perm).
- `POST /ai/copilot/outputs/{id}/use` — record use (does NOT auto-send), status → `used`
  (`use` perm).
- `POST /ai/copilot/outputs/{id}/dismiss` — status → `dismissed` (`use` perm).
- `POST /ai/copilot/batch` + `GET /ai/copilot/batch/{jobId}` — in-process, tenant-scoped
  batch generation over an entity type (202 + poll).

**Routing note:** the 3-segment generate route (`/:entityType/:id/:outputType`) is
registered LAST among copilot POSTs so it cannot swallow `/outputs/:id/use|dismiss`; the
`/:entityType/:id/panel` GET (static 3rd segment) is registered before the 2-segment list
GET. Path-scoped terminating guards mirror `/ai/insights` (tenant-only, read-only-blocked,
platform-owner firewalled, audited).

### Web (`artifacts/web-app`)
- `SalesCopilotPanel` embedded on Contact / Lead / Company detail pages: generate any
  applicable output, review provenance, edit/use/dismiss, and **OS handoff** — Copy,
  "Open in Email" (`mailto:` with no recipient so the OS picks the mail app, honoring the
  "no forced Gmail" preference), and "Send on WhatsApp" (`wa.me` with no number so
  WhatsApp lets the user pick the contact). Only real generated content is handed off.
- `/admin/ai-copilot` review page + batch generation in `BatchOperations`.

### Mobile (`artifacts/mobile`)
- `CopilotSection` on contact / pipeline detail: generate, review, copy (expo-clipboard),
  use/dismiss, with full EN/AR i18n + RTL. Email actions defer to the OS mail app.

## Prompt versions

Each LLM generator carries an explicit `promptKey` + `promptVersion` recorded on every
output row (see `src/lib/ai.ts` copilot generators). Deterministic cores record no
prompt metadata. Provenance is asserted in the test suite (a deterministic row must have
null provider/model/promptKey; an AI row must have a non-empty model).

## Files (primary)

- `lib/api-spec/openapi.yaml` — copilot paths + `AiCopilotOutput`, `AiCopilotGenerateRequest`,
  `AiCopilotPanelResponse`, `AiCopilotEditRequest` schemas (source of truth).
- `lib/db/src/schema/index.ts` — `ai_copilot_outputs` table.
- `artifacts/api-server/src/services/ai-copilot.service.ts` — orchestration, APPLICABLE
  matrix, deterministic cores, `getPanel`, soft-degrade.
- `artifacts/api-server/src/services/ai-copilot-batch.service.ts` — in-process batch queue.
- `artifacts/api-server/src/repositories/ai_copilot_outputs.repository.ts` — tenant-scoped
  persistence (upsert / list / status counts).
- `artifacts/api-server/src/routes/ai.ts` — copilot routes + path-scoped guards.
- `artifacts/api-server/src/lib/ai.ts` — LLM generators.
- `artifacts/web-app/src/components/SalesCopilotPanel.tsx`,
  `artifacts/web-app/src/pages/admin/SalesCopilot.tsx`,
  `artifacts/web-app/src/components/BatchOperations.tsx`.
- `artifacts/mobile/components/CopilotSection.tsx` (+ EN/AR i18n).
- `artifacts/api-server/test/ai-copilot.test.ts` — integration coverage.

## Test results

`artifacts/api-server/test/ai-copilot.test.ts` covers: the APPLICABLE matrix + validation
(unknown entity/output type, not-applicable, 404), deterministic-core provenance
(followup/coaching), LLM-only soft-degrade to 200, re-generate upsert (no duplicates),
listing, the aggregated panel (available types, grounded suggested action, coaching
signals, insights, tenant-scoped outputs; cross-tenant 404; view-gated 403), review
actions (edit/use/dismiss — audited, tenant-scoped), batch generation, RBAC
(employee deny-by-default; positive grant unlocks view/use but NOT generate),
platform-owner tenant firewall, and cancelled/read-only tenant blocking. Full
`pnpm --filter @workspace/api-server run test` gate is green alongside `typecheck`.
