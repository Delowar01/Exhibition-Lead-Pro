# Localhost Development Guide

How to develop, run, and regression-test Lead Capture Pro (Card Scanner Pro)
entirely on a local machine — no Replit, no cloud deploys. Complements
[`LOCAL_AND_STAGING_RUNBOOK.md`](LOCAL_AND_STAGING_RUNBOOK.md) and the
authoritative env reference [`.env.example`](../.env.example); where this guide
and older docs disagree, the code is authoritative (first verified against the
export baseline `303bf40`; re-verified against the `develop` product line in
B24, 2026-10-02 — `develop` is where B9–B24 live, see `CLAUDE.md`).

## 1. Required software

| Tool | Version | Notes |
|---|---|---|
| Node.js | **24.13.0** (verified baseline) | ≥ 20 works; the export was verified on 24.13.0 |
| pnpm | **10.26.1** (pinned) | `packageManager` pin; root `preinstall` rejects npm/yarn |
| PostgreSQL | 14+ (verified on 16) | local server on `localhost:5432` |
| Chromium | any recent | only for Playwright — set `PW_CHROMIUM_PATH` to the binary |

## 2. Install

```bash
pnpm install --frozen-lockfile
```

## 3. Environment configuration

**No dotenv loader is bundled** — the apps read `process.env` directly, so
export variables in your shell (or a profile script you `source`). Never commit
real values.

Required (API refuses to boot without all three):

```bash
export DATABASE_URL="postgresql://<user>:<password>@localhost:5432/<dev-db>"
export SESSION_SECRET="$(openssl rand -hex 32)"
export PORT=8080        # per-app; see §5 (docs elsewhere say 5000 — see note)
```

> **PORT note:** `.env.example` shows `PORT=5000` as if it defaulted; in code
> (`artifacts/api-server/src/config.ts` `resolvePort()`) `PORT` is **required**.
> Use **8080** for the API locally: two test files bypass the gateway and call
> `http://localhost:${API_DIRECT_PORT ?? 8080}` directly.

Optional — correct localhost values:

- `TRUST_PROXY` — **leave unset** (default `1`) when running behind the dev
  gateway (§5); the gateway adds exactly one `X-Forwarded-For` hop, and the
  IP-policy tests depend on that topology. Only set `TRUST_PROXY=false` when
  exposing the API directly with no proxy at all (not the test topology).
- `CORS_ORIGINS` — leave unset: the dev default allows every origin.
- `AI_ENABLE_STUB` — leave unset: the deterministic stub AI provider is
  registered automatically outside production.
- `SMTP_*`, object-storage vars, `GEMINI_API_KEY`, `REPLIT_*` — leave unset
  for normal development: email becomes a logged no-op, uploads report
  "not configured", AI degrades gracefully, and nothing Replit-specific is
  needed (see §12).
- **`LOGIN_RATE_MAX` for a full API-suite run (Batch 23 Correction 1)** — the
  per-IP failed-login ceiling (`config.security.loginRateLimitMax`, default
  **20** failures per 15 minutes, failures only) is read **once by the API
  process at startup**. The full API suite deliberately performs several dozen
  failed logins from the single loopback IP (lockout, suspended-tenant,
  wrong-portal-host and MFA cases), so with the default every later login in
  the same run — including the demo logins of unrelated suites — gets 429 and
  those tests fail or skip. Before a full run, export a larger ceiling **in the
  shell that starts the API** (terminal 1 in §5), then start the API:

  ```bash
  export LOGIN_RATE_MAX=1000     # API shell only, local development only
  PORT=8080 pnpm --filter @workspace/api-server run dev
  ```

  Setting it in the vitest shell does nothing (the running API keeps the value
  it booted with). Do **not** set it on the hosted stack or in production —
  the default of 20 stays the deployed value, and
  `test/unit-login-rate-limit.test.ts` pins that default, the override, the
  failures-only accounting and the 429 after the ceiling in isolation. The
  per-account lockout (`LOGIN_MAX_ATTEMPTS`, `test/auth-security.test.ts`) and
  the forgot-password throttle (`FORGOT_PASSWORD_RATE_MAX`,
  `test/password-reset.test.ts`) are separate guards and keep their normal
  values and coverage.
- **Billing (Batch 20)** — leave `BILLING_PROVIDER` unset for plain manual
  billing. The B20 API suites (`test/b20-billing-stripe.test.ts`) and the
  Playwright billing spec (`e2e/x-billing.spec.ts`) require the deterministic
  offline provider — export, in the shell that runs the API **and** the one
  that runs the tests:

  ```bash
  export BILLING_PROVIDER=fake
  export STRIPE_WEBHOOK_SECRET="whsec_local_test_only_$(openssl rand -hex 16)"   # any value; never a real secret
  export BILLING_SELF_SERVICE_CHECKOUT=true
  export BILLING_RETURN_URL=http://localhost:80        # explicit localhost HTTP is accepted outside production
  # BILLING_STRIPE_MODE=test                            # optional; defaults to test outside production (fake = test only)
  ```

  No network is used: prices are synthesized from ids such as
  `price_fake_usd_2900_month`, Checkout/Portal URLs are local placeholders, and
  webhooks are signed offline. Never set a real `STRIPE_SECRET_KEY` locally.
  The repair command for existing rows is
  `pnpm --filter @workspace/api-server exec tsx scripts/repair-subscriptions.ts` (dry-run; add `--apply`).

## 4. Development database

Use an **isolated local database — never production, never customer data**.

```bash
# as a Postgres superuser (once):
createuser --pwprompt lcp_dev
createdb --owner lcp_dev leadcapture_dev

export DATABASE_URL="postgresql://lcp_dev:<password>@localhost:5432/leadcapture_dev"
pnpm --filter @workspace/db run push          # sync schema (drizzle-kit push; no SQL migrations)
pnpm --filter @workspace/scripts run seed-demo  # demo tenants for browsing (password Demo123!)
```

> Older docs say `pnpm --filter @workspace/db db:push` — the actual script name
> is `push`. `LOCAL_AND_STAGING_RUNBOOK.md` §1.5 predates `seed-demo` and says
> no seed script exists; `scripts/src/seed-demo.ts` is real.

### Test-suite verification accounts (required before running the API/e2e suites)

The API and Playwright suites authenticate as three pre-existing accounts that
**no repo script creates** (they were retained in the original dev database —
see `EXPORT_PACKAGE_INFO.md` "Manual post-export actions"):

| Account | Password | Role | Constraint |
|---|---|---|---|
| `admin@cardscannerpro.com` | `Admin123!` | `platform_owner` | — |
| `admin@techcorp.com` | `Admin123!` | `primary_admin` | its company **must be company id 2** |
| `admin@nexussys.io` | `Admin123!` | `primary_admin` | its company **must be company id 3** |

`test/tenant-isolation-matrix.test.ts` hardcodes `A_CID = 2` and discovers
"seeded tenant-A" rows by querying company 2 directly, so on a **fresh, empty**
database create, in order: the platform company (+owner), TechCorp (+admin),
Nexus (+admin) — then give TechCorp at least one row each of: contact, lead,
event, follow-up, document (with one version), scan, team, department, and
organization. Give TechCorp/Nexus generous subscription limits (the suites
create hundreds of rows). Insert via `@workspace/db` the way
`scripts/src/seed-demo.ts` does, or via the API as the TechCorp admin.

## 5. Running the stack (three processes)

The web client calls the API via **relative `/api` paths** and both test suites
target `http://localhost:80`, so web + API must share one origin — the same
role the Replit gateway / self-host nginx plays. Use the bundled dev gateway:

```bash
# terminal 1 — API (in-process workers + schedulers start automatically)
export LOGIN_RATE_MAX=1000     # only when the full API suite will run against this process (§3)
PORT=8080 pnpm --filter @workspace/api-server run dev

# terminal 2 — web dev server (HMR)
PORT=3000 BASE_PATH=/ pnpm --filter @workspace/web-app run dev

# terminal 3 — same-origin gateway on :80  (/api/* → :8080, else → :3000)
pnpm --filter @workspace/scripts run dev-gateway
```

Gateway overrides: `GATEWAY_PORT`, `API_UPSTREAM`, `WEB_UPSTREAM`. On Linux,
binding port 80 needs root or `CAP_NET_BIND_SERVICE`; on Windows, an elevated
terminal.

Verify:

```bash
curl http://localhost:80/api/healthz   # {"status":"ok"}
curl http://localhost:80/api/readyz    # database "ok"; storage "ok" with the fs (or memory) driver — see below
# browser: http://localhost:80 → login page; demo login buttons appear in dev builds
```

### Object storage (B25 — filesystem driver, no Google Cloud)

Product files (documents, exports, reports, scan images, logos) are stored
**encrypted** under a private directory outside the repository. For a full
test run export the same three values in the **API shell and the test shell**
(`test/b25-storage.test.ts` asserts on-disk effects):

```bash
sudo install -d -m 700 -o "$USER" /var/lib/lcp-objects-dev     # any absolute dir OUTSIDE the repo / web roots
export OBJECT_STORAGE_DRIVER=fs
export OBJECT_STORAGE_FS_ROOT=/var/lib/lcp-objects-dev
export OBJECT_STORAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)    # keep it for the life of that directory (never commit it)
pnpm --filter @workspace/db run push                            # adds storage_objects (verify the dev DB first)
```

`readyz` then reports `storage: "ok"` (the probe writes/reads/deletes one object
under `health/`). With **no** `OBJECT_STORAGE_*` and no bucket the API uses the
in-process memory driver outside production: uploads work for one process and
nothing survives a restart (enough for the formerly storage-gated suites, not
for the B25 suite). Never point a local run at the hosted bucket; the Google
variables in `.env.example` §1d exist only for the temporary legacy driver.
Private file bytes (`/api/files/...`) require the normal session: there is no
credential in any URL (B25 Correction 1), so a hand-written client must send
`Authorization: Bearer …` on downloads and additionally the `X-Storage-Capability`
header (the `uploadToken` from `/documents/upload-url`) on uploads — see
`test/documents.test.ts` `uploadFile` for the exact flow. Details and the
hosted plan: `docs/B25_OBJECT_STORAGE.md`.

## 6. Mobile app (Expo)

```bash
cd artifacts/mobile
PORT=8081 EXPO_PUBLIC_API_URL="http://<YOUR-LAN-IP>:8080" pnpm exec expo start --lan --port 8081
```

- The package's `dev` script interpolates Replit variables (they expand empty
  off-Replit) and uses `--localhost`; for a physical device prefer the direct
  `expo start --lan` above.
- `EXPO_PUBLIC_API_URL` must be the **computer's LAN IPv4** (pattern
  `http://<LAN-IP>:<API-PORT>`, e.g. `http://192.168.1.20:8080`) — a physical
  phone cannot reach your `localhost`. Point it at the API port directly.
- Camera/NFC/push need an Expo **dev-client or EAS build** — not Expo Go. Do
  not build APKs during normal development.

### Windows: LAN access & firewall (documented — verify on the Windows machine)

1. `ipconfig` → note the IPv4 address of the active adapter.
2. Allow inbound connections to the API port once, in an elevated PowerShell:
   ```powershell
   New-NetFirewallRule -DisplayName "LeadCapturePro dev API" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 -Profile Private
   ```
3. Phone and computer must be on the same Wi-Fi network, and the network
   profile should be **Private**.
4. Do **not** port-forward or otherwise expose the development API to the
   internet.

## 7. Typechecks, tests, builds — expected baseline

```bash
pnpm run typecheck                              # whole workspace incl. mockup-sandbox — exit 0 (B24)
pnpm --filter @workspace/api-server run test    # fully green with the fs object-storage driver (§5; see note)
pnpm --filter @workspace/web-app run test:e2e   # needs the Batch 20 billing env, §3
pnpm --filter @workspace/mobile run test
pnpm --filter @workspace/api-server run build   # PASS → dist/index.mjs
pnpm --filter @workspace/web-app run build      # PASS → dist/public (env-free)
```

**Authoritative baseline — this section is the single place the totals are
maintained** (other documents point here; `docs/reports/` are archived
point-in-time reports and keep their historical counts).

| Suite | B25 Correction 3 run (2026-10-02, fs object-storage driver, no Google Cloud credentials) | B25 Correction 2 run (2026-10-02, fs driver) | B25 Correction 1 run (2026-10-02, fs driver) |
|---|---|---|---|
| API (`vitest run`, once, API started with `LOGIN_RATE_MAX=1000`, `JOBS_DRIVER=postgres` and the fs driver) | **1466 passed / 0 failed / 1 skipped of 1467 (98 files)** | 1448 passed / 0 failed / 1 skipped of 1449 (95 files) | 1409 passed / 0 failed / 1 skipped of 1410 (88 files) |
| Playwright (`playwright test`, chromium, fresh stack) | **152/152** | 152/152 | 152/152 |
| Mobile (`vitest run`) | **114/114** | 114/114 | 114/114 |
| Typechecks (libs, api, web, mobile, scripts, pitch-deck, mockup-sandbox; root `pnpm run typecheck`) | **all exit 0** | all exit 0 | all exit 0 |
| API / web production builds | **PASS** | PASS | PASS |

Earlier references: B25 Phase 1 run (2026-10-02, fs driver) API 1368 passed / 0 failed / 1 skipped of 1369 (82 files); B24 run (2026-10-02, no object storage) API 1248 passed / 9 documented storage-gated failures / 28 skipped of 1285, Playwright 152/152, mobile 114/114; B23 Correction 1 (2026-09-18) API 1234 passed / 9 failed / 28 skipped of 1271, root typecheck failed in `mockup-sandbox` (fixed in B24). The 41 tests added by B25 Correction 1 (`b25c1-service` 14, `b25c1-migration` 6, `b25c1-concurrency` 6, `b25c1-scans` 4, `b25c1-files-auth` 6, `unit-files-log-redaction` 4, plus one concurrent-PUT case in `b25-storage`) the 39 added by Correction 2 (`b25c2-lease-fencing` 8, `b25c2-gcs-generations` 7, `b25c2-files-lifecycle` 6, `b25c2-integrity` 5, `b25c2-migration-readonly` 3, `b25c2-company-deletion` 3, `b25c2-log-sanitization` 7) and the 18 added by Correction 3 (`b25c3-durable-cleanup` 7, `b25c3-gcs-ownership` 5, `b25c3-log-containment` 6) were red against the respective previous head before the fix.

> **No storage-gated subset any more (B25):** the 27 formerly GCS-gated tests
> (`documents.test.ts` 24, `ocr-pipeline` stored-image reprocess,
> `executive-intelligence` 2 report exports) run green on the filesystem
> driver; storage failures are fixed by configuration (§5), never by skipping.
> **Every remaining skip is intentional and classified:** `b9-reports-exports.test.ts` › on-demand exports › "without object storage (degraded, environment-gated) › fails safely: 502 response and a recorded failed run" — the deliberate mirror of the with-storage branches (`describe.runIf(!STORAGE)` vs `describe.runIf(STORAGE)`): exactly one side runs depending on `readyz.checks.storage`, and with storage configured the degraded branch is the one that skips. The only other conditional skips in the suite (`b22c1-ocr-unconfigured.test.ts`, `ctx.skip` when the running API holds a live Gemini credential) do not trigger in the normal stub-provider run; the B24 durable `/metrics` assertion and the former document / report / scan storage skips no longer skip because `JOBS_DRIVER=postgres` and the fs driver are exported in both shells.
>
> **Durable `/metrics` assertion (B24):** `test/b24-metrics-pending.test.ts`
> proves the live pending count against the real `job_queue` table with its own
> durable queue instance regardless of the API's driver; its one HTTP-level
> durable assertion runs only when `JOBS_DRIVER=postgres` is exported in the
> vitest shell **and** the API was started with `JOBS_DRIVER=postgres` +
> `JOBS_PAYLOAD_ENCRYPTION_KEY` (the hosted configuration); otherwise that
> single test skips with an explicit reason.

**API suite rules** (`artifacts/api-server/vitest.config.ts`): it is an
integration suite against the **live** API at `http://localhost:80/api` — the
full stack (§5) must be up, and the vitest process itself needs `DATABASE_URL`
and `SESSION_SECRET` exported. The login rate limiter is **stateful in the
server process** and its ceiling is fixed at API startup: start (or restart)
the API with `LOGIN_RATE_MAX=1000` exported in **its** shell (§3), then run the
suite **exactly once**; a second run against the same process, or a run against
an API started with the default ceiling of 20, yields spurious 429s (the suite's
own intentional failed logins exhaust the per-IP budget mid-run).

**Playwright** (`artifacts/web-app/playwright.config.ts`): needs the stack up,
`DATABASE_URL` exported (global-setup talks to Postgres directly), and — off
NixOS — `PW_CHROMIUM_PATH=/path/to/chrome`. Target override: `E2E_BASE_URL`
(default `http://localhost:80`).

**Mobile suite**: pure unit tests, no server or DB needed.

## 8. AI during development — stub vs live Gemini

- Normal runs never call live Gemini. The deterministic **stub provider**
  (`src/ai/providers/stub.ts`) registers automatically when
  `NODE_ENV !== "production"`; a tenant opts in via
  `PATCH /api/ai/settings {"provider":"stub","model":"stub-model"}` (the test
  suites do this themselves). Failure modes: `stub-fail`, `stub-timeout`, etc.
- **Controlled real-Gemini verification** (opt-in, deliberate):
  set `GEMINI_API_KEY`, then run
  `pnpm --filter @workspace/api-server exec tsx scripts/verify-ocr-live.ts`.
  Never wire live Gemini into the normal suites.

## 9. Safe restart

```bash
# stop: Ctrl-C each process (or kill the node processes)
# start again in order: API → web → gateway (web/gateway have no state)
# after schema edits: pnpm --filter @workspace/db run push, then restart the API
# ALWAYS restart the API before an API test run (rate-limiter state), with
# LOGIN_RATE_MAX=1000 exported in the API shell for a full-suite run (§3)
```

## 10. Common errors

| Symptom | Cause / fix |
|---|---|
| API exits: `PORT ... not set` | `PORT` is required — export it (`resolvePort()` throws) |
| API exits: `SESSION_SECRET is not set` / `DATABASE_URL must be set` | export both before starting |
| Web dev server exits immediately | the **dev server** (not build) requires `PORT` and `BASE_PATH` |
| Tests: many 401s "login failed" | verification accounts missing — §4 |
| Tests: `no seeded tenant-A row for <resource>` | TechCorp is not company id 2, or fixture rows missing — §4 |
| Tests: spurious 429s (`expected 429 to be 200`, suites skipped after "login failed … 429") | API served a previous run, or was started with the default `LOGIN_RATE_MAX=20` — restart it with `LOGIN_RATE_MAX=1000` in the API shell (§3), run once |
| Playwright: browser launch error | set `PW_CHROMIUM_PATH` to a real Chromium binary |
| Uploads answer 503, `readyz` storage `not_configured` | only with `OBJECT_STORAGE_DRIVER=none` (or production without configuration) — set the fs driver (§5); `storage: "error"` with the fs driver means an unusable root (not absolute, inside the repo, a symlink, wrong owner) or a missing/invalid `OBJECT_STORAGE_ENCRYPTION_KEY` — the API log names the reason without printing paths or keys |
| Email "skipped (not configured)" | expected without `SMTP_*`; honest no-op |
| `EADDRINUSE` on :80 | another gateway/process on port 80, or missing privilege to bind 80 |
| Playwright: every test times out in `page.goto` waiting for `load`, though the page renders | Restricted-network environments only (containers/CI without direct internet): the app's Google-Fonts stylesheets (`index.html`, `src/index.css`) hang, and Chromium on Linux also honors `http_proxy`/`https_proxy` env with nondeterministic timing. Fix: run the suite with proxy env unset (`env -u HTTP_PROXY -u HTTPS_PROXY …`) and, if there is no direct egress, blackhole `fonts.googleapis.com`/`fonts.gstatic.com` to `127.0.0.1` in `/etc/hosts` so they fail instantly. Normal machines with direct internet are unaffected |

## 11. What runs where

| Concern | URL |
|---|---|
| Web app (through gateway) | `http://localhost:80` |
| API (through gateway) | `http://localhost:80/api` |
| API direct | `http://localhost:8080/api` |
| Web dev server direct (HMR) | `http://localhost:3000` |
| Physical device → API | `http://<LAN-IP>:8080` |

## 12. Verifying there is no Replit runtime dependency

1. Start the API with **no** `REPL_ID`/`REPLIT_*` variables → boots clean;
   `healthz`/`readyz` OK (storage `not_configured` only).
2. `grep -rn "REPLIT_\|REPL_ID" artifacts/api-server/src lib` — every consumer
   is optional-with-fallback (`config.ts` `APP_BASE_URL` fallback,
   `objectStorage.ts` sidecar detection, `cards.ts` public-URL fallback).
3. The web `vite.config.ts` loads `@replit/*` dev plugins only when `REPL_ID`
   is set. The only genuinely Replit-shaped requirement is in
   `artifacts/mobile/scripts/build.js` (mobile web export), which needs
   `EXPO_PUBLIC_DOMAIN` as the portable escape hatch — irrelevant to API/web
   development and tests.
