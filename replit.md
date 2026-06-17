# Card Scanner Pro

An enterprise SaaS platform for business card scanning and lead management. Two portals: a Platform Owner portal for managing all tenant companies, and a Company Admin portal for managing contacts, leads, events, and team members.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000 → proxied at /api)
- `pnpm run typecheck` — full typecheck across all packages
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

## Architecture decisions

- Contract-first: OpenAPI spec → Orval codegen → React Query hooks + Zod schemas
- Dual-portal auth: `role = platform_owner` → `/platform`, `role = company_admin | team_member` → `/admin`
- JWT auth (not session cookies) since the API may serve a mobile client in future
- `setAuthTokenGetter` in `@workspace/api-client-react` injects the Bearer token globally — no per-call headers needed
- Subscription plans are enforced server-side via the `subscriptions` table; plan limits stored in DB, not hardcoded

## Product

- **Platform Portal** (`/platform`): view all tenant companies, manage subscriptions, see platform-wide analytics, user management
- **Admin Portal** (`/admin`): scan business cards (OCR simulation), manage contacts, qualify leads through Kanban pipeline, track events, manage team, view reports

## Demo credentials

| Role | Email | Password |
|---|---|---|
| Platform Owner | admin@cardscannerpro.com | Admin123! |
| Company Admin (TechCorp) | admin@techcorp.com | Admin123! |
| Company Admin (Nexus) | admin@nexussys.io | Admin123! |
| Company Admin (Innovatech) | admin@innovatech.es | Admin123! |

Quick demo login buttons are available on the login page.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Always run `pnpm --filter @workspace/api-spec run codegen` after editing `openapi.yaml`
- Run `pnpm --filter @workspace/db run push` after schema changes
- `??` and `||` mixed without parens fails esbuild — always wrap: `(a ?? b) || c`
- API routes must include full base path (`/api/...`) — the reverse proxy does NOT strip it
- Do NOT use `pnpm run dev` at workspace root — workflows handle port + env injection

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
