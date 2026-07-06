# AI & Workflow Architecture

Internals and the shared safety contract for every AI-backed surface
(Stage 5A insights, 5B copilot, 5E capture intelligence, 5F workflow). The
governing principle across all of them: **recommend/draft from real CRM data
only, never auto-execute or write the source CRM**, and carry honest provenance.

**See also:** [Product](product.md) for the user-facing feature descriptions,
[Architecture Decisions](architecture-decisions.md) for the RBAC/tenant model
these features build on, and [Gotchas](gotchas.md) for operational AI notes.

## Shared AI contract

- AI features (Stage 5A insights, 5B copilot, 5F workflow) share one contract: recommend/draft from real CRM data only, NEVER auto-execute/write the source CRM; persist reviewable rows with full provenance (source ai|deterministic; provider/model/promptKey/promptVersion null for deterministic); deterministic grounded cores (conf 100) with best-effort AI phrasing that soft-degrades to 200 (never 500). Each has its own RBAC module (`ai_insights`/`ai_copilot`/`ai_workflow`) with a startup permission backfill so shipping the gated module never locks out pre-existing users. Computed-only surfaces (analytics, workflow health/sla-risks/bottlenecks/simulate) are served via the analytics micro-cache, not persisted.

## AI Engine

- **AI Engine** (`src/lib/ai.ts`): `extractCardData` (OCR + bilingual + per-field confidence/provenance via `callJsonWithMeta`), `scoreLead` (score/temperature/reasoning), `enrichContact` (industry/seniority/summary/talking points), plus the Copilot generators (compose email/whatsapp, call/meeting prep, proposal, summary, followup/coaching phrasing) and the Workflow phrasing runners (next-action/routing/progression/reminder/task). Dedup detection + merge live in `routes/contacts.ts`.

## AI safety & operational notes

- AI (Gemini) calls in `src/lib/ai.ts` are timeout-bounded (`withTimeout`); `/scans` 502s on OCR failure, contact creation degrades to null lead score on AI failure
- **Capture analyze is READ-ONLY intelligence**: `POST /scans/analyze` (+ batch) recognizes existing contacts/orgs and warns about duplicates but NEVER links, merges, or writes — it is advisory. AI industry suggestions soft-degrade (`aiDegraded`) and carry provenance; deterministic suggestions must never masquerade as AI. Both `/scans/analyze` and `/scans/batch` static paths MUST be registered before `/scans/:id`.
- **Workflow intelligence recommends, never executes** (Stage 5F): `/ai/workflow` analyze/health/sla-risks/bottlenecks/simulate are advisory — a recommendation NEVER auto-assigns/routes/changes-stage/sends/writes the CRM, and `accept` only records approval (status + acceptedById), it does NOT mutate the source record (any resulting write goes through the existing manual CRM endpoints). Deterministic cores (conf 100) must NEVER carry AI provenance; AI phrasing soft-degrades to 200. Both the analyze POST AND the list GET must verify entity access first (404 for foreign/nonexistent) — a tenant-scoped list alone returns an empty 200 and leaks nothing but breaks the 404 contract. Static `/ai/workflow/{overview,health,sla-risks,bottlenecks,simulate,batch,recommendations/:id/*}` paths MUST be registered before `/:entityType/:id`.
