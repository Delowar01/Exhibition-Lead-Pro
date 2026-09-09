# CLAUDE.md — Lead Capture Pro (Card Scanner Pro)

Persistent rules for AI-assisted development. The product ships under two names:
the codebase says **Card Scanner Pro**, the product direction says **Lead Capture
Pro** — same system.

## Product

Enterprise multi-tenant B2B SaaS for lead capture: AI-assisted business-card
scanning (camera OCR, QR, LinkedIn QR, email-signature paste, NFC, manual),
contacts/leads CRM with Kanban pipeline, events, follow-ups, tasks, documents,
notifications, reports/exports, and AI sales workflows. Two web portals —
Platform Owner (`/platform`) and Company Admin (`/admin`) — plus an Expo mobile
field-capture client (EN/AR with RTL, light/dark).

## Official baseline & source of truth

- **GitHub is the permanent source of truth**: `Delowar01/Exhibition-Lead-Pro`.
- **Baseline branch: `export-ready`** at commit `303bf40f4747ef0626090afbda35d8c3b36870ac`.
- The old `main` branch is an outdated historical version. **Never** develop
  from `main`, merge `main`, rebase onto `main`, force-push, or rewrite history.
- Every development branch is created from the latest approved baseline
  (`export-ready`). **Never push feature work directly to `export-ready` or
  `main`** — one branch per approved batch (e.g. `claude/batch-09-reports`).
- Docs of record: `docs/PROJECT_TECHNICAL_BRIEF.md` (architecture),
  `docs/PROJECT_FILE_MAP.md`, `.env.example` (environment contract),
  `docs/LOCALHOST_DEVELOPMENT.md` (local workflow),
  `docs/LOCAL_AND_STAGING_RUNBOOK.md`, `docs/PORTABLE_ENVIRONMENT_SETUP.md`,
  `replit.md` (operational summary). **When docs and code disagree, the code
  is authoritative** — report the contradiction, don't silently "fix" it.

## Monorepo (pnpm workspaces, Node 24, TS 5.9)

- `artifacts/api-server` — Express 5 API (`/api/v1`), route → service →
  repository; in-process job queue + schedulers start with the server.
- `artifacts/web-app` — React 19 + Vite + shadcn admin/platform portal
  (calls the API via **relative `/api` paths** — same origin required).
- `artifacts/mobile` — Expo Router field client.
- `lib/db` — Drizzle schema + pool (the only DB access layer; schema sync is
  `pnpm --filter @workspace/db run push`, **no versioned SQL migrations**).
- `lib/api-spec` — OpenAPI source of truth → Orval codegen
  (`lib/api-zod`, `lib/api-client-react`). Contract-first: spec → codegen →
  server validates with generated Zod.
- `lib/integrations-gemini-ai` — lazy Gemini SDK wrapper. `scripts` — utilities
  (seed-demo, dev-gateway).
- All API `process.env` reads go through `artifacts/api-server/src/config.ts`.

## Security invariants (never weaken)

- `company_id` is the **sole tenant boundary**. Never scope a tenant read by
  `companyId` alone — always `tenantScope(user, column)`
  (`src/middlewares/requireAuth.ts`). Cross-tenant access returns **404, not 403**.
- FK references on writes are validated with `refAccessible` (caller-scoped) or
  `refInCompany` (target-tenant-scoped) from `src/lib/tenant.ts`.
- **Platform Owner firewall**: `platform_owner` manages the platform but must
  NOT reach tenant CRM data through ordinary tenant routes — `requireTenantUser`
  403s platform operators on every tenant CRM module. It is a terminating,
  **path-scoped** guard (`router.use("/contacts", requireTenantUser)`) — never
  mount it path-less on the shared parent router.
- Roles: `platform_owner → primary_admin → admin → employee`.
  `platform_owner`/`primary_admin` bypass the write-permission matrix;
  `admin`/`employee` are gated on writes (empty `{}` = deny-by-default).
  No role escalation via POST/PATCH `/users`.
- `requireAuth` loads the fresh user row every request (never trust JWT
  payload for role/permissions) and requires a live server-side session.
- Never use production customer data for development or testing.

## AI rules

- **Google Gemini 2.5 Flash is the ONLY approved AI provider/model.**
- Every AI call goes through the **Enterprise AI Layer**
  (`artifacts/api-server/src/ai/`): settings/budget gates, reservation-based
  budget admission, rate limiting, dedup, provider call, append-only
  `ai_invocations` ledger. Never bypass it; never call Gemini from frontends.
- No second AI system, OCR system, email system, or AI-draft system — extend
  the existing single seam.
- AI recommends/drafts only: **never auto-execute, never auto-send AI-generated
  communications, never write the source CRM unattended**. A contact is never
  auto-created just because OCR completed — human review + explicit save.
- Never store prompt/response content in usage analytics; keep provenance
  honest (deterministic output never masquerades as AI).
- Normal tests use the deterministic **stub provider** (registered only outside
  production; tenants opt in via `PATCH /ai/settings {provider:"stub"}`).
  **Never call live Gemini in normal test runs** — live OCR verification is the
  opt-in `artifacts/api-server/scripts/verify-ocr-live.ts` only.

## Mobile scope (permanent)

- Bottom tabs: Home, Scan, Contacts, Follow-Ups, More (Pipeline and
  Notifications live inside More; Home header has the notification bell).
- Mobile Contact Workspace = Overview, Timeline, Documents only, plus sticky
  Call/WhatsApp/Email/Website quick actions. **No Contact AI on mobile.**
- **Keep NFC** (and every other capture mode).
- Permanently excluded from mobile: full administration, AI Command Center,
  Workflow Intelligence, Executive Intelligence. The mobile **AI Assistant is
  retained**.

## Permanently removed scope (do not reintroduce, do not count as pending)

Customer Portal · Custom Domains · Public Developer Platform · Generic
Integration Marketplace · full mobile administration · mobile AI Command
Center / Workflow Intelligence / Executive Intelligence.

## Working rules

- **Work one approved batch at a time**; wait for explicit approval before the
  next. Do not add unnecessary features, modules, tables, providers,
  infrastructure, abstractions, or phases.
- Never claim provider, production, or device verification unless actually
  performed (last device pass: Honor Magic V5, Android 16).
- Batches 1–8 are complete and device-verified. **Next approved batch:
  Batch 9 — Reports and Export Center Completion** (do not start without
  approval).

## Localhost workflow (details: docs/LOCALHOST_DEVELOPMENT.md)

Development happens on localhost (not Replit), against an isolated dev
Postgres — never production. A hosted **development environment** exists at
`https://dev.kaptnow.com`: pushes to `develop` auto-deploy the Docker stack
to the Hostinger VPS via GitHub Actions (`.github/workflows/deploy-dev-vps.yml`
→ `docker/scripts/deploy-vps.sh`, web bound to `127.0.0.1:18080` behind
CloudPanel — see docs/HOSTINGER_VPS_DEPLOYMENT.md). Only `develop` deploys;
never deploy `export-ready`/`main`/feature branches, and never store app
runtime secrets in GitHub. The web app and API must share one
origin: run the dev gateway on **:80** (`/api/*` → API on **:8080**, everything
else → web dev server on **:3000**); the test suites hard-code
`http://localhost:80`.

```bash
pnpm install
pnpm --filter @workspace/db run push          # schema sync (verify dev DB first!)
pnpm --filter @workspace/scripts run seed-demo
PORT=8080 pnpm --filter @workspace/api-server run dev
PORT=3000 BASE_PATH=/ pnpm --filter @workspace/web-app run dev
pnpm --filter @workspace/scripts run dev-gateway
```

Required env: `DATABASE_URL`, `SESSION_SECRET`, `PORT` (no dotenv loader is
bundled — export in the shell). Leave `TRUST_PROXY` at its default (`1`) behind
the dev gateway. SMTP/GCS/Gemini unset = graceful degradation (no real email,
uploads report "not configured", AI uses the stub).

## Tests & expected baseline

```bash
pnpm run typecheck                                  # all packages — PASS
pnpm --filter @workspace/api-server run test        # 1153 tests (restart API first, run ONCE)
pnpm --filter @workspace/web-app run test:e2e       # 142/142 (stack running; set PW_CHROMIUM_PATH)
pnpm --filter @workspace/mobile run test            # 114/114
pnpm --filter @workspace/api-server run build       # PASS
pnpm --filter @workspace/web-app run build          # PASS
```

Without GCS object-storage credentials the API suite reports **1116 passed /
9 failed / 28 skipped** — the failures are exactly the documented storage-gated
set (documents.test.ts 6 failed + 18 skipped, ocr-pipeline 1, executive-
intelligence 2); everything else must be green. The B20 billing suites and the
Playwright billing spec need `BILLING_PROVIDER=fake` + `STRIPE_WEBHOOK_SECRET`
(any local value) + `BILLING_SELF_SERVICE_CHECKOUT=true` in the API and test
shells. Details: `docs/LOCALHOST_DEVELOPMENT.md` §3, §7.

The API suite is integration-against-live-API: the login rate limiter is
stateful, so **restart the API server before the suite and run it exactly
once**. Playwright needs the gateway + web + API up and logs in as the demo
accounts. Normal test runs must never call live Gemini, send real email, touch
production, build an APK, or deploy.
