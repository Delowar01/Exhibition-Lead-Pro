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
| [Gotchas](gotchas.md) | Operational, build, runtime, data-integrity, and testing traps found during development. |
| [Architecture Overview](architecture.md) | Current vs. recommended architecture: the contract-first pipeline, multi-tenant isolation, authorization, audit, logging, and the hardened server foundation. What already meets the enterprise bar and what is deferred to Stage 2. |
| [Logical Structure Map](structure.md) | How the existing `artifacts/` (apps) and `lib/` (packages) layout already fulfills an apps/packages/services model — with each package mapped to its role, no physical renames. |
| [Technical-Debt Register](tech-debt.md) | Prioritized register (Critical/High/Medium/Low) of gaps found during the Stage 1 review, each with impact and a recommended remediation stage. |
| [Developer Guide](developer-guide.md) | Local setup, how to run each app, the codegen and test commands, and the naming/coding conventions the project follows. |
| [API Guide](api-guide.md) | The OpenAPI-first contract workflow (OpenAPI → Zod → React Query), authentication, and the standardized error shape. |
| [Deployment Guide](deployment.md) | Replit autoscale as the primary deployment, with a pointer to the external Docker self-hosting setup. |
| [Reports](reports/README.md) | QA, release, and pre-build verification reports captured during development. |

## How this maps to the codebase

- **Apps** live in [`artifacts/`](../artifacts) — `api-server`, `web-app`, `mobile`,
  `pitch-deck`, and the `mockup-sandbox` design surface.
- **Packages** live in [`lib/`](../lib) — `api-spec`, `api-zod`, `api-client-react`,
  `db`, `integrations-gemini-ai`.
- **The API contract** is the source of truth at
  [`lib/api-spec/openapi.yaml`](../lib/api-spec/openapi.yaml); generated clients and
  validators flow from it.

See [`structure.md`](structure.md) for the full map.
