# Gotchas

Operational, build, runtime, data-integrity, and testing traps discovered during
development. Security- and tenant-isolation gotchas live in
[Security & Privacy](security-and-privacy.md); AI-specific safety notes live in
[AI Architecture](ai-architecture.md).

## Build, codegen & runtime

- Always run `pnpm --filter @workspace/api-spec run codegen` after editing `openapi.yaml`
- Run `pnpm --filter @workspace/db run push` after schema changes
- `??` and `||` mixed without parens fails esbuild — always wrap: `(a ?? b) || c`
- API routes must include full base path (`/api/...`) — the reverse proxy does NOT strip it
- `@types/express-serve-static-core` v5 types `req.params[key]` as `string | string[]` — wrap path params: `parseInt(String(req.params.id))`
- Do NOT use `pnpm run dev` at workspace root — workflows handle port + env injection
- **esbuild externalizes some packages** (`build.mjs` `external` globs, e.g. `@google/*`) — a package matching those globs that is only a transitive dep (via a `@workspace/*` lib) must ALSO be a direct dependency of `api-server`, else runtime fails with `ERR_MODULE_NOT_FOUND`
- **Body-parser limit**: `express.json`/`urlencoded` are raised to `15mb` in `app.ts` for base64 card images — a too-small limit surfaces as HTTP 413 on `POST /scans`
- **Date-only columns** (e.g. `contacts.followUpDate`, a Drizzle `date`) are plain `YYYY-MM-DD` strings — format them with `parseISO(s)` (NOT `new Date(s)`, which parses as UTC midnight and renders the prior day in negative-offset TZs). For "today" comparisons use `format(new Date(), "yyyy-MM-dd")` and string-compare; both sides are local-date strings.

## Routing & data integrity

- **Static sub-paths before `/:id`**: routes like `GET /contacts/duplicates` and `POST /contacts/merge` MUST be registered before `GET/PATCH/DELETE /contacts/:id` (Express + wouter match in declaration order) or `:id` swallows them. Same applies to the `/admin/duplicates` web route vs `/admin/contacts/:id`.
- **Contact merge FKs**: contacts are referenced ONLY by `scans.contactId` + `leads.contactId` (both onDelete set null). Merge must reassign both to the primary inside one transaction before deleting dups, or surviving scans/leads get orphaned (null contactId).
- **Additive scan metadata columns are JSON text but exposed as objects**: `fieldConfidences`/`validationStatus`/`qualityMeta` on `scans` are stored as JSON strings — EVERY scan response path (list/get/create-success/create-fail/reprocess/replace) must run them through `parsedScanMeta()` or clients get a raw string where the OpenAPI contract promises an object.

## Testing

- **Test-suite reruns need a server restart**: the per-IP login limiter (`loginRateLimiter`, max 20 FAILED logins / 15-min window) lives in the running server's memory. A single full `test` run stays under the cap and is green, but two back-to-back full runs against the SAME running server accumulate the brute-force/invalid-cred failures past 20 → valid logins start returning 429. Restart the api-server workflow before re-running the full suite (the gate run must hit a freshly-started server).
