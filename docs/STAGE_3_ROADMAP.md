# Card Scanner Pro — Stage 3 Master Roadmap & Execution Plan

> Master implementation plan for the remainder of Stage 3.
> Product alias note: referred to elsewhere as "Lead Capture Pro" — same platform.

## Status snapshot

**Done & approved:** Stage 1 (Foundation), Stage 2 (Enterprise Architecture), Stage 2.11 (Privacy & Data Governance), **Stage 3 Phase 1 (Organizational Foundation)**.

**Architecture already in place** (do NOT rebuild): enterprise auth + MFA + RBAC, multi-tenancy (`company_id` tenant boundary), enterprise privacy, repository + service layers, background jobs, notifications, monitoring/observability, API versioning, org structure (departments, teams, employee directory, org hierarchy).

**Mandate for the rest of Stage 3:** ship *product capabilities*, not architectural refactors. Every phase is additive, contract-first, backward-compatible, multi-tenant-isolated, and regression-free.

---

## Guiding principles (apply to EVERY phase)

- **No regressions / backward compatible.** Additive schema + additive endpoints. Never break an existing API shape — version a new one if the contract must change.
- **Contract-first.** OpenAPI spec → codegen (Orval hooks + Zod) → server validates with the generated schemas. Always run `pnpm --filter @workspace/api-spec run codegen` after spec edits.
- **Tenant isolation preserved.** `tenantScope` on every read; cross-tenant access returns 404; FK writes validated with `refAccessible` (caller-scoped) or `refInCompany` (target-tenant-scoped) as appropriate.
- **Permissions preserved.** New modules registered in the permission catalog; `platform_owner`/`primary_admin` bypass, `admin`/`employee` gated; no role/privilege escalation.
- **Auth & privacy preserved.** No changes to JWT/MFA/session model or the privacy/governance controls except additive ones.
- **Pre-merge gate every phase:** full `typecheck` + full `test` suite green (restart api-server first), then architect code review, then a phase completion report → **WAIT for approval**.
- **Web + mobile stay in sync.** Both consume the same generated client; plan mobile work per phase explicitly.

---

## Roadmap at a glance

| Phase | Name | Core value | Complexity | Est. time | Agent mode |
|---|---|---|---|---|---|
| 2 | Executive Dashboards & Analytics | See performance at every org level | Medium | 1–1.5 wk | Power |
| 3 | Advanced CRM & Lead Lifecycle | Own, track, and progress every lead | High | 2–3 wk | Power |
| 4 | Workflow Automation | Route, remind, escalate, approve automatically | High | 2–3 wk | Power |
| 5 | AI Intelligence | Score, summarize, enrich, advise | Medium–High | 1.5–2.5 wk | Power |
| 6 | Reports & Business Intelligence | Export and schedule decision-grade reports | Medium | 1.5–2 wk | Economy → Power for export engine |
| 7 | Customer Experience & White Label | Per-tenant branding, domains, languages | Medium | 1.5–2 wk | Economy |
| 8A | Integrations: Productivity & Calendar/Email | Sync calendars, email, M365/Workspace | High | 1.5–2.5 wk | Power |
| 8B | Integrations: CRM | Two-way sync with HubSpot/Salesforce/Zoho | High | 2–3 wk | Power |
| 8C | Developer Platform | Public REST API, keys, webhooks, Zapier | High | 2–3 wk | Power |
| 9 | Enterprise Administration | Billing, licensing, security/audit center, SSO | High | 2.5–4 wk | Power |

> Agent-mode guidance: **Power** for high-ambiguity, cross-cutting, security-sensitive, or multi-surface work; **Economy** for well-patterned, mostly-additive UI/CRUD; **Lite** for isolated copy/config tweaks (none of the phases below are Lite-scale on their own).

---

## Phase 2 — Executive Dashboards & Analytics

- **Objective:** Give every org level (company → department → team → employee) a real-time performance view built on existing data (leads, contacts, scans, events, activity logs) and the Phase 1 org structure.
- **Business value:** Turns raw activity into decisions; gives leaders an at-a-glance pulse and makes the org structure immediately useful.
- **Features:** Company / Department / Team / Employee dashboards; KPI widgets (scans, new leads, conversion, pipeline value, follow-up adherence); charts (trends over time, funnel, source mix); activity feeds; executive summary cards; date-range + org-scope filters.
- **Modules affected:** reports/analytics, users (org scope), contacts, leads, events, scans, audit/activity.
- **Mobile impact:** Mobile dashboard home with a condensed KPI set + my-team/my-numbers view; reuse the same analytics endpoints.
- **Admin dashboard impact:** New `/admin/dashboard` (role/scope-aware) + drill-down dashboards per department/team/employee.
- **Backend impact:** New read-only analytics service + aggregation queries; extend the existing analytics micro-cache (global write-epoch invalidation, key includes scope + userId).
- **Database impact:** None required (read aggregations). Optional: roll-up/materialized snapshot tables only if query latency demands — defer unless proven.
- **API impact:** New `GET` analytics endpoints (e.g. `/analytics/overview`, `/analytics/department/:id`, `/analytics/team/:id`, `/analytics/employee/:id`), all tenant + org scoped, `view`-gated.
- **Dependencies:** Phase 1 (org scope) — **required**. Foundation for Phases 3/5/6.
- **Risks:** Cross-tenant/cross-scope data leakage in aggregates; cross-currency totals (convert each lead to display currency BEFORE summing); cache staleness. All have established patterns to follow.
- **Testing:** Aggregation correctness fixtures; scope-isolation tests (employee sees only own, team lead sees team, etc.); cache-invalidation tests; cross-currency total test.
- **Complexity:** Medium. **Time:** 1–1.5 weeks. **Mode:** Power (scope-correctness + cross-currency sensitivity).

---

## Phase 3 — Advanced CRM & Lead Lifecycle

- **Objective:** Evolve leads from records into a managed lifecycle with ownership, stages, and a full activity history.
- **Business value:** Core sales value — nothing falls through the cracks; managers see who owns what and where every deal stands.
- **Features:** Configurable lead pipeline + Kanban; opportunity/deal fields (value, expected close); lead & team ownership/assignment; activities + chronological timeline; internal notes; file attachments; tags; lead status automation hooks (manual now, automated in Phase 4).
  - **Customer Timeline** — a complete, unified interaction history per contact/lead: business card + OCR results, meetings, notes, calls, emails, tasks, follow-ups, status changes, and full activity history, in one chronological feed. Full tenant isolation + permissions.
  - **Document Management** — store and manage business documents per contact/lead/company: quotations, contracts, purchase orders, invoices, plus PDFs, images, and other attachments. Tenant-isolated storage with typed categories and permission-gated access.
- **Modules affected:** leads (major), contacts, users (ownership), events, object-storage (attachments + documents), audit.
- **Mobile impact:** Mobile pipeline/Kanban, my-leads, log-activity, add-note, view customer timeline; document upload/view; attachment upload from camera/files.
- **Admin dashboard impact:** Upgraded `/admin/leads` (pipeline + Kanban + detail with timeline/notes/attachments/tags); unified Customer Timeline view; Document Management UI; ownership reassignment UI.
- **Backend impact:** Extend leads service/repo; new activities, notes, attachments, tags, timeline-aggregation, and documents services; ownership-transfer logic; document + attachment storage via existing object-storage.
- **Database impact:** New tables — `lead_activities`, `lead_notes`, `lead_attachments`, `tags` + `lead_tags`, pipeline `stages` (per-tenant configurable), `documents` (typed: quotation/contract/PO/invoice/other, polymorphic owner); add `ownerId`/`teamId`/`stageId`/opportunity fields to `leads` (additive, nullable). Customer Timeline is a read aggregation over existing + new activity sources (no dedicated table required unless latency demands).
- **API impact:** New endpoints for stages, activities, notes, attachments, tags, documents, customer-timeline (aggregated read), ownership transfer; extend lead read/write. Static sub-paths registered before `/:id`.
- **Dependencies:** Phase 1 (ownership target = users/teams); Phase 2 (dashboards consume new lifecycle data). **Blocks Phase 4** (automation acts on this lifecycle).
- **Risks:** FK orphaning on reassignment/merge (reassign inside a transaction); attachment storage limits + tenant scoping of files; pipeline-stage config drift; permission gating on ownership transfer (no escalation).
- **Testing:** Lifecycle transitions; ownership-transfer permission + tenant isolation; attachment scoping; merge/reassign FK integrity; Kanban move persistence.
- **Complexity:** High. **Time:** 2–3 weeks. **Mode:** Power.

---

## Phase 4 — Workflow Automation

- **Objective:** Automate the manual lifecycle work — routing, reminders, SLAs, approvals, escalations.
- **Business value:** Enforces process at scale; faster response, fewer missed follow-ups, manager oversight without micromanagement.
- **Features:** Lead routing + assignment rules; SLA rules + breach tracking; approval workflows; reminder rules; escalations; automated task creation; email automation; notification rules; event-based triggers (rule engine over lifecycle events).
  - **Visual Workflow Builder** — a rule/workflow model expressive enough to power a future drag-and-drop designer, e.g. `IF Lead Created → Assign Sales Team → Create Follow-up → Notify Manager → Send Email → Schedule Reminder`. Phase 4 ships the engine + data model (triggers, conditions, ordered actions) and a form-based builder; the architecture is designed so a drag-and-drop canvas can be layered on later without schema changes.
- **Modules affected:** leads, users/teams (routing targets), notifications, background-jobs (scheduling/retries), audit.
- **Mobile impact:** Receive assignments/reminders/escalations as push + in-app; approve/reject from mobile; my-tasks view.
- **Admin dashboard impact:** Rule builder UI (`/admin/automation`): routing, SLA, reminders, approvals; rule run history/log.
- **Backend impact:** Rule-evaluation engine triggered on lifecycle events; scheduled evaluation via existing background-jobs queue; email via existing notification transport (worker skips when email unconfigured, throws on transport error).
- **Database impact:** New `automation_rules`, `rule_runs`/`rule_logs`, `tasks`, `approvals`, `sla_policies` tables (per-tenant).
- **API impact:** CRUD for rules/policies; tasks + approvals endpoints; trigger/test-rule endpoint.
- **Dependencies:** Phase 3 (acts on lead lifecycle/ownership) — **required**. Uses Phase-1 org for routing targets.
- **Risks:** Infinite/cascading triggers (guard with depth/idempotency); job-queue dead-letter floods (retry policy already established); time-zone correctness for SLAs/reminders (date-only + local-string rules); over-notification.
- **Testing:** Rule-evaluation unit tests; routing correctness + tenant isolation; SLA timer/breach; approval state machine; trigger-loop guard; job retry/dead-letter behavior.
- **Complexity:** High. **Time:** 2–3 weeks. **Mode:** Power.

---

## Phase 5 — AI Intelligence

- **Objective:** Layer AI assistance across the platform on top of the existing Gemini AI engine (`src/lib/ai.ts`).
- **Business value:** Differentiator — faster qualification, cleaner data, proactive guidance; less manual analysis.
- **Features:** AI lead scoring (extend existing), AI company insights, AI duplicate detection (extend existing dedup), AI meeting/notes summary, AI follow-up suggestions, AI sales coach, AI dashboard insights, AI report generator, AI data enrichment (extend existing `enrichContact`).
  - **AI Chat Assistant** — a natural-language assistant over the user's own data, e.g. "Show me today's leads", "Find all contacts from Company X", "Which sales employee generated the highest conversion?", "Summarize today's exhibition", "Which leads require follow-up today?", "Generate an executive summary", "Find duplicate companies", "Show inactive leads". The assistant ALWAYS executes within the caller's RBAC, tenant isolation, and Enterprise Privacy boundaries — it can only see/return what that user is already authorized to access (queries run through the same scoped services, never raw cross-tenant access).
- **Modules affected:** AI engine, leads, contacts, analytics/reports, notifications.
- **Mobile impact:** Show AI scores/insights/suggestions inline; AI summary after a scan; "next best action" prompts.
- **Admin dashboard impact:** AI insight panels on dashboards/lead detail; AI report generator UI; coach suggestions.
- **Backend impact:** Extend AI service with new prompt flows, all timeout-bounded (`withTimeout`) and degrading gracefully on failure (never block a save on AI); deferred/async scoring via background jobs where heavy.
- **Database impact:** Additive — `ai_insights`/`ai_suggestions` cache tables or columns (e.g. `aiSummary`, `aiScore` already partly present); store provenance + generated-at.
- **API impact:** New `GET`/`POST` AI endpoints (insights, summarize, suggest, generate-report); idempotent + cached.
- **Dependencies:** Phase 2 (dashboard insights) + Phase 3 (lifecycle data to reason over). Can partly overlap Phase 6.
- **Risks:** AI latency/cost (cache + async + budget controls, `thinkingBudget:0` where used); hallucinated/fabricated data (honor the "no fabricated data" preference — clearly label AI output, derive from real records); failure handling (502 only where appropriate, else degrade to null).
- **Testing:** AI service unit tests with mocked provider; timeout/degradation paths; cache correctness; "no fabricated data" guards; tenant scoping of cached insights.
- **Complexity:** Medium–High. **Time:** 1.5–2.5 weeks. **Mode:** Power.

---

## Phase 6 — Reports & Business Intelligence

- **Objective:** Turn analytics into shareable, exportable, schedulable reports.
- **Business value:** Decision-grade outputs for execs/clients; recurring delivery without manual work.
- **Features:** Executive / department / team / employee / event / ROI reports; custom report builder; scheduled reports; Excel + PDF export.
- **Modules affected:** reports/analytics, background-jobs (scheduling), notifications (delivery), object-storage (generated files).
- **Mobile impact:** View + share reports; trigger export; receive scheduled-report links. (Builder stays web-first.)
- **Admin dashboard impact:** `/admin/reports` — report library, custom builder, schedule manager, export buttons.
- **Backend impact:** Report-definition service; export engine (Excel/PDF generation); scheduled generation via background jobs; store outputs in object-storage with tenant-scoped access.
- **Database impact:** New `report_definitions`, `report_schedules`, `report_runs` tables.
- **API impact:** Report CRUD, run/export, schedule CRUD, download (signed/tenant-scoped).
- **Dependencies:** Phase 2 (analytics foundation) — **required**. Phase 5 optional (AI report generator).
- **Risks:** Heavy export jobs blocking the queue (run async, size-bounded); permission gating on reports (platform_owner blocked from tenant CRM data, primary_admin bypass, admin default-on, employee opt-in — established policy); file access scoping.
- **Testing:** Report aggregation correctness; export format validity (open generated Excel/PDF); schedule firing; permission policy; tenant file isolation.
- **Complexity:** Medium. **Time:** 1.5–2 weeks. **Mode:** Economy, escalate to Power for the export engine.

---

## Phase 7 — Customer Experience & White Label

- **Objective:** Let each tenant brand the product and operate in their language/region.
- **Business value:** Enterprise/reseller readiness; higher perceived value; broader market reach.
- **Features:** Company branding (logo/colors), custom domain, themes, email branding, login branding ("Continue with <Company>"), customer/company settings & preferences, localization, multi-language support.
- **Modules affected:** companies/settings, auth (login branding), notifications (email branding), web + mobile theming, i18n.
- **Mobile impact:** Apply tenant theme/logo; localization parity (existing EN/AR i18n + RTL pattern extends here); locale-aware formatting.
- **Admin dashboard impact:** `/admin/settings/branding` + preferences/localization screens; live theme preview.
- **Backend impact:** Serve per-tenant branding config; custom-domain routing/verification; localized email templates.
- **Database impact:** Additive `company_branding`/`company_settings` (theme, locale, domain, flags) + `custom_domains`.
- **API impact:** Branding/settings CRUD; public branding lookup (for login page) by domain/slug; domain verification endpoints.
- **Dependencies:** Independent of Phases 3–6 — **can run in parallel** with Phase 5/6. Builds on existing companies + i18n.
- **Risks:** Custom-domain TLS/verification complexity (treat domains as later sub-step if needed); branding leakage across tenants on shared login; localization coverage gaps (maintain locale parity, JS-driven RTL with no reload).
- **Testing:** Branding isolation per tenant; login-page branding by domain; locale parity + RTL; email-template rendering; settings persistence.
- **Complexity:** Medium. **Time:** 1.5–2 weeks. **Mode:** Economy (Power if custom-domain TLS automation is in scope).

---

## Phase 8 — Integrations & Open Platform (split into 8A / 8B / 8C)

Phase 8 is split into three **independent** implementation phases that share one integration framework (OAuth connection management, sync engine on the background-jobs queue, field mapping, sync logs). Build the shared framework once (within 8A), then 8B and 8C layer on top and can proceed in any order / in parallel.

**Shared foundations (built in 8A, reused by 8B/8C):** `integration_connections`, `sync_state` tables; OAuth connection management (use Replit integrations/connectors where available — check first, never hardcode keys); sync engine via background jobs; field-mapping + sync-status/log UI under `/admin/integrations`. Common risks across all three: third-party OAuth/credential security, sync conflicts/duplication (idempotency + dedup), partner API changes. Common testing: per-connector sync with mocked APIs, OAuth flow, idempotent sync, tenant scoping.

### Phase 8A — Productivity & Calendar/Email

- **Objective:** Connect Microsoft 365, Google Workspace, Outlook Calendar, Google Calendar, and email.
- **Business value:** Meetings and follow-ups land in the user's real calendar/inbox; contacts flow both ways.
- **Features:** Microsoft 365, Google Workspace, Outlook Calendar, Google Calendar, Email integration (send/log).
- **Modules affected:** integrations framework (built here), events/contacts (calendar + contact sync), notifications/email, background-jobs, auth (third-party OAuth).
- **Mobile impact:** Show synced calendar events + meeting context; minimal config (setup stays web).
- **Admin dashboard impact:** `/admin/integrations` connect/disconnect + field mapping + sync status for calendar/email.
- **Backend impact:** Build the shared integration framework; calendar + email sync workers.
- **Database impact:** `integration_connections`, `sync_state` (shared), calendar/email sync mappings.
- **API impact:** Integration CRUD, OAuth callbacks, calendar/email sync triggers.
- **Dependencies:** Phase 3 (CRM data to sync) recommended. **Establishes the shared framework** for 8B/8C.
- **Risks:** Calendar/email OAuth scope sprawl; bidirectional sync conflicts; rate limits.
- **Complexity:** High. **Time:** 1.5–2.5 weeks (incl. shared framework). **Mode:** Power.

### Phase 8B — CRM Integrations

- **Objective:** Two-way sync with external CRMs.
- **Business value:** Card Scanner Pro feeds the CRM of record; no double entry.
- **Features:** HubSpot, Salesforce, Zoho CRM, and an extensible adapter for other CRM platforms.
- **Modules affected:** integrations framework (reused), contacts/leads (sync), background-jobs.
- **Mobile impact:** Show CRM sync status on contacts/leads; trigger sync.
- **Admin dashboard impact:** CRM connector config + field mapping + sync logs under `/admin/integrations`.
- **Backend impact:** Per-CRM adapters on the shared sync engine; conflict resolution.
- **Database impact:** Reuses shared tables; per-CRM mapping config.
- **API impact:** CRM connector CRUD, OAuth callbacks, sync triggers.
- **Dependencies:** **8A** (shared framework). Independent of 8C.
- **Risks:** Schema mismatch/field mapping; duplicate creation; per-CRM API quirks + quotas.
- **Complexity:** High. **Time:** 2–3 weeks. **Mode:** Power.

### Phase 8C — Developer Platform

- **Objective:** Open the platform to customers' own developers and automation tools.
- **Business value:** Extensibility, automation, and future marketplace/ecosystem.
- **Features:** Public REST API, API keys, webhooks, Zapier app, foundation for a future marketplace.
- **Modules affected:** new developer-platform module, all data modules (public read/write via API), auth (key auth), background-jobs (webhook dispatch).
- **Mobile impact:** None directly (developer surface).
- **Admin dashboard impact:** `/admin/developer` — API-key management, webhook config, delivery logs.
- **Backend impact:** Public versioned REST API + key auth + rate limiting; signed, retried webhook dispatch; Zapier triggers/actions.
- **Database impact:** `api_keys`, `webhooks`, `webhook_deliveries` (shared with Phase 9 on API keys/security).
- **API impact:** Public versioned REST API, key auth, webhook config endpoints.
- **Dependencies:** **8A** (framework). Overlaps Phase 9 on API-key/security work.
- **Risks:** Public-API abuse/rate-limit, webhook retry storms, key leakage, tenant scoping on public surface.
- **Complexity:** High. **Time:** 2–3 weeks. **Mode:** Power.

---

## Phase 9 — Enterprise Administration

- **Objective:** Complete the platform/tenant administration surface — money, licensing, security, and governance.
- **Business value:** Monetization + enterprise procurement/compliance readiness; self-serve platform operations.
- **Features:** Subscription management (extend existing plans/subscriptions), license/seat management, billing, storage analytics, API keys, security center, audit center (extend existing append-only audit), SSO, SCIM (future-flagged), platform monitoring (extend existing observability).
- **Modules affected:** subscriptions/plans, users (seats/licenses), audit, monitoring, auth (SSO), object-storage (storage analytics), platform portal.
- **Mobile impact:** Minimal — show plan/seat/usage status; SSO login support. Admin actions stay web.
- **Admin/platform impact:** Platform portal: billing, license, security center, audit center, platform monitoring; tenant-side: subscription/usage + API keys + SSO config.
- **Backend impact:** Billing (payment provider — choose Stripe and confirm before building; route via monetization skill); seat enforcement; SSO (extend auth, additive); SCIM stub; storage metering; security/audit aggregation.
- **Database impact:** Additive billing/invoice, license/seat, `sso_config`, `api_keys` (shared w/ Phase 8), usage-metering tables.
- **API impact:** Billing/subscription endpoints, license CRUD, SSO config + callbacks, security/audit query endpoints, usage/storage analytics.
- **Dependencies:** Builds on Stage-2 subscription lifecycle + monitoring + audit; shares API-key/security work with Phase 8. Best **last** (depends on the surface area the other phases create).
- **Risks:** Payment/PCI handling (delegate to provider, never handle card data directly); seat-enforcement regressions to the subscription lifecycle (additive only); SSO security; audit immutability preserved (append-only, no delete).
- **Testing:** Billing flows (provider test mode); seat-limit enforcement; SSO login; audit integrity; usage metering accuracy; subscription-lifecycle regression (existing suite must stay green).
- **Complexity:** High. **Time:** 2.5–4 weeks. **Mode:** Power.

---

## Recommended implementation order & dependency logic

**Sequential backbone (each unlocks the next):**
1. **Phase 2 (Dashboards)** — establishes scoped analytics + cache patterns everything reuses.
2. **Phase 3 (CRM lifecycle)** — the data model (ownership, stages, activities) the rest of the product acts on.
3. **Phase 4 (Automation)** — needs the Phase-3 lifecycle/events to automate.
4. **Phase 5 (AI)** — reasons over Phase-2 metrics + Phase-3 lifecycle data.
5. **Phase 6 (Reports)** — packages Phase-2 analytics (+ optional Phase-5 AI) into exports.

**Parallelizable tracks (independent surfaces):**
- **Phase 7 (White Label)** is largely independent — can run in parallel with Phase 5/6.
- **Phase 8 (Integrations)** is now three phases: **8A** (calendar/email — builds the shared integration framework) must come first; **8B** (CRM) and **8C** (Developer Platform) both depend only on 8A and can run in parallel with each other.
- **Phase 9 (Enterprise Admin)** shares API-key/security work with Phase 8C and is best **last**, since it administers everything the prior phases create.

**Why this order:** value compounds — you get visibility (2) before you manage deals (3), manage before you automate (4), have rich data before AI (5) and before reporting (6); branding/integrations/admin (7–9) wrap the now-complete product for enterprise sale.

**Per-phase loop (unchanged):** build additively + contract-first → restart api-server → full typecheck + test gate green → architect review → completion report → **WAIT for approval** before the next phase.

---

## Status: OFFICIAL MASTER PLAN

This is the **official Stage 3 Master Roadmap** (approved in principle, enhancements incorporated). Implementation has begun with **Phase 2 — Executive Dashboards & Analytics**, following the per-phase loop above (build → validate → full regression → architect review → completion report → **WAIT for approval** before Phase 3).
