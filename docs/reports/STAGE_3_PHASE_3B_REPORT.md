# Stage 3 — Phase 3B: Enterprise Document Management — Completion Report

**Status:** Complete — ready for review.
**Scope:** Additive only. New tables + new API surface + new web/mobile UI. No breaking API changes; all existing functionality preserved.
**Validation:** Full workspace typecheck green (all 6 packages); full test gate green — **18 files, 306 tests passing** (incl. the new `documents` suite, 37 tests). api-server restarted before the gate run (login-limiter requirement).

## What shipped

Enterprise document management: files attachable to a **company**, **contact**, **lead**
(≡ opportunity), or **event**, with upload / download / preview / rename / move / delete /
restore, **immutable versioning (never overwrite)**, and search + filters. Metadata lives
in Postgres; file bytes live in object storage, served via short-lived **signed URLs**.

### 1. Storage foundation
- `lib/objectStorage.ts` — `getObjectEntityDownloadURL` for signed download URLs.
- `lib/documentStorage.ts` — 25 MB size cap, MIME allowlist, `DOCUMENT_CATEGORY_CATALOG`
  per entity type, and `assert*` validation helpers (object-path prefix, category-per-entity).

### 2. Documents API
- `repositories/documents.repository.ts`, `services/documents.service.ts`,
  `routes/documents.ts` (mounted in `routes/index.ts`).
- Endpoints: request-upload-URL, create document, add version, list (with search/filters),
  get, list/download versions, download current, rename, move, delete (soft), restore,
  categories catalog.
- **Versioning never overwrites**: each upload appends an immutable
  `document_versions` row and repoints `documents.currentVersionId`; historical bytes stay
  addressable.

### 3. Web UI
- `components/DocumentsPanel.tsx` (dialogs/upload/preview/versions controller) +
  `pages/admin/Documents.tsx` (folder + list view). New `/admin/documents` route,
  RBAC-gated nav item, and a Documents tab on Lead detail.

### 4. Mobile UI
- `lib/documents.ts` (pick/upload/preview/download) + `components/DocumentsSection.tsx`,
  wired into pipeline (`pipeline/[id].tsx`) and contact (`contact/[id].tsx`) screens.
  EN + AR i18n parity; `expo-document-picker` added; degrades gracefully.

## Architecture & convention adherence

- **Contract-first:** OpenAPI spec → Orval codegen → React Query hooks + Zod bodies
  (`CreateDocumentBody`/`UpdateDocumentBody`/`AddDocumentVersionBody`/`RequestDocumentUploadUrlBody`).
- **RBAC:** `platform_owner` has **NO** access — blocked by a path-scoped
  `requireTenantUser` terminating guard placed before the tenant gates (tenant firewall
  pattern). Writes gated by `requirePermission("documents", action)`; reads open but
  tenant-scoped via `activeScope`.
- **Tenant isolation:** entity FK validation on write — `company` requires
  `id === companyId`; `contact`/`lead`/`event` validated via
  `refInCompany(table, companyId, id)` (target-company-scoped, not caller-scoped).
  Version lookups scope by the denormalized `companyId`.
- **Audit + read-only lifecycle:** `blockReadOnlyMutations` + `auditMutations("documents")`,
  both path-scoped to `/documents` to avoid the router-level guard leak.
- **Soft delete:** delete sets `deletedAt`; restore clears it; lists filter `isNull(deletedAt)`.

## Concurrency hardening (post-review)

Architect flagged a version-number race (concurrent uploads to one document could compute
the same `max+1`). Resolved with defense-in-depth:
- **Unique index** `document_versions_doc_version_uq` on `(documentId, versionNumber)` — the
  immutable correctness backstop.
- **Per-document advisory lock**: `addVersion()` acquires
  `pg_advisory_xact_lock(namespace, documentId)` inside the insert transaction, serializing
  concurrent version writes for the same document (different documents proceed in parallel).
  The lock is transaction-scoped, so it auto-releases on commit/rollback.
- **New integration test**: fires 5 concurrent add-version requests and asserts distinct
  monotonic version numbers and a coherent `currentVersion`.

Second architect review: **PASS** — advisory-lock approach correct, deadlock/namespace-
collision risk low, unique index rightly retained.

## Files

- `lib/db/src/schema/documents.ts`, `lib/objectStorage.ts`, `lib/documentStorage.ts`
- `artifacts/api-server/src/{routes,services,repositories}/documents.*`
- `artifacts/api-server/test/documents.test.ts` (37 tests)
- `artifacts/web-app/src/components/DocumentsPanel.tsx`, `pages/admin/Documents.tsx`
- `artifacts/mobile/components/DocumentsSection.tsx`, `artifacts/mobile/lib/documents.ts`
