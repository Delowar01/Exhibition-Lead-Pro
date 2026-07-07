# Card Scanner Pro

An enterprise SaaS platform for business card scanning and lead management. Two portals: a Platform Owner portal for managing all tenant companies, and a Company Admin portal for managing contacts, leads, events, and team members.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000 → proxied at /api)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-server run test` — integration + unit tests (vitest, run against the LIVE API at localhost:80 + seeded demo tenants; api-server workflow must be running). **Pre-merge gate** (registered as the `test` validation alongside `typecheck`): a clean run is fully green (unit-lib, audit, api-standardization, auth-security, contacts-ai, health-errors, jobs, phase24/25, repositories-softdelete, services). Run it before merging any Stage-2 change.
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `SESSION_SECRET` — JWT signing key

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React 19 + Vite + Tailwind CSS + shadcn/ui
- Auth: JWT stored as `csp_token` in localStorage; `setAuthTokenGetter` wires it to all API calls

## Where things live

- `lib/api-spec/openapi.yaml` — source of truth for all API contracts
- `lib/db/src/schema/index.ts` — Drizzle ORM schema (companies, users, events, contacts, leads, scans, subscriptions, activity_logs)
- `lib/api-client-react/src/` — Orval-generated React Query hooks + custom fetch wrapper
- `artifacts/api-server/src/routes/` — Express route handlers (auth, companies, users, contacts, leads, events, scans, subscriptions, platform, reports)
- `artifacts/web-app/src/pages/platform/` — Platform Owner portal pages
- `artifacts/web-app/src/pages/admin/` — Company Admin portal pages
- `artifacts/web-app/src/contexts/AuthContext.tsx` — auth state management

## Roadmap & direction (long-term, per owner directive July 2026)

Current priority: **finish Stage 5** in this order — 1) Stage 5E Enterprise Intelligent Capture, 2) Stage 5F Enterprise Workflow Intelligence, 3) Stage 5D Enterprise AI Assistant. (Product direction may also be referred to as "Lead Capture Pro".)

**Until Stage 5 is complete:** no major UI redesign; do not redesign screens individually; do not introduce multiple design styles; avoid UI decisions that would conflict with a future enterprise design system; keep using the existing UI but prefer clean, reusable components that can later migrate into the design system.

**Immediately after Stage 5 is completed and approved → Stage 5.9 – Enterprise Design System & Experience Modernization** (before Stage 6; remind the owner to begin it). Stage 5.9 introduces NO new business features — it is a full UX/design modernization: complete design system + component library (color, typography, icons, grid/spacing, responsive standards), redesign of navigation, CRM UX, dashboards, AI modules, executive dashboard, OCR workflow, reports, both portals, and the employee mobile app; improved tables/forms/drawers/dialogs/cards/search/filters/empty/loading/error states; better IA, mobile & tablet UX, accessibility, performance-focused UI, and smooth micro-interactions. Design bar: comparable to Salesforce Lightning, HubSpot, Dynamics, Linear, Notion, Atlassian, Apple — premium, modern, clean, professional, enterprise, consistent, fast, easy to use.

## Architecture decisions

Contract-first (OpenAPI → Orval → React Query + Zod), a 4-tier role hierarchy (`platform_owner → primary_admin → admin → employee`), `company_id` as the sole tenant boundary (cross-tenant access → 404, not 403), fresh-per-request `requireAuth` (loads live role/permissions/status + subscription lifecycle), a writes-only permissions matrix (`platform_owner`/`primary_admin` bypass; empty `{}` = deny-by-default), append-only `audit_logs`, and a plan/subscription model enforced server-side. Full rationale for each decision: **[docs/architecture-decisions.md](docs/architecture-decisions.md)** (Stage-1 current-vs-recommended review in [docs/architecture.md](docs/architecture.md)).

## Product

Two portals — **Platform Owner** (`/platform`: tenant companies, subscriptions, platform analytics, user management) and **Company Admin** (`/admin`: scan cards, contacts, Kanban lead pipeline, events, team, reports, enrichment, dedup/merge) — plus org structure (Stage 3 P1), executive dashboards & analytics (Stage 3 P2), AI Sales Copilot (Stage 5B), Intelligent Capture Engine (Stage 5E), and AI Workflow & Automation Intelligence (Stage 5F). Full per-feature reference — endpoints, scope-privacy rules, web/mobile surfaces: **[docs/product.md](docs/product.md)**.

## AI & Workflow

Every AI surface (Stage 5A insights, 5B copilot, 5E capture, 5F workflow) shares one safety contract: recommend/draft from real CRM data only, **never auto-execute or write the source CRM**, deterministic grounded cores (conf 100) with best-effort AI phrasing that soft-degrades to 200 (never 500), and honest provenance (deterministic rows never masquerade as AI). Each has its own RBAC module with a startup permission backfill. Engine internals, the shared contract, and AI safety notes: **[docs/ai-architecture.md](docs/ai-architecture.md)**.

## Demo credentials

| Role | Email | Password |
|---|---|---|
| Platform Owner | admin@cardscannerpro.com | Admin123! |
| Company Admin (TechCorp) | admin@techcorp.com | Admin123! |
| Company Admin (Nexus) | admin@nexussys.io | Admin123! |
| Company Admin (Innovatech) | admin@innovatech.es | Admin123! |

Quick demo login buttons are available on the login page.

## User preferences

- App footer branding reads "Powered by Elite Marcom".
- Email actions on mobile must let the OS pick the mail app (no forced Gmail).
- No fabricated/mocked data — derive insights from real API data, and prefer honest flows (e.g. forgot-password says "contact admin" rather than faking a reset API).
- Native mobile features (NFC, background processing, contacts, notifications, location, etc.) must be validated on an Expo Development Build or native APK/TestFlight build — NOT Expo Go. Native module code must degrade gracefully on web/Expo Go. EAS build profiles live in `artifacts/mobile/eas.json` (`development` dev-client APK, `preview` internal APK, `production`).

## Gotchas

Operational build/codegen/runtime/data-integrity/testing traps: **[docs/gotchas.md](docs/gotchas.md)**. Security, tenant-isolation & FK-integrity invariants (never scope a tenant read by `companyId` alone, `refAccessible` vs `refInCompany`, no role escalation, router-guard leak): **[docs/security-and-privacy.md](docs/security-and-privacy.md)**. AI-specific safety notes (advisory-only capture/workflow, Gemini timeouts): **[docs/ai-architecture.md](docs/ai-architecture.md)**.

## Pointers

- See **[docs/](docs/README.md)** for the full documentation set: [product](docs/product.md), [architecture decisions](docs/architecture-decisions.md), [AI & workflow architecture](docs/ai-architecture.md), [security & privacy](docs/security-and-privacy.md), [gotchas](docs/gotchas.md), plus the architecture review, logical structure map, technical-debt register, and developer/API/deployment guides. Historical QA/release/verification reports live under [docs/reports/](docs/reports/README.md).
- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
