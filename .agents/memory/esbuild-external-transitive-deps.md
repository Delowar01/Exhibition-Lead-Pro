---
name: esbuild externalized packages need direct deps
description: Why the api-server bundle fails at runtime with ERR_MODULE_NOT_FOUND for some packages, and how the body-parser limit interacts with image uploads.
---

# esbuild external list + transitive deps

The api-server is bundled by `build.mjs` (esbuild, ESM output). Its `external` array marks many packages as NOT bundled (loaded from node_modules at runtime). This list uses broad globs — notably `@google/*` (covers `@google/genai`).

**Rule:** any package that is externalized AND only present transitively (e.g. pulled in by a `@workspace/*` lib) must ALSO be declared as a **direct dependency of api-server**, or runtime `node ./dist/index.mjs` throws `ERR_MODULE_NOT_FOUND`. pnpm only symlinks a package into `artifacts/api-server/node_modules` when api-server lists it directly.

**Why:** the bundle is emitted in `artifacts/api-server/dist`, so Node resolves externals from `artifacts/api-server/node_modules` upward — a transitive-only dep hoisted elsewhere in the pnpm store is not reliably resolvable from there.

**How to apply:** when adding an AI/cloud SDK used via a shared lib, check whether its name matches an `external` glob in `build.mjs`. If so, add it to `artifacts/api-server/package.json` dependencies and `pnpm install`. (Confirmed for `@google/genai` via the gemini integration.)

## Body-parser limit for image uploads
Express default JSON body limit (~100kb) is far too small for base64 card images. `app.ts` raises both `express.json` and `express.urlencoded` to `15mb`. A too-small limit surfaces as HTTP 413 (HTML error page, not JSON) on `POST /scans`.
