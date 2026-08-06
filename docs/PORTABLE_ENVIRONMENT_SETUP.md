# Portable Environment Setup — Exact Post-Export Replacement Map

Project: **Card Scanner Pro** (spec name: *Lead Capture Pro*) · Date: 2026-08-06 · Scope: everything that must be **configured or replaced** after exporting this repository out of Replit.

This is the spec §4 replacement map. It complements — and does not duplicate — the authoritative variable reference in [`.env.example`](../.env.example) (read that for the full list, required-vs-optional markers, and placeholder values) and the audit narrative in [`docs/SECRET_AND_PORTABILITY_AUDIT.md`](./SECRET_AND_PORTABILITY_AUDIT.md).

Line numbers are current as of the date above and **may drift**; each row also gives a **stable symbol/key** so the target is findable even after the line moves. No real secret value appears anywhere in this document.

Legend for the **Environment** column: `local` = developer machine · `staging` = the published Replit host · `prod` = self-hosted / other host · `build` = compile/bundle time · `web`/`mobile`/`api` = which package. "All" means every runtime environment.

---

## 0. How to use this document

1. Copy `.env.example` to a real `.env` (or your host/CI secret store — the apps read `process.env` directly, no dotenv loader is bundled) and fill in real values for the **required** rows in §1.
2. Work through the tables below top to bottom. Rows marked **hardcoded** live in tracked source/config and must be edited in place before you build a client under a different account or host; rows marked **env** need only an environment variable.
3. Run each row's verification command/procedure to confirm the change took effect.

Two categories exist:

- **A. Environment variables** — set them; no source edit needed (§1).
- **B. Hardcoded / account-specific values** — must be edited in a tracked file when you leave the Replit staging account (§2).

---

## 1. Environment-variable configuration (no source edit)

### 1.1 Required to boot the API — the server refuses to start without these

| Package/module | File | Line | Symbol/key | Current behavior | Env var | Environment | Why required | Verification |
|---|---:|---|---|---|---|---|---|---|
| shared db | `lib/db/src/index.ts` | 7–13 | `pool` / `new Pool({ connectionString })` | Module throws `"DATABASE_URL must be set…"` at import if unset | **`DATABASE_URL`** | all · api · build (drizzle) | DB connection for API + `drizzle-kit push` | `node -e "if(!process.env.DATABASE_URL)process.exit(1)"` then `pnpm --filter @workspace/db db:push` connects without the throw |
| api config | `artifacts/api-server/src/config.ts` | 53 | `config.sessionSecret` / `requireEnv("SESSION_SECRET")` | Throws `Required environment variable SESSION_SECRET is not set…` at module load | **`SESSION_SECRET`** | all · api | Signs/verifies JWT access + refresh tokens; also derives MFA key when `MFA_ENCRYPTION_KEY` unset | Generate: `openssl rand -hex 32`. Confirm boot: `SESSION_SECRET=$(openssl rand -hex 32) DATABASE_URL=... PORT=5000 pnpm --filter @workspace/api-server start` logs `Server listening` |
| api entrypoint | `artifacts/api-server/src/index.ts` | 8 (`config.port`) → `config.ts` 23–35 (`resolvePort`) | `config.port` | `resolvePort()` throws if `PORT` unset/invalid | **`PORT`** | all · api | HTTP listen port | `PORT=5000 … start` → log line `{ port: 5000 } Server listening` |

**`SESSION_SECRET` replace-from → replace-to:** `.env.example` line 28 ships the placeholder `replace-with-64-hex-chars-from-openssl-rand-hex-32`; replace it with the output of `openssl rand -hex 32`. Never reuse the placeholder.

### 1.2 Auth / MFA (optional hardening)

| Package/module | File | Line | Symbol/key | Current behavior | Env var | Environment | Why change | Verification |
|---|---:|---|---|---|---|---|---|---|
| api config | `artifacts/api-server/src/config.ts` | 69 | `config.auth.mfaEncryptionKey` | Optional; when unset MFA-secret encryption is **derived from `SESSION_SECRET`** | `MFA_ENCRYPTION_KEY` | prod · api | Dedicated key isolates MFA-secret encryption from the token-signing secret so rotating one doesn't invalidate the other | Generate: `openssl rand -hex 32`. Set it, restart, confirm existing TOTP logins still verify |

### 1.3 Email links base URL — production warning if unset

| Package/module | File | Line | Symbol/key | Current behavior | Env var | Environment | Why change | Verification |
|---|---:|---|---|---|---|---|---|---|
| api config | `artifacts/api-server/src/config.ts` | 274–276 | `config.email.appBaseUrl` | Resolves `APP_BASE_URL` → else first `REPLIT_DOMAINS` entry → else `http://localhost:5000` | `APP_BASE_URL` | prod · api | Builds absolute reset / invitation / verification links in outgoing email | See warning below |
| email service | `artifacts/api-server/src/lib/email/index.ts` | 38–47 | `getEmailProvider()` misconfiguration guard | When email **is** configured, `NODE_ENV=production`, and `appBaseUrl` contains `localhost`, logs a warning that links point at localhost | `APP_BASE_URL` | prod · api | Prevents shipping localhost links in real mail | `NODE_ENV=production SMTP_HOST=… (no APP_BASE_URL) … start` → warning is logged; set `APP_BASE_URL=https://app.example.com`, restart → warning gone |

- **Replace from:** unset (falls back to `REPLIT_DOMAINS` first entry on staging, else `http://localhost:5000`).
- **Replace to:** `APP_BASE_URL=https://<your-web-app-host>` (the **web app** public URL, not the API).

### 1.4 Gemini AI — direct key vs. Replit integration pair

Two mutually exclusive credential modes, resolved in `lib/integrations-gemini-ai/src/client.ts` `resolveCredentials()` (lines 9–16) and surfaced through `config.ai.gemini` (`config.ts` 117–121). The Replit proxy pair **takes precedence** when both are present. Unconfigured ⇒ server still boots; AI features degrade behind `isGeminiConfigured()`.

| Mode | File | Line | Symbol/key | Env var(s) | Environment | Notes | Verification |
|---|---|---:|---|---|---|---|---|
| Portable (self-hosted) | `lib/integrations-gemini-ai/src/client.ts` | 13 | `resolveCredentials()` — `directKey` | **`GEMINI_API_KEY`** | prod/local · api | Direct Google Gemini API key from aistudio.google.com; SDK default endpoint (no base-URL override) | Set it; `node -e` importing `isGeminiConfigured()` returns `true`; a scan/insight call reaches Gemini |
| Replit AI integration (staging) | `lib/integrations-gemini-ai/src/client.ts` | 10–12 | `resolveCredentials()` — `proxyKey`+`proxyUrl` | `AI_INTEGRATIONS_GEMINI_API_KEY` **+** `AI_INTEGRATIONS_GEMINI_BASE_URL` | staging · api | Provided automatically by the Replit Gemini integration; **do not set manually off Replit** | Present on Replit only; leave unset elsewhere |

- **Replace from (leaving Replit):** rely on `AI_INTEGRATIONS_GEMINI_*` (auto-injected on Replit).
- **Replace to:** set `GEMINI_API_KEY` only; leave both `AI_INTEGRATIONS_GEMINI_*` unset so the direct key is used.
- The same lazy client backs image generation via `lib/integrations-gemini-ai/src/image/client.ts` (line 2, re-exports `ai`) — no separate credential.

### 1.5 Object storage (Google Cloud Storage) — layout + credentials + auth mode

Layout keys read in `config.ts` 244–248 (`config.objectStorage`); auth mode selected in `artifacts/api-server/src/lib/objectStorage.ts` `shouldUseReplitSidecar()` (lines 26–31). Unconfigured ⇒ server boots; uploads/downloads throw a clear "not set" error and everything else works.

| Package/module | File | Line | Symbol/key | Current behavior | Env var | Environment | Verification |
|---|---:|---|---|---|---|---|---|
| api config | `config.ts` | 245 | `config.objectStorage.bucketId` | `DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? ""` | `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | prod · api | Set to your GCS bucket id; upload flow no longer errors |
| api config | `config.ts` | 246 | `config.objectStorage.publicSearchPaths` | `PUBLIC_OBJECT_SEARCH_PATHS ?? ""`; empty ⇒ `getPublicObjectSearchPaths()` throws (`objectStorage.ts` 75–80) | `PUBLIC_OBJECT_SEARCH_PATHS` | prod · api | Comma-separated `/<bucket>/public` paths; public-object fetch stops throwing |
| api config | `config.ts` | 247 | `config.objectStorage.privateObjectDir` | `PRIVATE_OBJECT_DIR ?? ""`; empty ⇒ `getPrivateObjectDir()` throws (`objectStorage.ts` 84–92) | `PRIVATE_OBJECT_DIR` | prod · api | e.g. `/<bucket>/.private`; upload URL minting stops throwing |
| storage auth | `objectStorage.ts` | 30 | `shouldUseReplitSidecar()` default branch | Auto: sidecar when `REPL_ID` present **and** no `GOOGLE_APPLICATION_CREDENTIALS`; else standard Google auth chain | `GOOGLE_APPLICATION_CREDENTIALS` | prod · api | Point at a service-account JSON with **signBlob** capability; V4 signed URLs are minted locally (`signObjectURL`, lines 279–288) |
| storage auth | `objectStorage.ts` | 27–29 | `shouldUseReplitSidecar()` explicit override | `OBJECT_STORAGE_AUTH=replit-sidecar` forces sidecar; `=google` forces standard auth | `OBJECT_STORAGE_AUTH` | all · api | Only needed to override auto-detection |

- **Replace from (Replit):** all four unset; sidecar auto-selected via `REPL_ID` at `http://127.0.0.1:1106`.
- **Replace to (elsewhere):** set the three layout vars + `GOOGLE_APPLICATION_CREDENTIALS`; auto-detect then picks `google` mode (or force `OBJECT_STORAGE_AUTH=google`).
- **Verification:** start API with the four vars set and `REPL_ID` **unset**; boot is clean; request a document upload URL — it returns a `storage.googleapis.com` V4 signed URL, not a sidecar error.

### 1.6 SMTP / email delivery

All optional (`config.email`, `config.ts` 260–277). Without SMTP the email service degrades to a logged no-op (`email/index.ts` 28–34). See `.env.example` §1e for the full list and placeholders.

| File | Line | Symbol/key | Env var | Environment | Verification |
|---|---:|---|---|---|---|
| `config.ts` | 262 | `config.email.smtpHost` | `SMTP_HOST` | prod · api | With all three set, `isEmailConfigured()` returns `true`; the "not configured" boot warning disappears |
| `config.ts` | 264 | `config.email.smtpUser` | `SMTP_USER` | prod · api | " |
| `config.ts` | 265 | `config.email.smtpPass` | `SMTP_PASS` | prod · api | " |
| `config.ts` | 263 | `config.email.smtpPort` | `SMTP_PORT` (default 587) | prod · api | 465 requires `SMTP_SECURE=true` |
| `config.ts` | 267 | `config.email.smtpSecure` | `SMTP_SECURE` | prod · api | `"true"` for implicit TLS |
| `config.ts` | 268 | `config.email.fromAddress` | `EMAIL_FROM` | prod · api | Sender address on outbound mail |
| `config.ts` | 269 | `config.email.fromName` | `EMAIL_FROM_NAME` | prod · api | Sender display name |
| `config.ts` | 271 | `config.email.brandName` | `EMAIL_BRAND_NAME` | prod · api | Brand in templates |

### 1.7 `REPLIT_DOMAINS` fallbacks — email base URL and public card-share URLs

`REPLIT_DOMAINS` is Replit-injected and **optional**. Two consumers fall back to it; both must be superseded off Replit.

| Package/module | File | Line | Symbol/key | Current behavior | Replace-to env var | Environment | Verification |
|---|---:|---|---|---|---|---|---|
| api config | `config.ts` | 274–276 | `config.email.appBaseUrl` | Uses first `REPLIT_DOMAINS` entry when `APP_BASE_URL` unset | **`APP_BASE_URL`** | prod · api | See §1.3 |
| cards route | `artifacts/api-server/src/routes/cards.ts` | 17–23 | `publicBaseUrl(req)` | Prefers `config.replitDomains?.split(",")[0]`, else forwarded proto+host of the request | *(no dedicated var)* — set `REPLIT_DOMAINS` to your public host **or** rely on `X-Forwarded-Host`/`X-Forwarded-Proto` from your proxy | staging/prod · api | Off Replit, ensure your reverse proxy sets `X-Forwarded-Proto=https` + correct `Host`; `GET` a card and confirm `publicUrl` (`cards.ts` 39) uses your public origin, not localhost |

Note: the public card-share URL path (`/c/:token`) has **no** `APP_BASE_URL` override; it derives the origin from `REPLIT_DOMAINS` or the forwarded request headers. If you serve the API behind a proxy on a custom host, set `REPLIT_DOMAINS=your.host` (a plain domain list is accepted) **or** guarantee correct `X-Forwarded-*` headers.

### 1.8 Trust-proxy hops — `TRUST_PROXY` (env var, no code edit)

| Package/module | File | Symbol/key | Current behavior | Env var | Environment | Verification |
|---|---|---|---|---|---|---|
| api app | `artifacts/api-server/src/lib/httpPolicy.ts` (consumed in `src/app.ts`) | `parseTrustProxy` → `app.set("trust proxy", …)` | Default (unset) trusts **exactly one** reverse-proxy hop; `req.ip` = last `X-Forwarded-For` entry. IP allow-lists, lockouts, and security events key on `getClientIp()` in `lib/security.ts` | `TRUST_PROXY` | all · api | Hit an auth endpoint through your full proxy chain and confirm the logged/allow-listed IP is the real client IP, not a proxy IP (covered by `test/http-policy.test.ts`) |

Accepted values: a non-negative integer hop count (`1`, `2`), `true`/`false`, or an address/subnet list (`10.0.0.0/8,172.16.0.0/12`, `loopback`).

- **Local (no proxy, directly exposed):** `TRUST_PROXY=false`
- **Replit / any single reverse proxy (default):** unset, or `TRUST_PROXY=1`
- **Staging/production behind CDN → LB → app:** `TRUST_PROXY=2` (count only hops you control)

**SECURITY:** trusting more hops than actually exist lets clients spoof their IP with a forged `X-Forwarded-For` prefix. Keep the value equal to the real number of trusted proxies.

### 1.9 CORS — `CORS_ORIGINS` (env var, no code edit)

| Package/module | File | Symbol/key | Current behavior | Env var | Environment | Verification |
|---|---|---|---|---|---|---|
| api app | `artifacts/api-server/src/lib/httpPolicy.ts` (consumed in `src/app.ts`) | `parseCorsOrigins` / `resolveCorsOrigin` → `cors(...)` | Unset: **development allows every origin** (historical behavior behind the Replit proxy, where the Expo web client runs on a different domain); **production emits no cross-origin headers** | `CORS_ORIGINS` | all · api | Allowed origin gets `Access-Control-Allow-Origin`; unlisted origin gets none (browser blocks). Covered by `test/http-policy.test.ts` |

Accepted values: a comma-separated list of **exact** origins, or `*` for explicitly open.

- **Local dev:** unset (open by default in development).
- **Staging (browser client on a separate host):** `CORS_ORIGINS=https://staging-app.example.com` — e.g. for the current Replit staging deployment, `CORS_ORIGINS=https://contact-aggregator--DelowarHossain1.replit.app` would allow that origin from another host.
- **Production, standard single-host setup (web served same-origin behind the same proxy, native mobile apps):** leave unset — same-origin requests and non-browser clients never need CORS, so the default-deny changes nothing and blocks foreign websites from making credentialed reads.
- **Production with browser clients on other origins:** `CORS_ORIGINS=https://app.example.com,https://admin.example.com`. An explicit allow-list also enables `Access-Control-Allow-Credentials` (needed for the cookie-based refresh flow cross-origin).
- **Restore the legacy fully open behavior:** `CORS_ORIGINS=*` (avoid in production unless the API is intentionally public).

### 1.10 Web dev server PORT / BASE_PATH vs. env-free build

| Package/module | File | Line | Symbol/key | Current behavior | Env var | Environment | Verification |
|---|---:|---|---|---|---|---|---|
| web build config | `artifacts/web-app/vite.config.ts` | 15–18 | `rawPort` guard | **Dev server only** (`command === "serve"`): throws if `PORT` unset | `PORT` | local/staging · web · dev-server | `PORT=3000 BASE_PATH=/ pnpm --filter web-app dev` starts; without `PORT` it throws |
| web build config | `vite.config.ts` | 24–30 | `basePath` guard / `base: basePath ?? "/"` | Dev server throws if `BASE_PATH` unset; **`vite build` needs neither** (base defaults to `/`) | `BASE_PATH` | local/staging · web · dev-server | `pnpm --filter web-app build` (no `PORT`/`BASE_PATH`) succeeds; produces `dist/public` |

The web client calls the API via **relative `/api` paths** (same origin / reverse proxy) — there is **no runtime API-URL variable** for the web app. Serve `dist/public` behind a proxy that forwards `/api` to the API server.

---

## 2. Hardcoded / account-specific values — edit these tracked files before building elsewhere

### 2.1 Mobile API URL baked into EAS profiles (staging host)

| Package/module | File | Line | Symbol/key | Replace from | Replace to | Env var | Environment | Verification |
|---|---:|---|---|---|---|---|---|---|
| mobile EAS | `artifacts/mobile/eas.json` | 20 | `build.preview.env.EXPO_PUBLIC_API_URL` | `https://contact-aggregator--DelowarHossain1.replit.app` | `https://<your-api-host>` | `EXPO_PUBLIC_API_URL` (baked at build time) | mobile · build (preview APK) | `node -e "console.log(require('./artifacts/mobile/eas.json').build.preview.env.EXPO_PUBLIC_API_URL)"` prints your host |
| mobile EAS | `artifacts/mobile/eas.json` | 26 | `build.production.env.EXPO_PUBLIC_API_URL` | `https://contact-aggregator--DelowarHossain1.replit.app` | `https://<your-api-host>` | `EXPO_PUBLIC_API_URL` | mobile · build (production) | `node -e "console.log(require('./artifacts/mobile/eas.json').build.production.env.EXPO_PUBLIC_API_URL)"` prints your host |

This URL is consumed at runtime by `artifacts/mobile/app/_layout.tsx` (lines 48–52, `apiUrl` = `EXPO_PUBLIC_API_URL` → else `https://${EXPO_PUBLIC_DOMAIN}` → else `null`). For local device testing against staging you can instead export `EXPO_PUBLIC_API_URL` in your shell before `expo start` (see `docs/LOCAL_AND_STAGING_RUNBOOK.md`).

### 2.2 Expo / EAS account identifiers + Android package (mobile)

| Package/module | File | Line | Symbol/key | Replace from | Replace to | Env var | Environment | Verification |
|---|---:|---|---|---|---|---|---|---|
| mobile app config | `artifacts/mobile/app.json` | 118 | `expo.owner` | `elite-marcom` | your Expo account/org slug | *(none — config)* | mobile · build | `node -e "console.log(require('./artifacts/mobile/app.json').expo.owner)"` |
| mobile app config | `artifacts/mobile/app.json` | 115 | `expo.extra.eas.projectId` | `751e9e6f-d185-4805-b42b-6aaedb1bb3cb` | your EAS project id (from `eas init`) | falls back to this when `EXPO_PUBLIC_EAS_PROJECT_ID` unset (`lib/push.ts` 38) | mobile · build | `node -e "console.log(require('./artifacts/mobile/app.json').expo.extra.eas.projectId)"` |
| mobile app config | `artifacts/mobile/app.json` | 017 | `expo.android.package` | `com.elitemarcom.cardscannerpro` | your reverse-DNS package id | *(none — config)* | mobile · build (Android) | `node -e "console.log(require('./artifacts/mobile/app.json').expo.android.package)"` |
| mobile app config | `artifacts/mobile/app.json` | 014 | `expo.ios.bundleIdentifier` | `com.elitemarcom.cardscannerpro` | your reverse-DNS bundle id (if building iOS) | *(none — config)* | mobile · build (iOS) | `node -e "console.log(require('./artifacts/mobile/app.json').expo.ios.bundleIdentifier)"` |

These are **account-specific identifiers, not secrets**. Change them only when building under a different Expo account. `eas build` auth itself uses `EXPO_TOKEN` in your CI/shell (never in the app env — see `.env.example` line 154).

### 2.3 Push notifications — client project id + server access token

| Package/module | File | Line | Symbol/key | Current behavior | Env var | Environment | Verification |
|---|---:|---|---|---|---|---|---|
| mobile push | `artifacts/mobile/lib/push.ts` | 37–40 | `getProjectId()` | `Constants.expoConfig.extra.eas.projectId` → `easConfig.projectId` → `EXPO_PUBLIC_EAS_PROJECT_ID`; absent ⇒ token registration skipped with a logged reason (lines 83–87) | `EXPO_PUBLIC_EAS_PROJECT_ID` (overrides app.json) | mobile · build | On a dev/EAS build with a valid project id, `[push]` skip log is absent and a token is registered |
| api push | `artifacts/api-server/src/lib/push.ts` | 37 (`config.push.expoAccessToken`) → `config.ts` 250–253 | `config.push.expoAccessToken` | Optional; Expo push API works without it — an access token adds Expo's enhanced-security delivery | `EXPO_ACCESS_TOKEN` | prod · api | Set it, restart; server-side push send still succeeds and uses the token header |

- **`EXPO_PUBLIC_EAS_PROJECT_ID` replace-to:** your EAS project id (same value as §2.2, if overriding app.json).
- **`EXPO_ACCESS_TOKEN` replace-to:** an Expo access token from your Expo account (server-only secret; never an `EXPO_PUBLIC_*` value).

### 2.4 Seeded demo passwords — rotate before public launch

| Package/module | File(s) | Symbol/key | Current behavior | Environment | Action | Verification |
|---|---|---|---|---|---|---|
| web + mobile demo login | `artifacts/web-app/src/pages/Login.tsx` (`import.meta.env.DEV` gate) · `artifacts/mobile/app/login.tsx` (`__DEV__` gate) · repo seed scripts | seeded demo credential (accounts `admin@techcorp.com`, `admin@cardscannerpro.com`, `admin@nexussys.io`) | Demo-login UI is **compiled out of production builds** (dev-gated); the seeded accounts remain valid in the database | prod · web · mobile · api (DB) | Before any public production launch, change the seeded demo passwords or remove the demo accounts | Per [`docs/SECRET_AND_PORTABILITY_AUDIT.md` §2](./SECRET_AND_PORTABILITY_AUDIT.md); confirm a production web bundle contains neither the demo strings nor the quick-login UI, and rotate the seeded passwords in the DB |

The literal demo password value is intentionally **not reproduced here**; see the audit §2 for its handling. These are *seed-data* passwords, not infrastructure secrets.

**Audit status (2026-08-06):** all three demo accounts are **active in both the development and production databases**, and the published demo password was verified (by offline hash comparison — never displayed) to still work on **all three production accounts**. In development the accounts are deliberately retained: the API integration suite and the Playwright E2E suite authenticate with them (`artifacts/web-app/e2e/fixtures/seed-values.ts`, multiple `artifacts/api-server/test/*.test.ts`), so rotating them in dev breaks the test infrastructure. **Production rotation is a required manual action before/at public launch** — change the three passwords directly in the production DB (or via the password-reset flow) after export.

---

## 3. Cross-references

- Full variable list, required/optional markers, placeholder values, and public-vs-server-only separation: [`.env.example`](../.env.example).
- Audit narrative (Replit dependencies removed/retained, secrets requiring rotation, verification that the API boots with all `REPL*`/`AI_INTEGRATIONS*` stripped): [`docs/SECRET_AND_PORTABILITY_AUDIT.md`](./SECRET_AND_PORTABILITY_AUDIT.md).
- Step-by-step local + staging setup and the mobile→staging connection procedure: [`docs/LOCAL_AND_STAGING_RUNBOOK.md`](./LOCAL_AND_STAGING_RUNBOOK.md).

## 4. Quick portability checklist (elsewhere, off Replit)

1. `DATABASE_URL` + `SESSION_SECRET` (`openssl rand -hex 32`) + `PORT` — **required** to boot the API (§1.1).
2. `MFA_ENCRYPTION_KEY` — optional dedicated MFA key (§1.2).
3. `GEMINI_API_KEY` for AI (leave `AI_INTEGRATIONS_GEMINI_*` unset) — else AI degrades gracefully (§1.4).
4. `DEFAULT_OBJECT_STORAGE_BUCKET_ID` + `PUBLIC_OBJECT_SEARCH_PATHS` + `PRIVATE_OBJECT_DIR` + `GOOGLE_APPLICATION_CREDENTIALS` (signBlob) for uploads (§1.5).
5. SMTP vars + `APP_BASE_URL` (web app URL) for real email + correct links (§1.3, §1.6).
6. Ensure reverse proxy sets `X-Forwarded-*`; set `REPLIT_DOMAINS`/host as needed for public card-share URLs (§1.7); set `TRUST_PROXY` to your real trusted-hop count (§1.8) and `CORS_ORIGINS` if any browser client lives on another origin (§1.9).
7. Web: `PORT` + `BASE_PATH` only for the dev server; `vite build` is env-free and served behind a proxy that forwards `/api` (§1.10).
8. Mobile: edit `eas.json` `EXPO_PUBLIC_API_URL` (both profiles) and `app.json` owner/projectId/package before building under a different Expo account (§2.1, §2.2); optionally `EXPO_PUBLIC_EAS_PROJECT_ID` + server `EXPO_ACCESS_TOKEN` for push (§2.3).
9. Rotate/remove seeded demo passwords before public launch (§2.4).
