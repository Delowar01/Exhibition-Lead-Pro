---
name: Portability/export-readiness lessons
description: What actually breaks when this monorepo leaves Replit, and the local build gotcha for the shared Gemini lib
---

## Import-time env throws are the #1 portability killer
Any module that validates env vars at import time (the old Gemini client threw if `AI_INTEGRATIONS_GEMINI_*` were missing) prevents the whole API server from booting in a non-Replit environment — even when the feature is optional. Pattern used to fix it: lazy Proxy singleton + `resolveCredentials()` + an exported `isConfigured()` gate so the feature degrades instead of crashing boot.

**Why:** the export-readiness audit found the API could not start at all off-Replit purely because of one import-time throw in a shared lib.

**How to apply:** when adding any provider/integration client, never throw on missing env at module scope; resolve credentials on first use and expose a configured-check. Credential precedence here: Replit proxy pair (`AI_INTEGRATIONS_GEMINI_API_KEY`+`_BASE_URL`, with `httpOptions: { apiVersion: "", baseUrl }` — that exact shape is required by the proxy) → direct `GEMINI_API_KEY` (no baseUrl override).

## Composite-lib declaration rebuild gotcha
`lib/integrations-gemini-ai` (and other `lib/*` packages) are TypeScript composite projects that emit declaration-only `dist/`. After editing their `src/`, run `npx tsc -b lib/<pkg>` (or `pnpm -w run typecheck:libs`) — otherwise dependent packages' typecheck fails with "no exported member" for symbols that clearly exist in source.

## Other portable-mode facts (verified 2026-08-06)
- Object storage: Replit sidecar auth is used only when `REPL_ID` is set and `GOOGLE_APPLICATION_CREDENTIALS` is not; override with `OBJECT_STORAGE_AUTH=replit-sidecar|google`. Portable mode = ADC + library V4 signed URLs (GET/HEAD→read, PUT→write, DELETE→delete; HEAD signs as GET — fine, no caller uses HEAD).
- `vite build` needs no env; PORT/BASE_PATH are only required for `serve` (dev AND `vite preview` — intentional, preview is Replit-deploy-only).
- Env contract lives in root `.env.example`; replacement map in `docs/PORTABLE_ENVIRONMENT_SETUP.md`; runbook in `docs/LOCAL_AND_STAGING_RUNBOOK.md`.
- Architect review hallucinated a "top-level apiVersion" regression — the original client also used `httpOptions.apiVersion`; verify such claims against `git diff` before "fixing".
