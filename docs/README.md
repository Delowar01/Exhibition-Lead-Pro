# Card Scanner Pro — Documentation

Enterprise documentation for Card Scanner Pro, a multi-tenant SaaS platform for
business-card scanning and lead management. This `docs/` tree is the consolidated
institutional knowledge for the project; the repo-root [`replit.md`](../replit.md)
remains the quick-start overview and the home for user preferences. Detailed
gotchas now live in [`gotchas.md`](gotchas.md) (with a summary pointer in
`replit.md`).

## Contents

| Document | What it covers |
|---|---|
| [Product](product.md) | The full product surface: Platform & Admin portals, org structure, executive dashboards/analytics, AI Sales Copilot, Intelligent Capture, and AI Workflow Intelligence — the detailed per-feature reference. |
| [Architecture Decisions](architecture-decisions.md) | The living runtime decisions: contract-first pipeline, role hierarchy, the `company_id` tenant boundary, JWT auth, the permissions matrix, and the subscription/plan model. |
| [AI & Workflow Architecture](ai-architecture.md) | The shared AI safety contract, the AI Engine internals, and AI/workflow operational notes. Recommend/draft only — never auto-execute or write the source CRM. |
| [Security & Privacy](security-and-privacy.md) | Tenant-isolation, authorization, FK-integrity, and scope-privacy invariants every route and query must uphold. |
| [Stage 5.9 Master Plan](stage-5.9-master-plan.md) | Enterprise UX Audit + the phased plan for the Stage 5.9 Enterprise Design System & Experience Modernization (planning-only; implementation after owner approval). |
| [Design System](design-system/README.md) | The Stage 5.9 enterprise design system: tokens & color, typography, component layer, theming (light/dark/system), motion, responsive & RTL, and accessibility guides. Live showcase at `/admin/design-system`. |
| [Gotchas](gotchas.md) | Operational, build, runtime, data-integrity, and testing traps found during development. |
| [Architecture Overview](architecture.md) | Current vs. recommended architecture: the contract-first pipeline, multi-tenant isolation, authorization, audit, logging, and the hardened server foundation. What already meets the enterprise bar and what is deferred to Stage 2. |
| [Logical Structure Map](structure.md) | How the existing `artifacts/` (apps) and `lib/` (packages) layout already fulfills an apps/packages/services model — with each package mapped to its role, no physical renames. |
| [Technical-Debt Register](tech-debt.md) | Prioritized register (Critical/High/Medium/Low) of gaps found during the Stage 1 review, each with impact and a recommended remediation stage. |
| [Developer Guide](developer-guide.md) | Local setup, how to run each app, the codegen and test commands, and the naming/coding conventions the project follows. |
| [API Guide](api-guide.md) | The OpenAPI-first contract workflow (OpenAPI → Zod → React Query), authentication, and the standardized error shape. |
| [Deployment Guide](deployment.md) | The current hosted environment (Hostinger dev VPS, auto-deploy from `develop`) with the historical Replit autoscale notes and the Docker self-hosting pointer. |
| [Reports](reports/README.md) | QA, release, and pre-build verification reports captured during development (archived point-in-time reports; not rewritten). |

## Status, operations and batch records (living documents)

| Document | What it covers |
|---|---|
| [Project Technical Brief](PROJECT_TECHNICAL_BRIEF.md) | Architecture and the current status of record (branch model, current/planned batches, baseline pointer). |
| [Project File Map](PROJECT_FILE_MAP.md) | Feature → files map. |
| [Localhost Development](LOCALHOST_DEVELOPMENT.md) | Local workflow and the **single authoritative test baseline** (§7). |
| [Hostinger VPS Deployment](HOSTINGER_VPS_DEPLOYMENT.md) | The hosted dev stack: deploy flow, environment, backups, audit-retention operator contract. |
| [Backup and Recovery](BACKUP_AND_RECOVERY.md) | Scheduled PostgreSQL backups, external health alert, restore procedures, off-host status (code complete, activation deferred by owner). |
| [B23 Final Reconciliation](B23_FINAL_RECONCILIATION.md) | Gap register G-1…G-10, release gates and the ordered completion plan, with the B24 status addendum. |
| [B19 Billing Audit](B19_BILLING_AUDIT.md), [B20 Subscription Lifecycle](B20_SUBSCRIPTION_LIFECYCLE.md), [B21 Platform Owner Admin](B21_PLATFORM_OWNER_ADMIN.md) | Batch design records (B19 superseded by B20). |
| [Local & Staging Runbook](LOCAL_AND_STAGING_RUNBOOK.md), [Portable Environment Setup](PORTABLE_ENVIRONMENT_SETUP.md), [Secret & Portability Audit](SECRET_AND_PORTABILITY_AUDIT.md) | Export-era (August 2026) references; current topology and baselines live in the documents above. |

## How this maps to the codebase

- **Apps** live in [`artifacts/`](../artifacts) — `api-server`, `web-app`, `mobile`,
  `pitch-deck`, and the `mockup-sandbox` design surface.
- **Packages** live in [`lib/`](../lib) — `api-spec`, `api-zod`, `api-client-react`,
  `db`, `integrations-gemini-ai`.
- **The API contract** is the source of truth at
  [`lib/api-spec/openapi.yaml`](../lib/api-spec/openapi.yaml); generated clients and
  validators flow from it.

See [`structure.md`](structure.md) for the full map.
