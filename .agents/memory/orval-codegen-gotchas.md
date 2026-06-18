---
name: Orval codegen gotchas
description: Non-obvious failures when adding OpenAPI paths that break orval React-Query codegen
---

# Orval path-param collision

Adding a GET path that mixes a path param with a resource that also has a query-list
endpoint of a similar name can make orval emit the SAME params type name from two
files (e.g. `GetEventReportParams` exported by both `api.ts` and `types/`), which
fails `typecheck:libs` with a duplicate-export error.

**Why:** orval derives the params type name from the operationId/path; a `/reports/event/{id}`
path param collided with the generated query-params type for the same operation.

**How to apply:** Prefer a query-only design (`/reports/event?eventId=`) that mirrors an
existing working list endpoint (e.g. `listContacts`) instead of a `{id}` path param when
the endpoint also takes filter query params. Always run
`pnpm --filter @workspace/api-spec run codegen` after editing `openapi.yaml`.

# api-server dev server does not hot-reload route changes

After editing `artifacts/api-server/src/routes/*`, the running dev workflow may keep
serving the OLD handler — runtime smoke tests show missing new fields even though
`typecheck` passes. Restart the `artifacts/api-server: API Server` workflow before
curl-smoke-testing new/changed endpoints.
