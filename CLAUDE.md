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
- **Branch model (reconciled in B24, 2026-10-02):**
  - `develop` — the **product integration line** and the **only application
    auto-deploy source** (`.github/workflows/deploy-dev-vps.yml` → Hostinger
    dev VPS). B9–B23 and every later batch live here. Every batch branch is
    created from `origin/develop` (`claude/b<nn>-<topic>`), reviewed, then
    merged to `develop`.
  - `export-ready` — the **GitHub default branch** and the **backup-alert
    line**: the August 2026 export baseline (`303bf40…`, localhost docs
    `283b15e…`) plus the external backup-health workflow (B23 G-6 C3/C3B/C3C,
    head `7cae8f9…`). It is **not** the current product source — it does not
    carry B9–B23. Scheduled workflows run from it. Do not branch product
    work from it.
  - `main` — unrelated historical history (June 2026, no common commit with
    `develop`). **Never** develop from `main`, merge `main`, rebase onto
    `main`, force-push, or rewrite history.
  - The two lines diverge (merge base `283b15e…`: the four backup-alert
    commits exist only on `export-ready`, the product only on `develop`).
    **Branch-line reconciliation is a later, owner-approved task** — never
    merge either way inside a product batch. **Never push feature work
    directly to `develop`, `export-ready` or `main`.**
- Docs of record (living): `docs/PROJECT_TECHNICAL_BRIEF.md` (architecture
  and status), `docs/PROJECT_FILE_MAP.md`, `.env.example` (environment
  contract), `docs/LOCALHOST_DEVELOPMENT.md` (local workflow and the **single
  authoritative test baseline**), `docs/HOSTINGER_VPS_DEPLOYMENT.md` (hosted
  dev stack), `docs/BACKUP_AND_RECOVERY.md`, `docs/B23_FINAL_RECONCILIATION.md`
  (gap register with its B24 status addendum), `replit.md` (operational
  summary). `docs/LOCAL_AND_STAGING_RUNBOOK.md` and
  `docs/PORTABLE_ENVIRONMENT_SETUP.md` are the export-era references; files
  under `docs/reports/` are archived point-in-time reports and are not
  rewritten. **When docs and code disagree, the code is authoritative** —
  report the contradiction, don't silently "fix" it.

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
- Batches 1–8 are complete and device-verified; **B9–B23 are complete,
  merged to `develop` and deployed to the hosted dev stack**
  (`docs/B23_FINAL_RECONCILIATION.md`). **Current batch: B24 — Release-Gate
  Closure** (live `/metrics` pending count, workspace typecheck, audit-retention
  contract, documentation of record). **Planned next: B25 — product object
  storage off Google Cloud** (owner decision: *Option B — remove Google Cloud
  completely*; not started; proceeds without the second backup VPS).
  Feature items G-4 / G-7 / G-8 await owner decisions and are not approved
  batches. Do not start B25 or any feature batch without approval.
- B23 G-6D Hostinger off-host backup: CODE COMPLETE — ACTIVATION DEFERRED BY OWNER. Frozen on
  `claude/b23-g6d-hostinger-only` at `e82e5cb7767d7ac3ee47c919fcf711a52fe229ab`;
  do not amend, rebase, merge, activate or dispatch it. The off-host deferral is not a blocker for product development, testing, B24, B25, or later feature batches.

## Localhost workflow (details: docs/LOCALHOST_DEVELOPMENT.md)

Development happens on localhost (not Replit), against an isolated dev
Postgres — never production. A hosted **development environment** exists at
`https://dev.kaptnow.com`: pushes to `develop` auto-deploy the Docker stack
to the Hostinger VPS via GitHub Actions (`.github/workflows/deploy-dev-vps.yml`
→ `docker/scripts/deploy-vps.sh`, web bound to `127.0.0.1:18080` behind
CloudPanel — see docs/HOSTINGER_VPS_DEPLOYMENT.md). Only `develop` deploys;
never deploy `export-ready`/`main`/feature branches, and never store app
runtime secrets in GitHub. The hosted stack runs the **durable PostgreSQL
job queue** (`JOBS_DRIVER=postgres`); locally the default is `in-process` —
export `JOBS_DRIVER=postgres` and a local `JOBS_PAYLOAD_ENCRYPTION_KEY` in
the API **and** test shells to exercise the durable `/metrics` assertion
(without it that one B24 test skips with an explicit reason). The web app
and API must share one
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
pnpm run typecheck                                  # whole workspace incl. mockup-sandbox — exit 0 (B24)
pnpm --filter @workspace/api-server run test        # restart the API first with LOGIN_RATE_MAX=1000 in the API shell, run ONCE
pnpm --filter @workspace/web-app run test:e2e       # stack running; set PW_CHROMIUM_PATH
pnpm --filter @workspace/mobile run test
pnpm --filter @workspace/api-server run build       # PASS
pnpm --filter @workspace/web-app run build          # PASS
```

**Authoritative baseline (B24 run, 2026-10-02, no object-storage
credentials):** API **1248 passed / 9 documented storage-gated failures / 28 skipped of 1285**, Playwright **152/152**, mobile
**114/114**. The API failures are exactly the documented storage-gated
set (documents.test.ts 6 failed + 18 skipped, ocr-pipeline 1,
executive-intelligence 2); everything else must be green. Pre-B24 reference
(B23 Correction 1): 1234 passed / 9 / 28 of 1271, 152/152, 114/114. The B20
billing suites and the Playwright billing spec need `BILLING_PROVIDER=fake` +
`STRIPE_WEBHOOK_SECRET` (any local value) + `BILLING_SELF_SERVICE_CHECKOUT=true`
in the API and test shells. `docs/LOCALHOST_DEVELOPMENT.md` §7 is the single
place where these totals are maintained; other documents point there.

The API suite is integration-against-live-API: the login rate limiter is
stateful, so **restart the API server before the suite and run it exactly
once**. Playwright needs the gateway + web + API up and logs in as the demo
accounts. Normal test runs must never call live Gemini, send real email, touch
production, build an APK, or deploy.
