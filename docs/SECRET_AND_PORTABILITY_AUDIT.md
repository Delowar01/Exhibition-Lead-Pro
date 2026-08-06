# Secret & Portability Audit — Card Scanner Pro

Date: 2026-08-06 · Branch: `main` · Scope: entire monorepo (API server, web app, mobile app, shared libs, docker assets, git history)

This document records every check performed for the export-readiness audit, what was found, what was fixed, and what remains as a deliberate, documented dependency.

---

## 1. Checks performed

| # | Check | Method | Result |
|---|-------|--------|--------|
| 1 | API keys / private keys in tracked files | Pattern grep over all tracked files (`AIza`, `sk-`, `BEGIN … PRIVATE KEY`, `xox`, JWT-like strings, hex secrets) | **Clean** — no live credentials in tracked files |
| 2 | Tracked `.env`-like files | `git ls-files` filename scan | Only `docker/.env.example` (verified: placeholders only) and the new root `.env.example` (placeholders only) |
| 3 | Git history — sensitive filenames | `git log --all --diff-filter=A --name-only` over all 598 commits, filtered for `.env`, `.pem`, `.p12`, `.keystore`, `credential*`, `service account`, `key.json` | **Clean** — no such file was ever committed |
| 4 | Git history — key material | `git log --all -S` for `BEGIN PRIVATE KEY`, `BEGIN RSA`, `AIzaSy` | **Clean** — zero matching commits |
| 5 | Hardcoded URLs | Full-repo grep for `localhost`, `replit.app`, `replit.dev`, `http(s)://` literals | All findings triaged below (§3, §5) |
| 6 | `process.env` reads outside the config module | Repo-wide grep | One violation found and fixed (Gemini provider, §4.2) |
| 7 | Replit-only runtime dependencies | Audit of sidecar, `REPL_ID`, `REPLIT_DOMAINS`, AI-integration vars | All made optional (§4); boot verified with every `REPL*`/`AI_INTEGRATIONS*` var stripped |
| 8 | Debug logging / temp code | Repo-wide grep for `console.log`, `TEMP`, `HACK`, `FIXME` | No leftovers in API `src/`; mobile diagnostics reviewed and intentional (§5.3) |

## 2. Embedded demo credentials — found & fixed

The seeded demo credential `Admin123!` (accounts `admin@techcorp.com`, `admin@cardscannerpro.com`, `admin@nexussys.io`) appeared in two client-side source files as a development convenience:

- `artifacts/web-app/src/pages/Login.tsx` — "Quick Demo Login" buttons.
- `artifacts/mobile/app/login.tsx` — prefilled email/password fields + demo-account chips.

**Fix applied:** both are now compiled out of production builds (`import.meta.env.DEV` gate on web, `__DEV__` gate on mobile). Dev builds keep the convenience; release web bundles and release APKs contain neither the strings nor the UI.

**Rotation recommendation:** these are *seed-data* passwords, not infrastructure secrets. They remain valid accounts on the staging database. Before any public production launch, change the seeded demo passwords (or remove the demo accounts) — they are documented in repo seed scripts by design.

## 3. Replit dependencies — removed or made optional

| Dependency | Before | After |
|---|---|---|
| **Gemini client** (`lib/integrations-gemini-ai`) | Threw at import time when `AI_INTEGRATIONS_GEMINI_*` (Replit AI integration) vars were absent — the API server could not even boot off-Replit; the docker path's `GEMINI_API_KEY` was never read | Lazy client; accepts direct `GEMINI_API_KEY` (standard Google endpoint) **or** the Replit proxy pair (which takes precedence). Unconfigured ⇒ server boots, AI features degrade behind `isConfigured()` (second copy in `image/client.ts` fixed the same way) |
| **Object storage** (`objectStorage.ts`) | Hardcoded Replit sidecar (`127.0.0.1:1106`) for both credentials and signed URLs | Auto-selects: Replit sidecar on Replit, standard Google auth chain (`GOOGLE_APPLICATION_CREDENTIALS`/ADC) + library-minted V4 signed URLs elsewhere. Override: `OBJECT_STORAGE_AUTH=replit-sidecar\|google` |
| **Web `vite.config.ts`** | `PORT` and `BASE_PATH` required even for `vite build` | Required only for the dev server (deliberate, protects Replit preview routing); `vite build` is now env-free (base defaults to `/`) |
| **`REPLIT_DOMAINS`** | — | Was already optional: fallback for email-link base URL and public card-share URLs. Retained as optional. New: startup **warning** when email is configured in production but `APP_BASE_URL` is unset (links would point at localhost) |
| **`REPL_ID`** | — | Was already optional: gates Replit-only dev plugins (cartographer, dev banner) and now the storage sidecar auto-detect. Retained |

**Verification:** the API server was built and booted with `REPL_ID`, `REPLIT_DOMAINS`, `REPLIT_DEV_DOMAIN`, `AI_INTEGRATIONS_GEMINI_*`, and all object-storage vars stripped — clean start, HTTP serving, job queue and schedulers up. `vite build` verified with `REPL_ID` stripped.

## 4. Code-polish fixes in this pass

1. `artifacts/api-server/src/ai/providers/gemini.ts` — env reads moved behind the shared `isGeminiConfigured()` resolver (config centralization; `config.ai.gemini` added).
2. `artifacts/api-server/src/lib/email/index.ts` — production misconfiguration warning for localhost email links (see §3).
3. Demo-credential dev-gating (§2).
4. No dead pages found: all `pages/admin/*` files are lazily routed in `App.tsx`; a first-pass "unreferenced" list was disproven against the router. Nothing deleted.

## 5. Deliberate, documented retentions

1. **`eas.json` staging URL** — `https://contact-aggregator--DelowarHossain1.replit.app` baked into preview/production APK profiles. This *is* the current staging/production API host. Replacement steps: `docs/PORTABLE_ENVIRONMENT_SETUP.md`.
2. **Expo/EAS identifiers** (`app.json`): projectId `751e9e6f-d185-4805-b42b-6aaedb1bb3cb`, owner `elite-marcom`, android package `com.elitemarcom.cardscannerpro` — account-specific, replacement documented, not secrets.
3. **Mobile diagnostics logging** — `[Scan]` logs are `__DEV__`-gated; `[NFC]` tagged logs and `[push]` skip-reason logs are intentional device-support diagnostics (documented in code), not debug leftovers.
4. **Replit dev plugins** (`@replit/vite-plugin-*`) — dev-only, gated on `REPL_ID`, inert elsewhere.
5. **`docker/.env.example`** — placeholders only; kept.

## 6. Manual actions for a new environment (summary)

Full step-by-step map: `docs/PORTABLE_ENVIRONMENT_SETUP.md`.

1. Set `DATABASE_URL` + freshly generated `SESSION_SECRET` (and ideally a dedicated `MFA_ENCRYPTION_KEY`).
2. Set `GEMINI_API_KEY` for AI features (or leave unset to run without AI).
3. For file storage: GCS bucket + service account (`GOOGLE_APPLICATION_CREDENTIALS`) with signBlob, plus the three bucket-layout vars — or leave unset to run without uploads.
4. Set `APP_BASE_URL` (production + email) and SMTP vars for real email delivery.
5. Mobile: replace `EXPO_PUBLIC_API_URL` in `eas.json`, and Expo owner/projectId/package in `app.json` if building under a different Expo account.
6. Rotate/remove seeded demo passwords before public launch (§2).
7. No git-history rewrite needed — history is clean (§1).
