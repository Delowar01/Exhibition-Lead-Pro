# Batch 23 — Final Phase 1–9 Reconciliation: Audit and Release Gate Report

**Scope:** audit only. No product code, schema, contract, generated client, UI, hosted
configuration, secret, container, queue, GCS object or host service was changed. Every
statement below is tied to a commit SHA, a test log produced in this audit, or a GitHub
Actions run id. Where the evidence does not exist, the row says so instead of
reconstructing history.

**Audited tree:** `develop` = `f53c90124597fd6f8ae88ee926c70bce824ac6e9` (B22 Correction 1),
branch `claude/b23-final-reconciliation` created from that commit. `export-ready`
(`283b15e425acf1fad57b750181bb2653d2e811e8`) and `main`
(`19909bea563aa14e1f348a0fb23a7c3d473405e5`) were not touched.

**Status vocabulary (used in every matrix row):**

| Status | Meaning |
|---|---|
| **verified** | code present, local automated tests green in this audit (or the cited prior run), and the surface was exercised on the hosted dev stack by a cited run |
| **implemented, not hosted-verified** | code present and local tests green; no hosted run exercised the surface (deploy-only evidence) |
| **blocked (external)** | cannot be verified without a configuration, credential, commercial decision or owner approval that is deliberately absent |
| **gap / defect** | requirement or deliverable not met, or a regression found by this audit |
| **deliberately excluded** | removed from approved scope by the owner (August 2026); never counted as pending |
| **unable to determine** | no evidence either way in the repository, the logs or the hosted stack |

"Code exists", "local test passed", "hosted smoke passed" and "live provider delivered" are
never equated: the columns keep them apart.

---

## 1. Source of truth and evidence inventory

### 1.1 Refs at the start of the audit (2026-09-18, snapshot before any action)

| Ref | SHA | Role |
|---|---|---|
| `export-ready` | `283b15e425acf1fad57b750181bb2653d2e811e8` | approved baseline (protected, unchanged) |
| `main` | `19909bea563aa14e1f348a0fb23a7c3d473405e5` | historical (protected, unchanged) |
| `develop` | `f53c90124597fd6f8ae88ee926c70bce824ac6e9` | integration branch = hosted dev deploy source |
| `claude/b19-billing-audit` | `6ed74fc63d32cf653eb1c3304651d6680b93cb7c` | B19 audit (protected) |
| `ops/b20-hosted-inspection` | `9375d8c34dc3694881a3617d3e887fd98a89db86` | read-only inspection tooling (protected) |
| `ops/b20-hosted-activation` | `d03ca352a31ed2dceae9c3cc10ed316aad6b8fff` | hosted activation / smoke tooling (= `c2cd467` + ops files only) |
| `claude/b23-final-reconciliation` | created at `f53c901` | this audit (only `docs/B23_FINAL_RECONCILIATION.md` added) |

Worktree was clean before the audit; the Orval codegen was re-run and produced no diff
(contract, `lib/api-zod` and `lib/api-client-react` are in sync with `openapi.yaml`).

### 1.2 Batch history on `develop` (B9 → B22) and the hosted deploy of each head

Every push to `develop` deployed through `.github/workflows/deploy-dev-vps.yml`
(`verify` job: frozen install, lib/API/web/mobile typechecks, mobile unit suite, API and
web production builds; `deploy` job only for `refs/heads/develop`). All 17 runs concluded
`success`.

| Batch | Head commit(s) | Deploy run (SHA) |
|---|---|---|
| B9 Reports & Export Center (+ ZipCrypto option) | `e5192a1`, `599af79` | 32629682652 (`e5192a1`), 32635097743 (`599af79`) |
| B10 Dashboard & Analytics | `e2d0136` | 32637463656 |
| B11 Lead conversion & opportunity closure (+2 corrections) | `71cf58a`, `11d9156`, `3bd52a1` | 32670877095 (`3bd52a1`) |
| B12 CRM lifecycle: tasks, follow-ups, timeline (+correction) | `6428bf2`, `ea50f50` | 32878510718 (`ea50f50`) |
| B13 UX modernization polish (+tablet correction) | `e3395f7`, `b5b6421` | 32886447229 (`b5b6421`) |
| B14 Durable PostgreSQL job queue (+3 corrections) | `7c7ef01`, `5afe2b1`, `81094fe`, `3f31e58` | 33665612640 (`3f31e58`) |
| B15 Workflow definitions (+correction) | `3f55fa3`, `fb4257b` | 33927459696 (`fb4257b`) |
| B16 Workflow engine (+2 corrections) | `1352dd3`, `7c09426`, `2b9fa16` | 34129570132 (`2b9fa16`) |
| B17 Workflow automation UI (+history guard) | `edf61d3`, `9ee7170`, `f22e73e` | 34221308627 (`f22e73e`) |
| B18 Tenant branding (+correction) | `49f0abb`, `c2cd467` | 34270367939 (`c2cd467`) |
| B19 Billing audit (docs only) | `6ed74fc` | not deployed (documentation) |
| B20 Subscription lifecycle & hybrid Stripe (+4 corrections) | `4f42931`, `5276f28`, `11207f1`, `054b207`, `d9e1449` | 34991926623 (`054b207`), 35102723185 (`d9e1449`) |
| B21 Platform Owner admin panel (+correction) | `286a5bb`, `ff7b851` | 35160423889 (`ff7b851`) |
| B22 Production & provider verification; Correction 1 | (verification) ; `f53c901` | 35372680640 (`f53c901`) |

Earlier `develop` commits (`6711f77`, `14e1f90`, `05d104a`, `bc7af6a`, `b68014d`,
`62276aa`, `8b5cf5d`) are the hosted-infrastructure/portal-host work between the
baseline and B9 (deploy runs 32312741644, 32315935016).

**B1–B8:** no per-batch record exists in the repository. The pre-`export-ready` history
(50 commits) is labelled by Stage (1, 2, 2.11, 3 P1–P3, 4, 5.0/5A–5F, 5.9 P1–P5) and by
"export-readiness closure"; the only Batch 1–8 statement is
`docs/PROJECT_TECHNICAL_BRIEF.md` §B ("Batch 8 is complete and device-verified … Honor
Magic V5, Android 16"). Their per-batch provenance is therefore **unable to determine**;
the product state they produced is audited as a whole through the Phase matrix (§2.1).

### 1.3 Hosted activation and verification runs (ops workflows, all read from the run logs)

| Purpose | Run id(s) | Outcome relevant to this audit |
|---|---|---|
| B14 durable queue activation on the VPS | 33679875122 (attempt 2, branch `ops/b14-hosted-activation` @ `372fe0a`, now deleted) | at `3f31e58`: backup `leadcapture-20260902-203757.sql.gz` (20,430 B) taken first; `job_queue` created (17 columns, 5 indexes, 64→65 tables, no other schema change); `JOBS_DRIVER=postgres` appended; `JOBS_PAYLOAD_ENCRYPTION_KEY` generated on the VPS (64 hex chars, never printed); api recreated (same image), postgres/web untouched; readyz `ok/ok/ok`; first recurring job completed with `gcm1.` payload prefix; dead-letter 0 |
| B15 schema push | 33927866904 | success |
| B16 engine smoke | 34130988114 (run #6; runs 1–5 mixed) | success |
| B17 UI smoke | 34222496274 (#4) | success |
| B18 branding apply + smoke | 34269702351 (apply), 34273450491 (smoke) | success; real GCS logo upload / serve / delete |
| B20 read-only inspection | 34360691499 | success (documented in `docs/B20_SUBSCRIPTION_LIFECYCLE.md` §12) |
| B20 migrate / verify / smoke / supplemental / C4 | 34991816033, 34992362689, 35018329822, 35018387153, 35029273566, 35104508283 | success |
| B21 hosted smoke (real Chromium, disposable tenants) | 35161724372 (57/57; earlier 35160925940 had 4 script-assertion failures, not product failures) | success |
| B22 production & provider verification | 35164851677 (52 passed / 0 failed / 1 finding / 2 notes); 35164416025 failed on a weak-ETag script bug; 35164846043 removed the one orphaned logo object | real GCS document upload/download/access-control/delete, logo lifecycle, Gemini routing without a billable call, SMTP queue behaviour ("skipped", never "sent"), runtime/infra checks |
| Loopback 5432 listener identification | 35216127620 | host `postgresql@16-main` (Ubuntu package, user `postgres`), not part of the stack |
| B22 C1 preflight / smoke | 35372411446, 35372414272, 35373129629 (18/18, one guarded probe → 503 `AI_NOT_CONFIGURED`) | success |
| **B23 read-only snapshot (this audit)** | **35375653337** (`c4-verify f53c901 / ff7b851`), **35375655857** (`b22-infra`) | see §1.4 |

### 1.4 Hosted dev state on 2026-09-18 17:40 UTC (runs 35375653337 / 35375655857, `default_transaction_read_only=on`)

| Item | Observed |
|---|---|
| Checkout / deploy pointers | HEAD `f53c901` (committed 2026-09-17T11:40:08Z), `current-deploy.sha` `f53c901`, `previous-deploy.sha` `ff7b851`, dirty entries 0, worktrees 1 |
| Schema | fingerprint `ce55dfa2959cc89c2baad2923217842a` (unchanged since B20 C1); tables 72, indexes 241, constraints 257; plans 5, subscriptions 1, companies 1, active users 2 |
| Containers / volume | postgres `postgres:16-alpine` created 2026-08-18 healthy (never recreated); api created 2026-09-18T17:13 healthy; web created 2026-09-16 healthy; volume `card-scanner-pro_pgdata` 2026-08-18 |
| Health | `readyz {"status":"ok","checks":{"database":"ok","storage":"ok"}}`, `healthz ok` (through the loopback gateway) |
| Published ports | only web `127.0.0.1:18080`; api/postgres not published; host listeners 80/443/8443 (CloudPanel) and `127.0.0.1:5432` / `[::1]:5432` (host PostgreSQL, not this stack) |
| Env file | mode 600, 889 B, sha256 prefix `8bc9ef9a2f8554bf` (unchanged since B14 activation); `JOBS_DRIVER=postgres`, `JOBS_PAYLOAD_ENCRYPTION_KEY` set, `OBJECT_STORAGE_AUTH=google`, GCS credential mounted `:ro` and readable by the api uid; `GEMINI_API_KEY` **set-but-empty**, `AI_INTEGRATIONS_GEMINI_API_KEY` unset; `SMTP_*` unset; `BILLING_PROVIDER` / Stripe keys unset; `TRUST_PROXY=2`; `NODE_ENV=production` inside the api container |
| Durable queue | 3,385 rows, all `completed`, all `gcm1.` four-part encrypted envelopes (0 plaintext), dead-letter 0 (24 h and 7 d); recurring jobs last 6 h: aiUsageAlerts 6, exportSchedules 23, followUpReminders 6, maintenance 1, subscriptionSweep 23, workflowAlerts 1, workflowRecovery 72 — all completed |
| Logs since api start | 2 error-level lines (0 non-AppError); one WARN "AI request refused: provider is not configured" (the B22 C1 probe); web nginx: 1 upstream-refused line during the api recreate at deploy time |
| Data hygiene | disposable rows in every smoke-touched table = 0; company 1 baseline md5 `2892909a8288bdb6ee2783fa3f7fc269` (unchanged since B20) |

### 1.5 Documents of record and where they disagree with the code (code is authoritative)

| Document | Stale or contradictory statement | Evidence |
|---|---|---|
| `docs/PROJECT_TECHNICAL_BRIEF.md` §B, §C, §E, §M | "Batch 8 is complete … **Batch 9 has not been started**", baseline "705/705, 43/43, 107/107", "Background jobs: in-process queue (`JOBS_DRIVER=in-process`)", staging = the Replit publish URL | `develop` carries B9–B22; hosted dev runs `JOBS_DRIVER=postgres` (§1.4); the deploy target is the Hostinger VPS. §K of the same file already says "Current totals (Batch 20) 1153" and §J documents B22 C1 — the file is internally inconsistent |
| `CLAUDE.md` | "Batches 1–8 are complete … Next approved batch: Batch 9" | B9–B22 are merged and deployed |
| `docs/HOSTINGER_VPS_DEPLOYMENT.md` §3, §8 and the workflow step name "Mobile unit tests (107 expected)" | 107 mobile / 728 API / 43 Playwright | mobile is 114/114 (this audit); API 1268 tests; Playwright 142 specs |
| `docs/PROJECT_FILE_MAP.md` row "AI workflow intelligence" | `artifacts/mobile/components/WorkflowSection.tsx` "(excluded from mobile scope)" | the component is rendered on `app/pipeline/[id].tsx:701` and `app/company/[id].tsx:200` (see gap G-4) |
| `replit.md` | API "port 5000 → proxied at /api"; Stage 5.9 "current highest priority" | local workflow is :8080 behind the :80 gateway; Stage 5.9 is complete |
| `lead-capture-pro-master-phase-1-9-roadmap-audit.md` (2026-08-04) | pending: workflow engine, durable queue, tenant admin, billing, branding, Copilot page actions, AI rate limiting … | superseded by B14–B21 (§2); treated as stale scope history, not as status |
| `docs/reports/PRODUCTION_RELEASE_CHECKLIST.md` (2026-06-22) | "hardcoded JWT-secret fallback", "writes validated by manual destructuring" | `config.ts:156` requires `SESSION_SECRET`; routes validate with generated Zod (`validateBody`, e.g. contacts ×8, leads ×14, users ×4) — both items are closed |

---

## 2. Traceability matrix

### 2.1 Phase 1–9 requirements (source: `docs/STAGE_3_ROADMAP.md`; owner removals in `replit.md` / roadmap notes; Phase 5 detail in `docs/STAGE_5_AI_ROADMAP.md`)

Test counts are per suite as counted in this audit (`it(`/`test(` occurrences); "this run" = the single full runs recorded in §3.

| # | Phase / requirement | Delivered by | Implementation (route → service → schema → UI) | Local test evidence | Hosted-dev evidence | Status | Remaining action |
|---|---|---|---|---|---|---|---|
| 1.1 | P1 Auth: login, refresh rotation + family revocation, logout, MFA/TOTP + backup codes, trusted devices, server-side sessions | Stage 1–2 (pre-B1); B20 C4 (`d9e1449`) effective permissions | `routes/auth.ts`, `services/auth.service.ts`, `lib/sessions.ts`, `lib/mfa.ts`, `lib/effective-permissions.ts`; `sessions`, `login_attempts`, `mfa_backup_codes`, `trusted_devices` | `auth-security` 7, `session-security` 6, `mfa-closure` 9, `b20c4-effective-permissions` 9 (green); e2e `h-auth-email` 6, `i-security` 3, `n-newtab-auth` 5, `m-role-routing` 5 | real form logins in every hosted smoke (35018387153, 35161724372, 35164851677, 35373129629) | **verified** | none (MFA browser flow is covered by `i-security.spec.ts`; the 2026-06 harness gap is closed) |
| 1.2 | P1 Tenant isolation (`company_id` boundary, cross-tenant 404, FK `refAccessible`/`refInCompany`) | Stage 2 + B12 C1 (`ea50f50`) | `middlewares/requireAuth.ts` `tenantScope`, `lib/tenant.ts` | `tenant-isolation-matrix` 13, `privacy-platform-owner` 3, `repositories-softdelete` 7, `role-firewall` 4 (the last two **skipped in this run** — beforeAll login hit the limiter, §3.1; green in the prior full run of 2026-09-16, 1234 tests) | B21/B22 smokes prove cross-tenant 404 and owner 403 on disposable tenants (35161724372, 35164851677) | **verified** | re-run `role-firewall` / `repositories-softdelete` in the next green gate |
| 1.3 | P1 Platform Owner firewall (`requireTenantUser`, path-scoped) | Stage 2; B20 (`4f42931`) added `/subscriptions` | 30 path-scoped mounts in `routes/*.ts` (incl. `/subscriptions`, `/exports`, `/workflows`, `/ai/*`, `/documents`, `/scans`) | `privacy-platform-owner` 3, `b21-platform-admin` 19, `b20-subscriptions` 26 | B21 smoke 35161724372 (owner 403 on CRM), B22 smoke | **verified** | none |
| 1.4 | P1 RBAC: 4-tier roles, write matrix (deny-by-default), custom roles, no escalation | Stage 2; B20 C4 | `lib/rbac.ts`, `routes/rbac.ts`, `roles`/`role_permissions`/`user_roles` | `b20c4` 9, `org-foundation`, `import-perms` 8; e2e `y-rbac-permissions` 4 | B20 C4 smoke 35104508283 (role-only viewer, revocation) | **verified** | none |
| 1.5 | P1 Org structure: departments, teams, directory, hierarchy, territories, round-robin | Stage 3 P1 | `routes/departments|teams|territories|org|organizations.ts`, `assignment_cursors` | `org-foundation`, `assignment-roundrobin`, `crm-organizations` | deploy only | **implemented, not hosted-verified** | include in a hosted smoke when one is next scheduled |
| 1.6 | P1 Invitations + password reset (tokenized, honest `emailStatus`) | Stage 2; B14 C2 (`81094fe`) sanitized failure metadata | `routes/invitations.ts`, `auth.ts`; `invitations`, `verification_tokens`; queue job `email.send` | `invitations-email` 12, `password-reset` 8 (1 of 8 failed in this run on a 429 from the login limiter, §3.1 — not a product failure) | B22 smoke: invitation queued, worker records `emailStatus: skipped` "Email provider is not configured", never "sent" (35164851677) | **verified (flow)** / **blocked (external)** for real delivery | provide SMTP on the hosted stack, then re-run the invitation/reset e2e against a real inbox |
| 1.7 | P1 Audit logging (append-only) | Stage 2; B21 C1 (`ff7b851`) tenant attribution | `lib/audit.ts` `auditMutations`, `audit_logs` (no delete route; `cleanupOldAuditLogs` is opt-in via `JOBS_AUDIT_RETENTION_DAYS`, default off) | `audit` 5, `b21-platform-admin` (+4 attribution tests), `governance-2_11b` 7 | B21 smoke shows owner actions on the tenant trail (35161724372) | **verified** | document the opt-in retention switch next to the "append-only" statement |
| 1.8 | P1 Security Center: policies, events, IP/country rules, MFA-required, lockout | Stage 2.x | `routes/security.ts`, `services/security.service.ts`; `security_policies`, `security_events` | `ip-country-policy` 7, `mfa-closure` 9, `registration-lockdown` 8 (1 failed on the same 429, §3.1), `portal-host-login` 10 (1 failed on the same 429) | deploy only | **implemented, not hosted-verified** | hosted smoke of one policy (e.g. MFA-required) when next scheduled |
| 2.1 | P2 Dashboards per org level, KPIs, trends, scope privacy, micro-cache | Stage 3 P2; B10 (`e2d0136`) unified dashboard/analytics workspace | `routes/analytics.ts`, `reports.ts`, `services/analytics.service.ts`; web `admin/Dashboard.tsx`, `Analytics.tsx`; mobile `my-numbers.tsx` | `analytics`, `b10-unified-dashboard` 19; e2e `r-dashboard-analytics` 6 | B21/B22 smokes load the tenant dashboard after login | **verified** | none |
| 2.2 | P2 Platform-owner analytics page | — | `pages/platform/Analytics.tsx:13` still renders "Detailed Analytics coming soon"; platform stats exist on `/platform` Dashboard (B20 truthful metrics) | `b20-subscriptions` list/metrics | B21 smoke covers the platform dashboard, not this page | **gap / defect (low)** | owner decision: build the page on the existing `/platform` aggregates, or remove the placeholder route |
| 2.3 | P2 Dashboard drill-down and server-side dashboard export | — | not found (exports are entity exports, §6.1) | — | — | **unable to determine** (no approved acceptance criterion) | owner to confirm whether this is still required |
| 3.1 | P3 Contacts CRUD, dedupe/merge/undo, Contact-vs-Interaction model, status funnel | Stage 3 P3 + interaction model; B12 | `routes/contacts.ts`, `services/contacts.service.ts`; `contacts`, `scans`, `merge_history`, `contact_status_history` | `interactions-dedupe` 11, `contacts-ai` 4 (skipped in this run, 429), `b12-crm-lifecycle` 31; e2e `c-timeline` 5, `t-crm-lifecycle` 4 | B22 smoke creates/deletes disposable contacts (35164851677) | **verified** | none |
| 3.2 | P3 Leads: configurable pipeline/Kanban, ownership, activities, notes, tags, conversion, one open opportunity, won/lost closure | Stage 3 P3; B11 (`71cf58a`, `11d9156`, `3bd52a1`) | `routes/leads.ts`, `pipeline.ts`, `tags.ts`; `leads`, `pipeline_stages`, `lead_activities`, `lead_notes` | `b11-lead-closure` 29, `crm-organizations`; e2e `s-lead-closure` 7 | B16/B17 smokes create leads through workflows (34130988114, 34222496274) | **verified** | none (a separate "deals" model was resolved in B11 as the one-open-opportunity rule) |
| 3.3 | P3 Tasks, follow-ups, meetings, events; unified customer timeline | Stage 3 P3; B12 (`6428bf2`, `ea50f50`) | `routes/tasks|follow_ups|meetings|events.ts`, `services/timeline.service.ts` | `b12-crm-lifecycle` 31; e2e `c-timeline`, `t-crm-lifecycle` | deploy only (timeline not exercised on hosted) | **verified (API/UI locally)**; hosted: deploy only | none required; include in a future smoke |
| 3.4 | P3 Document management (typed categories, versions, signed URLs, tenant isolation) | Stage 3 P3 | `routes/documents.ts`, `services/documents.service.ts`, `lib/documentStorage.ts`; `documents`, `document_versions` (unique version number) | `documents` 37: **6 failed / 18 skipped locally** (documented storage-gated set; local storage `not_configured`) | **real GCS on hosted:** B22 smoke uploaded, listed, downloaded (content match), enforced cross-tenant 404 and deleted disposable documents (35164851677, "gcs 16" checks) | **verified (hosted)** — local suite cannot prove it | keep the storage-gated set documented; no product action |
| 3.5 | P3 Imports (CSV) with limits and permissions | Stage 3 | `routes/imports.ts`, `services/import.service.ts` | `import-perms` 8, `b20-limits-concurrency` 12 | deploy only | **implemented, not hosted-verified** | none required |
| 3.6 | P3 Bulk duplicate operations; restore/purge admin UX for soft-deleted records | — | soft-delete + restore exists per module (documents restore tested); no bulk-duplicate or purge workflow found | `repositories-softdelete` 7 | — | **unable to determine** (never approved as a batch; listed only in the 2026-08 audit) | owner decision whether to schedule |
| 4.1 | P4 Workflow definitions (draft/published/archived, revision-safe, catalog) | B15 (`3f55fa3`, `fb4257b`) | `routes/workflows.ts`, `services/workflow-definitions.service.ts`, `lib/workflows/{catalog,definition,conditions,triggers}.ts`; `workflow_definitions` | `b15-workflow-definitions` 44, `unit-workflow-contract` | schema push 33927866904; B16/B17 smokes | **verified** | none |
| 4.2 | P4 Deterministic engine: triggers (`lead.created/updated/assigned/stage_changed`, `contact.*`), conditions, ordered actions (assign owner, update fields, tags, task, follow-up, notification, `email.send`), idempotent runs, recovery, tenant write-gate | B16 (`1352dd3`, `7c09426`, `2b9fa16`); B20 C1 fail-closed tenant gate | `lib/workflows/{engine,dispatch,events,recovery,actions}.ts`, `services/workflow-runs.service.ts`; `workflow_runs` | `b16-workflow-engine` 23 (**1 failed in this run — regression G-1**), `b16c1-durability` 12, `unit-workflow-engine`, `b20c1-billing-durability` (workflow refusal for non-writable tenants) | B16 smoke 34130988114; hosted `workflowRecovery` sweep completing (72/6 h); `workflow.run` jobs completed (5) | **verified**, with one open test regression (G-1) | fix G-1 in a separate commit |
| 4.3 | P4 Automation UI (`/admin/automations`, editor, run history, dirty-guard) | B17 (`9ee7170`, `f22e73e`) | web `admin/Automations.tsx`, `AutomationEditor.tsx`, `AutomationRunDetail.tsx` | e2e `v-automations` 14 | B17 smoke 34222496274 (real Chromium) | **verified** | none |
| 4.4 | P4 Durable execution infrastructure: PostgreSQL queue, encrypted payloads, retries/backoff, lease recovery, dead-letter, retention | B14 (`7c7ef01` … `3f31e58`) | `lib/jobs/{queue,postgres-queue,payload-crypto,scheduler,maintenance}.ts`; `job_queue` | `b14-durable-queue` 17, `jobs` 8, `b16c1-durability` 12 | activation 33679875122 (§1.3); today: 3,385 encrypted rows, 0 dead, all recurring sweeps completing (§1.4) | **verified** | none |
| 4.5 | P4 SLA rules/breach tracking, approvals, escalations (roadmap items) | — | not in the catalog (no `approval`, `sla`, `escalation` action or trigger); the 5F advisory layer computes SLA risk read-only | `ai-workflow` | — | **gap** (unapproved remainder of Phase 4) | owner decision whether Phase 4 is complete at the delivered catalog or a follow-up batch is approved |
| 5.1 | P5 Enterprise AI Layer: Gemini 2.5 Flash only, settings/budget gate, reservation-based admission, rate limits, dedup, append-only ledger, pricing version, stub provider outside production | Stage 5.0; B22 C1 readiness gate | `src/ai/*`, `lib/ai.ts`, `services/ai.service.ts`; `ai_invocations`, `ai_usage_reservations`, `ai_settings` | `ai-platform` 18, `ai-usage-metering` 11, `ai-usage-limits` 4, `ai-usage-alerts`, `unit-ai-readiness` 7 (all green) | B22: routing proven without a billable call; usage/ledger 0 after the gate; hosted ledger rows 4 (pre-existing) | **verified (with stub / unconfigured provider)** | none for the layer; live provider = 5.6 |
| 5.2 | P5 Lead scoring, enrichment, AI insights (5A), Sales Copilot drafts (5B), Executive Intelligence (5C), Assistant (5D), Workflow Intelligence (5F) | Stage 5A–5F | `services/ai-insights|ai-copilot|executive-intelligence|ai-assistant|ai-workflow.service.ts`; web AI pages; mobile Assistant | `ai-insights`, `ai-copilot` + `ai-copilot-ux`, `executive-intelligence` 31 (2 failed = storage-gated report export), `ai-assistant`, `ai-workflow`; e2e `j-ai-copilot` 6, `k-ai-usage` 4, `e-documents-ai-tabs` 3 | deploy only (no hosted AI generation possible without a credential) | **verified with the stub**; hosted AI output **blocked (external)** | see 5.6 |
| 5.3 | P5 Intelligent capture (5E): per-field confidence, validation, recognition, duplicate warning, batch analyze | Stage 5E | `services/capture-intelligence.service.ts`, `capture-batch.service.ts`, `lib/capture-validation.ts`; `scans` columns | `capture-intelligence` 18, `capture-5e` 5 (skipped in this run, 429) | deploy only | **verified (local)**; capture-5e to be re-run | re-run in the next green gate |
| 5.4 | P5 OCR pipeline contract (400 image codes, 422 no-card, 502 provider failure, 503 unconfigured, 201 success; reservation/ledger consistency) | Stage 5E; B22 C1 (`f53c901`) | `services/scans.service.ts`, `src/ai/readiness.ts`, `lib/ai.ts:307` | `ocr-pipeline` 21 (1 failed = storage-gated reprocess), `b22c1-ocr-unconfigured` 8, `unit-ai-readiness` 7; e2e `l-ocr-scan` 2, `d-capture-fidelity` 1 | B22 C1 smoke 35373129629: one guarded `POST /scans` → **503 `AI_NOT_CONFIGURED`**, failed row, reservation released, no ledger row, no provider request, no image, no GCS object | **verified** | none |
| 5.5 | P5 AI safety contract (recommend/draft only, never auto-execute or auto-send, honest provenance) | Stage 5; B16 (no AI action in the workflow catalog) | catalog has no `ai.*` action (`b16` test 801–817); Copilot/Assistant never write CRM | suites above | — | **verified** | none |
| 5.6 | P5 Live Gemini OCR / generation quality | — | `artifacts/api-server/scripts/verify-ocr-live.ts` (opt-in) | never executed in any recorded run | hosted `GEMINI_API_KEY` is set-but-empty by decision | **blocked (external)** — a 503 probe is not live OCR | when approved: set the key on the hosted env only, run `verify-ocr-live.ts` once against the fixtures, record fields/confidence/cost |
| 6.1 | P6 Reports & Export Center: 8 report endpoints, CSV/XLSX/PDF/JSON exports, password-protected ZIP (AES-256 or ZipCrypto), export runs + history UI, schedules + run-now, signed downloads, formula-injection neutralization | B9 (`e5192a1`, `599af79`); Stage 3 P6 base | `routes/reports.ts` (8 GET), `routes/exports.ts` (`POST /exports`, `/exports/runs`, `/exports/runs/:id/download`, schedules CRUD + run), `lib/export-generate.ts`, `lib/exportStorage.ts`; `export_runs`, `export_schedules`; web `admin/Reports.tsx` (Reports / Schedules / Export History tabs) | `b9-reports-exports` 35 (storage-backed branches self-select: without storage the "completed file" cases are replaced by the documented 502 degradation), `unit-export-encryption` 7; e2e `q-reports-workspace` 6 (password rules, generation outcome, history entry, schedules) | **none:** no ops smoke (b18, b20 smoke 1–6) ever generated or downloaded an export on the hosted stack (all scripts searched); the recurring `exportSchedules` sweep runs (23/6 h) but no run row is created without a schedule | **implemented, not hosted-verified** — the real-storage, password-protected export/download path has **no completed-file evidence anywhere** (locally storage-gated; never smoked on hosted) | schedule one API-level hosted smoke: create a protected export (aes256 and zip20), poll the run, download through the signed URL, open the archive with the password, delete the run/object |
| 6.2 | P6 Custom report builder, scheduled dashboard snapshots, mobile report sharing | — | not implemented (schedules export entity data sets only) | — | — | **gap** (unapproved remainder of Phase 6) | owner decision |
| 7.1 | P7 Tenant branding (logo upload validated, colors, default theme, public digital card) | B18 (`49f0abb`, `c2cd467`) | `routes/branding.ts`, `services/branding.service.ts`, `lib/branding/*`; `companies.brand_*` columns; web `BrandingSection`, `BrandingContext`, `PublicCard.tsx` | `b18-branding` 21; e2e `w-branding` 15 | B18 smoke 34273450491 and B22 smoke (real GCS logo upload/serve/delete, orphan cleanup) | **verified** | none |
| 7.2 | P7 Per-tenant e-mail/login branding, web localization | — | e-mail templates use the global `EMAIL_BRAND_NAME` only (`lib/email/templates.ts:9`); web portal is English-only (no i18n library); mobile has EN/AR + RTL | mobile i18n unit coverage | — | **gap** (in-scope remainder of Phase 7; branding of e-mails depends on SMTP being enabled) | owner decision on priority |
| 7.3 | P7 Custom domains, customer portal | — | absent by design | — | — | **deliberately excluded** | none |
| 8.1 | P8A/8B Calendar/e-mail/CRM connectors | — | only calendar-invite logging in `communications.service.ts`; no `integration_connections`, OAuth or sync engine | — | — | **blocked (approval)** — only allowed against an approved customer requirement; none exists | none until a requirement is approved |
| 8.2 | P8C Developer platform, generic marketplace | — | absent | — | — | **deliberately excluded** | none |
| 9.1 | P9 Subscription lifecycle (canonical row, transition table, access matrix, trial, sweep, repair), limits with non-blocking defaults, truthful metrics | B19 audit (`6ed74fc`), B20 (`4f42931` … `d9e1449`) | `services/subscription-lifecycle.service.ts`, `entitlements.service.ts`, `lib/billing/*`, `lib/company-access.ts`, `lib/jobs/subscription-sweep.ts`; `subscriptions`, `plans`, `subscription_usage_reservations` | `b20-lifecycle-unit` 35, `b20-structural` 19, `b20-subscriptions` 26, `b20-limits-concurrency` 12, `b20c1` 29, `b20c2` 12, `b20c3` 3, `b20c1-config-unit` 28; e2e `x-billing` 8 | migrate/repair/verify 34991816033, 34992362689; smoke 35018387153; sweep completing hourly (§1.4); hosted schema fingerprint stable | **verified** | none |
| 9.2 | P9 Stripe self-service (Checkout, Portal, signed idempotent webhook, verified price mappings) | B20 + C1–C3 | `routes/billing-webhook.ts`, `platform-billing.ts`, `lib/billing/stripe-provider.ts`, `fake-provider.ts` | `b20-billing-stripe` 19 and the C1–C3 suites **with the fake provider**; e2e `x-billing` | hosted `BILLING_PROVIDER` unset (manual billing only) by decision | **verified (fake provider)** / **blocked (approval + commercial decisions in B20 §13)** for live Stripe | none until the owner approves live Stripe and supplies prices/keys on the hosted env only |
| 9.3 | P9 Platform Owner tenant administration (list/search/filter, detail, onboarding, subscription manager, limits, administrators, audit trail, suspend/reactivate/delete) | B21 (`286a5bb`, `ff7b851`) | `routes/companies.ts` (+`/companies/:id/audit`), `platform-billing.ts`; web `platform/Companies.tsx`, `CompanyDetail.tsx`, `Users.tsx`, `SubscriptionManager` | `b21-platform-admin` 19; e2e `z-platform-admin` 6 | B21 smoke 35161724372 (57/57, real Chromium, disposable tenants) | **verified** | none |
| 9.4 | P9 Platform monitoring (`/metrics`, health, readiness with a real storage probe) | Stage 2; export-readiness | `routes/health.ts` (bounded LIST probe), `lib/metrics.ts` | `monitoring` 15, `health-errors` 4, `unit-health-storage` | readyz `ok/ok/ok` on hosted; `jobs.pending = -1` with the postgres driver (by design, noted in B22) | **verified** | document the `-1` semantics next to `/metrics` |
| 9.5 | P9 SSO, SCIM, storage analytics, licence/seat management beyond plan limits | — | absent (no `sso`/`saml`/`scim` code; usage counts scans/contacts/users, no storage metering) | — | — | **gap** (roadmap items never approved as a batch; SCIM was "future-flagged") | owner decision |
| 9.6 | P9 Backups and restore | VPS infra (`docker/scripts/backup-postgres.sh`) | pg_dump inside the container, gzip, 7 retained; cron "documented only"; restore procedure documented in `docs/HOSTINGER_VPS_DEPLOYMENT.md` §7 | — | backups were taken by the B14 (20,430 B) and B18 activation scripts before schema changes; **cron installation, off-host copies and a restore rehearsal: no evidence** (read-only checks did not inspect crontab) | **unable to determine** (cron/off-host) and **gap** (restore never rehearsed) | inspect crontab read-only; rehearse a restore into a scratch database from the newest dump |
| 9.7 | P9 Rollback | `docker/scripts/deploy-vps.sh` | auto-rollback to `previous-deploy.sha` on failed health check; manual one-liner | — | pointer present (`ff7b851`) on every verify; auto-rollback **never exercised** (17/17 deploys succeeded) | **implemented, not hosted-verified** | optional: a deliberate rollback drill to `ff7b851` and back (two deploys) |
| M.1 | Mobile: tabs Home/Scan/Contacts/Follow-Ups/More; notification bell; Contact Workspace = Overview/Timeline/Documents + sticky quick actions; all capture modes incl. **NFC**; AI Assistant only in More; EN/AR + RTL | Stage 5.9 P4 + owner scope decisions | `app/(tabs)/_layout.tsx` (5 triggers), `more.tsx` (AI group = Assistant only, hidden for platform owners), `contact/[id].tsx` (3 tabs, no AI section), `capture-nfc.tsx` + `lib/nfc.ts`, no `workflow.tsx`/`executive.tsx` screens | mobile vitest 114/114 (this run) | mobile builds point at the hosted API (`14e1f90`); **no APK or device evidence after Batch 8** | **verified (unit + structure)**; device: **unable to determine** since Batch 8 | one physical-device pass (Expo dev build) covering camera OCR against the hosted API once Gemini is enabled, QR, NFC, offline sync |
| M.2 | Mobile scope removals: no full administration, no AI Command Center, no Workflow Intelligence, no Executive Intelligence, no Contact AI | owner decision (Aug 2026) | no admin/security/billing screens; no command-center screen; **but** `WorkflowSection` is rendered on `app/pipeline/[id].tsx:701` and `app/company/[id].tsx:200`, and `CopilotSection` on `pipeline/[id].tsx:700` | — | — | **gap / decision (G-4)** | owner to confirm whether per-entity Workflow Intelligence recommendations on lead/company detail count as the removed "mobile Workflow Intelligence"; if yes, remove the two renders (and the unused component) in one small commit |

### 2.2 Batch deliverables B1–B22

| Batch | Deliverable (as recorded) | Commit(s) | Local evidence | Hosted evidence | Status | Remaining action |
|---|---|---|---|---|---|---|
| B1–B8 | Hardening/verification batches ending in device verification (Honor Magic V5, Android 16) | pre-`export-ready` history; no per-batch commits or reports | the product state is covered by every suite in §3 | first hosted deploys 32312741644 / 32315935016 | **unable to determine (provenance)**; product state **verified** through §2.1 | none |
| B9 | Reports & Export Center completion + ZipCrypto option | `e5192a1`, `599af79` | `b9-reports-exports` 35, `unit-export-encryption` 7, e2e `q-reports-workspace` 6 | deploy 32629682652 / 32635097743 only | **implemented, not hosted-verified** (row 6.1) | hosted export smoke |
| B10 | Dashboard & Analytics workspace | `e2d0136` | `b10-unified-dashboard` 19, e2e `r-dashboard-analytics` 6 | deploy 32637463656; dashboards loaded in later smokes | **verified** | — |
| B11 | Lead conversion & opportunity closure (+2 corrections) | `71cf58a`, `11d9156`, `3bd52a1` | `b11-lead-closure` 29, e2e `s-lead-closure` 7 | deploy 32670877095 | **verified** | — |
| B12 | Tasks / follow-ups / timeline lifecycle (+correction) | `6428bf2`, `ea50f50` | `b12-crm-lifecycle` 31, e2e `t-crm-lifecycle` 4 | deploy 32878510718 | **verified** | — |
| B13 | Portal modernization polish (+tablet regression) | `e3395f7`, `b5b6421` | e2e `u-b13-modernization` 10, `f-responsive` 1, `g-dark-mode` 2 | deploy 32886447229 | **verified** | — |
| B14 | Durable PostgreSQL queue with encrypted payloads (+3 corrections) | `7c7ef01`, `5afe2b1`, `81094fe`, `3f31e58` | `b14-durable-queue` 17, `jobs` 8 | activation 33679875122; queue healthy today (§1.4) | **verified** | — |
| B15 | Workflow definitions (+immutability/revision correction) | `3f55fa3`, `fb4257b` | `b15-workflow-definitions` 44 | 33927866904 | **verified** | — |
| B16 | Deterministic workflow engine (+2 corrections) | `1352dd3`, `7c09426`, `2b9fa16` | `b16-workflow-engine` 23 (1 failing — G-1), `b16c1-durability` 12 | 34130988114 | **verified with one open test regression** | fix G-1 |
| B17 | Workflow automation UI (+history guard) | `edf61d3`, `9ee7170`, `f22e73e` | e2e `v-automations` 14 | 34222496274 | **verified** | — |
| B18 | Tenant branding (+public logo boundary correction) | `49f0abb`, `c2cd467` | `b18-branding` 21, e2e `w-branding` 15 | 34269702351, 34273450491, B22 logo checks | **verified** | — |
| B19 | Billing audit (documentation) | `6ed74fc` | — | — | **verified (superseded by B20 as documented)** | — |
| B20 | Canonical subscription lifecycle, hybrid Stripe boundary, limits, truthful metrics (+C1 durability, C2 ownership, C3 fence, C4 effective permissions) | `4f42931`, `5276f28`, `11207f1`, `054b207`, `d9e1449` | 8 API suites (§2.1 row 9.1/9.2), e2e `x-billing` 8, `y-rbac-permissions` 4 | 34991816033, 34992362689, 35018329822, 35018387153, 35029273566, 35104508283 | **verified** (manual + fake provider); live Stripe **blocked** | — |
| B21 | Platform Owner admin panel (+C1 audit attribution) | `286a5bb`, `ff7b851` | `b21-platform-admin` 19, e2e `z-platform-admin` 6 | 35161724372 (57/57) | **verified** | — |
| B22 | Production & provider verification (real GCS, Gemini routing, SMTP queue, infra); Correction 1 (503 `AI_NOT_CONFIGURED`) | verification runs; `f53c901` | `unit-ai-readiness` 7, `b22c1-ocr-unconfigured` 8 | 35164851677 (52/52), 35216127620, 35373129629 (18/18) | **verified**; live Gemini and SMTP delivery **blocked (external)** | — |

---

## 3. Test and hosted-verification results (single runs, 2026-09-18, tree `f53c901`)

Local stack: isolated dev PostgreSQL 16, API `:8080` behind the `:80` gateway, Vite `:3000`,
`NODE_ENV=development`, `BILLING_PROVIDER=fake` + `STRIPE_WEBHOOK_SECRET` +
`BILLING_SELF_SERVICE_CHECKOUT=true` in the API and test shells, no Gemini / SMTP / GCS
credentials (storage `not_configured`). The API process was restarted immediately before
the API suite and again before the Playwright suite. **No suite was re-run to improve a
number.**

### 3.1 API suite — `pnpm --filter @workspace/api-server run test` (vitest, once)

| Result | Count |
|---|---|
| Test files | 71 (60 passed, 11 with failures or skips) |
| Tests | **1268 total — 1207 passed, 13 failed, 48 skipped** (264.8 s) |

Failure and skip classification:

| Class | Tests | Cause | Regression? |
|---|---|---|---|
| Documented storage-gated set | `documents.test.ts` 6 failed + 18 skipped; `ocr-pipeline.test.ts` 1 ("reprocess re-runs OCR on the stored image"); `executive-intelligence.test.ts` 2 (async report export) | local object storage `not_configured` (upload-url 500 / export upload) — identical to the documented set; the same paths are **green on the hosted stack with real GCS** (B22 run 35164851677) | no |
| **New — G-1** | `b16-workflow-engine.test.ts` › "workflow execution recorded no AI invocation (only the pre-existing contact lead-scoring of POST /contacts appears)" — `expected +0 to be 2` at line 814 | the test asserts one `lead_scoring` ledger row per `POST /contacts`. Since B22 C1 (`lib/ai.ts:307`, `assertProviderConfigured`) an **unconfigured** provider is refused before any ledger write, so the background lead scoring of the two fixture contacts now records **no** row (by design of C1). The test's expectation encodes the pre-C1 behaviour ("a failed provider call still writes a failed row"). The full API suite was not run after C1 (only the focused C1 suites were), which is why this was not caught before the hosted activation | **yes — test-expectation regression introduced by `f53c901`**; product behaviour matches the C1 design |
| Login rate limiter (harness) | `password-reset` 1, `portal-host-login` 1, `registration-lockdown` 1 (all `expected 429 to be 200` on `admin@techcorp.com`); `capture-5e` 5, `contacts-ai` 4, `repositories-softdelete` 7, `role-firewall` 4 **skipped** because their `beforeAll` demo login returned 429 | `loginRateLimiter` (`middlewares/rateLimit.ts`, failures-only, `LOGIN_RATE_MAX=20` per 15 min per IP) — the suite itself performs intentional failed logins (this run: 18 × 401, 20 × 403, 3 × 400, 2 × 413 on `/auth/login`) which exhausted the 20-failure budget mid-run; 9 logins then received 429. The API had been restarted right before the run as documented, so the documented procedure no longer guarantees a green run at the current suite size (1268 tests) | not a product defect; **harness fragility (G-2)** |
| Other baseline skips | 10 | as in the documented baseline (28 = 18 documents + 10) | no |

Net: **everything outside the documented storage-gated set, G-1 and the limiter-induced
429s passed.** Compared with the prior full run of 2026-09-16 (`c4-api-full`, 1234 tests,
9 failed = storage-gated only), the tree gained 34 tests (B21 C1 + B22 C1) and one genuine
test regression.

### 3.2 Web e2e — `pnpm --filter @workspace/web-app run test:e2e` (Playwright, chromium, once)

**152 / 152 passed** (26 spec files, `workers: 1`, 6.8 min, fresh API process, gateway `:80`,
`PW_CHROMIUM_PATH` set, billing env as above). No failures, no flaky retries, exit 0. The
documented baseline of 142 predates the B20 C4 / B21 / B21 C1 specs (`y-rbac-permissions`,
`z-platform-admin` additions).

### 3.3 Mobile unit — `pnpm --filter @workspace/mobile run test`

**114 / 114 passed** (10 files).

### 3.4 Typecheck and builds

| Gate | Result |
|---|---|
| `pnpm run typecheck:libs` | PASS (exit 0) |
| `pnpm --filter @workspace/api-server run typecheck` | PASS |
| `pnpm --filter @workspace/web-app run typecheck` | PASS |
| `pnpm --filter @workspace/mobile run typecheck` | PASS |
| `pnpm --filter @workspace/scripts run typecheck` | PASS |
| `pnpm run typecheck` (workspace-wide) | **FAIL — only `artifacts/mockup-sandbox`** (`src/components/ui/calendar.tsx(132,15)`, `src/components/ui/spinner.tsx(7,6)`: duplicated `@types/react` `Ref` types). Pre-existing on pristine `develop` (proven during B22 C1 by stash/typecheck/pop); the package is not part of the runtime product and the hosted `verify` job runs the per-package typechecks, which pass |
| `pnpm --filter @workspace/api-server run build` | PASS |
| `pnpm --filter @workspace/web-app run build` | PASS (Vite production bundle built) |

### 3.5 Hosted-dev checks (read-only, this audit)

Runs 35375653337 (`c4-verify`) and 35375655857 (`b22-infra`) — both `success`; contents in
§1.4. No write was performed on the VPS, the database, the schema, the env file, the
secrets, the containers, GCS, the queue or the host PostgreSQL listener.

---

## 4. Genuine gaps, prioritized

| Id | Priority | Gap | Impact | Reproduction / evidence | Smallest correction | Acceptance test | Needs |
|---|---|---|---|---|---|---|---|
| **G-1** | **P1 (gate-blocking)** | `b16-workflow-engine.test.ts:801-818` fails on `f53c901` (`expected +0 to be 2`) | the API gate is red for a non-storage reason; masks future regressions | §3.1; `lib/ai.ts:307` refuses the unconfigured provider before the ledger write | make the test provider-explicit: opt the two fixture tenants into the stub provider (`PATCH /ai/settings {provider:"stub"}`, as `ai-usage-metering.test.ts:58` does) so one `lead_scoring` row per contact is deterministic again — or, if the intent is "no AI in workflows regardless of provider", assert `total === 0` when `/ai/health.configured === false` and `=== apiContactCreations` otherwise. Test-only change, one commit | the full API suite shows only the documented storage-gated failures | no credentials; approval of the correction commit |
| **G-2** | **P1 (gate-blocking)** | the documented "restart the API, run once" procedure no longer yields a green API run: the suite's own intentional failed logins exceed `LOGIN_RATE_MAX=20`/15 min from one IP, producing 3 failures and 20 skips (§3.1) | the release gate cannot be evaluated from a single run; reruns would be needed, which the working rules forbid | §3.1 (9 × 429 on `/auth/login`); `config.ts:194`, `rateLimit.ts:24-31` | start the **API process** for a local full run with `LOGIN_RATE_MAX=1000` exported in the API shell before `PORT=8080 pnpm --filter @workspace/api-server run dev` — `config.ts` reads the value once at startup, so a value in the vitest shell alone changes nothing; documented in `docs/LOCALHOST_DEVELOPMENT.md` §3/§5/§7/§9/§10. The hosted/production default of 20 is unchanged (`config.security.loginRateLimitMax`, no `NODE_ENV` branch) and is pinned by the isolated `test/unit-login-rate-limit.test.ts` (default 20, env override, failures-only accounting, 429 with the JSON body for every caller from the IP after the ceiling, private in-process Express app). Per-account lockout (`test/auth-security.test.ts` "brute-force lockout") and forgot-password throttling (`test/password-reset.test.ts` "rate limits repeated requests") are separate guards with unchanged coverage | **Correction 1 evidence (2026-09-18):** API restarted with `LOGIN_RATE_MAX=1000` in its environment (the node process env shows the key; note the `RateLimit-*` response headers on `/auth/login` belong to the broader `/auth` limiter mounted after it, so they cannot show the login ceiling) → behavioural probe of 21 failed logins with 21 distinct unknown e-mails from the loopback IP answered 401 × 21 / 429 × 0 (the default ceiling of 20 answers 429 on the 21st; the 21 probe `login_attempts` rows were deleted afterwards); `test/unit-login-rate-limit.test.ts` 3/3 (default 20, override, failures-only + 429); one full API run afterwards (after G-1, with the 3 new limiter tests): **1234 passed / 9 failed / 28 skipped of 1271** — the 9 failures and 18 of the skips are exactly the documented storage-gated set (`documents` 6 + 18 skipped, `ocr-pipeline` 1, `executive-intelligence` 2), no login answered the limiter's "Too many requests" during the run (the single 429 on `/auth/login` is the per-account lockout assertion of `auth-security`), no suite was skipped for a failed fixture login | none |
| **G-3** | **P1 (verification)** | password-protected export generation + signed download on real storage has no completed-file evidence anywhere: locally the storage-backed branches degrade to the documented 502, and no hosted smoke ever generated an export (all ops scripts searched) | B9's core promise (decision-grade, protected exports) is implemented and unit-tested (`unit-export-encryption` 7) but never proven end-to-end on the real GCS path | `b9-reports-exports.test.ts:221,345` (`describe.runIf(STORAGE)`), ops scripts on `ops/b20-hosted-activation` and `ops/b18-hosted-activation` contain no `/exports` call | one API-level hosted smoke phase in the existing `b20-act.sh` / smoke pattern: create a protected export (`aes256` and `zip20`) for a disposable tenant, poll `/exports/runs`, download via `/exports/runs/:id/download`, verify the archive opens with the password and the CSV matches the tenant's rows, then delete the run and the GCS object | smoke passes with cleanup proof (0 disposable rows, 0 objects) | approval to run a hosted smoke; no credentials beyond the existing GCS mount |
| **G-4** | P2 (scope consistency) | mobile lead detail renders `CopilotSection` + `WorkflowSection`; company detail renders `WorkflowSection` (`app/pipeline/[id].tsx:700-701`, `app/company/[id].tsx:200`) while the owner removed "mobile Workflow Intelligence" and `PROJECT_FILE_MAP.md` marks the component excluded | scope contradiction between documentation and the shipped app; the sections call `/ai/workflow/*`, which is a retained web surface, so no security impact | open a lead in the mobile app → Workflow section visible | owner decision; if removal: delete the two renders and the two components, keep the Contact workspace unchanged, run the mobile suite and typecheck | mobile typecheck + 114/114; no `WorkflowSection` import remains | owner decision |
| **G-5** | P2 (documentation of record) | `PROJECT_TECHNICAL_BRIEF.md` §B/§C/§E/§M, `CLAUDE.md` working rules, `HOSTINGER_VPS_DEPLOYMENT.md` counts and the workflow step name describe the pre-B9 / in-process / Replit state (§1.5) | a new developer or auditor is misled about what is deployed and how jobs run | §1.5 | one documentation commit: baseline table (§3 numbers), queue driver, staging = Hostinger dev stack, "next approved batch" line, mobile "114 expected" | docs match `develop`; codegen/tests unaffected | none |
| **G-6** | P2 (operations) | backups: cron installation, off-host copies and a restore rehearsal have no evidence; auto-rollback never exercised | a VPS loss or a bad deploy is recoverable only on paper | §2.1 rows 9.6/9.7 | read-only `crontab -l` and backup-directory listing in the next ops run; one restore rehearsal into a scratch database inside the postgres container from the newest dump; optional rollback drill | listing shows the daily job and ≥1 recent dump; restore completes and `readyz` stays ok; drill returns to `f53c901` | approval for the ops run (read-only) and for the rehearsal |
| **G-7** | P3 | platform-owner analytics page is a placeholder (`platform/Analytics.tsx:13`) | a visible "coming soon" in a portal declared complete | open `/platform/analytics` | either wire the existing platform aggregates or remove the nav item/route | e2e `z-platform-admin` extended by one assertion | owner decision |
| **G-8** | P3 | Phase 4/6/7/9 remainders never approved as batches: SLA/approval/escalation workflow actions; custom report builder / dashboard snapshots; per-tenant e-mail and login branding, web localization; SSO/SCIM, storage metering | roadmap items without an approved acceptance criterion | §2.1 rows 4.5, 6.2, 7.2, 9.5 | none in this audit — owner to mark each as "approved batch", "deferred" or "removed" | — | owner decision |
| **G-9** | P3 (information) | `/metrics` reports `jobs.pending = -1` under the postgres driver (by design); `cleanupOldAuditLogs` is an opt-in purge next to the "append-only" statement | operators may misread both | `lib/jobs/maintenance.ts:75-84`; B22 finding 3 | one-line notes in `docs/HOSTINGER_VPS_DEPLOYMENT.md` / `security-and-privacy.md` | — | none |
| **G-10** | P3 (tooling) | workspace-wide `pnpm run typecheck` fails in `artifacts/mockup-sandbox` (duplicated `@types/react` `Ref` types in `calendar.tsx` / `spinner.tsx`); pre-existing, non-runtime package | the documented "all packages — PASS" gate in `CLAUDE.md` is not literally true | §3.4 | either dedupe `@types/react` for that package or exclude it from the root `typecheck` script | `pnpm run typecheck` exit 0 | none |

Not counted as gaps (deliberately excluded by the owner): Customer Portal, Custom Domains,
Public Developer Platform, Generic Integration Marketplace, full mobile administration,
mobile AI Command Center / Workflow Intelligence / Executive Intelligence screens, Contact AI
on mobile. NFC, every capture mode, the mobile AI Assistant and Gemini 2.5 Flash through the
Enterprise AI Layer remain in scope and are present.

---

## 5. Release gates

| Gate | State today | Basis |
|---|---|---|
| Typecheck (libs, API, web, mobile, scripts) | **passed** (workspace-wide run fails only in the non-runtime `mockup-sandbox` package — G-10) | §3.4 |
| API production build | **passed** | §3.4 |
| Web production build | **passed** | §3.4 |
| API suite green except the documented storage-gated set | **blocked** | G-1 (1 genuine test regression) + G-2 (limiter-induced 3 failures / 20 skips) — §3.1 |
| Playwright e2e | **passed** (152/152) | §3.2 |
| Mobile unit suite | **passed** (114/114) | §3.3 |
| Contract ↔ generated clients in sync | **passed** | codegen produced no diff |
| Hosted dev stack healthy at the audited SHA, schema fingerprint stable, queue healthy, no disposable data, baseline unchanged | **passed** | §1.4 |
| Real object storage path (documents, logos) | **passed (hosted)** | B22 run 35164851677, B18 run 34273450491 |
| Real storage path for protected exports | **not yet checked** | G-3 |
| Live Gemini OCR / AI generation | **blocked (external)** | no credential by decision; 503 probe only (§2.1 row 5.6) |
| Real e-mail delivery (invite, reset, workflow `email.send`) | **blocked (external)** | SMTP absent by decision; queue semantics verified |
| Live Stripe | **blocked (approval + commercial decisions)** | B20 §13 |
| Physical-device verification of the current mobile build | **not yet checked** | no evidence after Batch 8 |
| Backups (cron, off-host) and restore rehearsal | **not yet checked** | G-6 |
| Rollback drill | **not yet checked** (mechanism present) | G-6 |
| Tenant isolation / Platform Owner firewall / RBAC / audit | **passed** | §2.1 rows 1.2–1.4, 1.7 (two isolation suites to be re-run after G-2) |

**Can release readiness be claimed today? No.** Two gate-blocking items are open on the
tree itself (G-1 regression, G-2 harness fragility — both small, test/tooling only), one
core B9 path has never been proven on real storage (G-3), and the three external
verifications the owner has deliberately kept disabled (live Gemini, SMTP delivery, live
Stripe) plus the device pass remain unperformed. What **can** be stated today: the code
at `f53c901` is deployed and healthy on the hosted dev stack, its schema and data are
intact, every security invariant has green automated proof, and all delivered batches
B9–B22 except the B9 storage path have hosted-run evidence.

---

## 6. Ordered completion plan (each item = its own commit / run; nothing started here)

1. **G-1** — fix the `b16-workflow-engine` expectation (test-only commit on a `claude/b23-correction-1-…` branch from `develop`); run the full API suite once.
2. **G-2** — start the API process for local full runs with `LOGIN_RATE_MAX=1000` in the API shell (documented in `docs/LOCALHOST_DEVELOPMENT.md` §3/§5/§7/§9/§10 and the `CLAUDE.md` test block; production default 20 untouched), add the isolated limiter test `test/unit-login-rate-limit.test.ts` that pins the default and the failures-only 429 behaviour, then confirm one full API run shows only the documented storage-gated set. **Done in Correction 1** (`claude/b23-correction-1-api-gates`): API restarted with `LOGIN_RATE_MAX=1000` → probe 21 distinct failed logins = 401 × 21 / 429 × 0 → full API run **1234 passed / 9 storage-gated failed / 28 skipped of 1271**; G-1 fixed in the same branch (`b16-workflow-engine` 23/23 with the explicit stub provider).
3. **G-5 + G-9** — documentation-of-record refresh (single docs commit): brief §B/§C/§E/§K/§M, `CLAUDE.md` working rules and baselines, Hostinger doc counts, workflow step name, `/metrics` and audit-retention notes.
4. **G-3** — hosted, API-level protected-export smoke through the existing ops tooling (new phase in `b20-act.sh` + a smoke script; disposable tenant; cleanup proof). Requires approval to run on the hosted stack.
5. **G-6** — read-only crontab/backup listing in the same ops run; then, with approval, a restore rehearsal into a scratch database and an optional rollback drill.
6. **G-4, G-7, G-8** — owner decisions recorded in `replit.md` / the roadmap (approved batch, deferred or removed). Any resulting code change is its own batch.
7. **External verifications, each behind explicit approval and with credentials placed only in the hosted env file:** (a) Gemini key → `verify-ocr-live.ts` once + one hosted scan probe expecting 201; (b) SMTP → invitation and reset delivery to a controlled inbox; (c) Stripe test mode with the B20 §13 decisions; (d) physical-device pass of the current mobile build against the hosted API.
8. Only after 1–5 are green and 7(a)/(b)/(d) are recorded: fast-forward `develop` is already the deployed state; a release candidate can then be cut from `develop` (never from `main`).

---

*End of the Batch 23 reconciliation. Audit branch `claude/b23-final-reconciliation`; the only file added is this document.*
