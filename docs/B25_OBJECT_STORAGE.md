# B25 — Provider-Neutral Object Storage and Hostinger Filesystem Foundation (Phase 1)

> **Status (Phase 1, 2026-10-02): implemented and verified LOCALLY on branch
> `claude/b25-object-storage-hostinger`. NOT merged, NOT deployed, NOT migrated.**
> The hosted dev stack (`dev.kaptnow.com`) still runs the pre-B25 Google Cloud
> Storage path unchanged; no hosted object, credential, bucket or VPS was
> touched. Google Cloud Storage remains in the codebase **only** as the
> temporary legacy / migration / fallback driver. **B25 is not complete** until
> the owner-approved hosted phases below have been executed and verified, and
> Google Cloud can be removed only after that (§10).

## 1. Owner decisions and scope of Phase 1

| Decision | Effect in Phase 1 |
|---|---|
| Remove Google Cloud completely (Option B) | A provider-neutral storage boundary with a filesystem primary driver was built; GCS is reduced to a temporary legacy driver behind the same contract. The dependency, credentials and env vars stay until the verified migration (§10). |
| No second Hostinger backup VPS yet; must not block B25 | Nothing here depends on an off-host target. Durability is **single-host** until the deferred off-host design is activated (§9). |
| Product files live on a private filesystem volume on the existing application VPS | Filesystem driver, compose volume / Dockerfile directory / env examples **prepared for review**; nothing active on the VPS. |
| Do not delete, mutate or migrate hosted GCS objects in this phase | The migration command exists and is unit-tested with fake drivers only; `OBJECT_STORAGE_LEGACY_DELETE` defaults to off and tombstones never delete legacy objects. |

Out of scope and untouched: merge/deploy, hosted VPS/DB/bucket/credentials, the frozen off-host branch, a second VPS, B26, UI features, MinIO/S3/Redis/other providers, AI/SMTP/Stripe/billing behaviour.

## 2. Pre-B25 inventory (what the complete repository contained)

| Flow | Pre-B25 storage path | DB column holding the reference | Deletion behaviour before B25 | Orphan risk before B25 |
|---|---|---|---|---|
| Documents + versions | client PUT to a **V4-signed GCS URL** for `PRIVATE_OBJECT_DIR/uploads/<uuid>`; download = signed GET URL (`{url,fileName,mimeType}`) | `document_versions.object_path` (`/objects/uploads/<uuid>`) | soft delete only; no object delete anywhere | company cascade / version hard delete left objects in the bucket |
| Export runs (B9) | server-side PUT of the generated buffer via a signed URL; `downloadUrl` signed per response | `export_runs.object_path` | never deleted | same |
| Executive reports (Stage 5C) | same helper (`uploadExportBuffer`) | `executive_reports.object_path` | never deleted | same |
| Scan / card images | `scans/<companyId>/<scanId>.jpg` in the bucket root, uploaded fire-and-forget after OCR, served through `GET /scans/:id/image` (auth) | `scans.image_url` | replace overwrote the same key; never deleted | company cascade |
| Branding logos (B18) | `branding/<companyId>/<32hex>.<ext>`, `LogoObjectStore` (gcs / memory / none), public `GET /branding/logos/:companyId/:id`, `GET /cards/public/:token/logo` | `companies.brand_logo_key`, `brand_logo_content_type` | best-effort delete of the old object after the row update | failed delete left the old id readable |
| Readiness | `checkStorageReachable()` = one-object GCS list | — | — | — |
| `@google-cloud/storage` imports | `src/lib/objectStorage.ts` (client + `ObjectStorageService` signing), `src/lib/objectAcl.ts` (unused ACL template) | — | — | — |
| GCS env | `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR`, `GOOGLE_APPLICATION_CREDENTIALS`, `OBJECT_STORAGE_AUTH`, `GCS_CREDENTIAL_GID`, `REPL_ID` (sidecar detection), `BRANDING_STORAGE_STUB` (retired in B25) — in `.env.example`, `docker/.env.example`, `docker/.env.vps.example`, `docker/docker-compose.yml`, `docker/compose.vps.yml` (key mount + `group_add`), `docker/scripts/deploy-vps.sh` (credential readability check) | — | — | — |
| Web consumers | `DocumentsPanel` (`fetch(uploadURL, {method:"PUT"})` without auth headers, `triggerDownload(url)`), export / report download links | — | — | — |
| Mobile consumers | `lib/documents.ts` (`FileSystem.uploadAsync(uploadURL, PUT)` + echoes `objectPath`), `export-share.ts` (`FileSystem.downloadAsync(downloadUrl)`), scan image via `/api/scans/:id/image` with the bearer token | — | — | — |

Consequence for the design: upload and download URLs **must stay self-contained absolute capability URLs**, response shapes (`uploadURL`/`objectPath`, `url`/`fileName`/`mimeType`, `downloadUrl`) must not change, and `/objects/…` handles plus the branding key format must remain valid references.

## 3. Architecture

```
feature route (auth → tenant → permission)            clients (web / mobile)
        │  reserve / store / mint / delete                      │ opaque URLs only
        ▼                                                       ▼
services/storage.service.ts  ── ONE boundary ──►  routes/files.ts  (PUT /files/uploads/:id?t=  GET /files/:id?t=)
        │  write-ahead inventory row  ▲ capability (HMAC, HKDF-derived)
        ▼                             │
storage_objects (inventory, tombstones, entity binding, digests)
        │
        ▼
storage/contract.ts  StorageDriver { put, getStream, head, exists, delete, probe }
   ├─ fs-driver.ts      encrypted files under OBJECT_STORAGE_FS_ROOT   (dev, tests, VPS)
   ├─ gcs-driver.ts     TEMPORARY legacy driver (fallback reads, mirror, migration source)
   └─ memory-driver.ts  deterministic in-process driver (unit tests only; refused in production)
```

**Trust boundaries.** Clients never see storage keys, filesystem paths, bucket names or provider URLs; they only receive opaque `/objects/<uuid>` handles (or the legacy-compatible `branding/<cid>/<32hex>.<ext>` key, which doubles as the public logo id) and short-lived capability URLs on the API's own origin. A client can never supply a company id or a storage key that controls access: the tenant comes from the authenticated user, keys are built server-side (`storage/keys.ts`), and every byte route re-checks the inventory row (tenant + state) against the token. Cross-tenant access keeps the existing conventions (404 for tenant resources, 403 for the platform-owner firewall, 400 "Invalid objectPath" for a foreign or unknown handle so the probe reveals nothing).

### 3.1 Storage contract (`src/storage/contract.ts`)

`put(key, Readable|Buffer, {contentType, maxBytes, expectedSha256?, expectedSize?, allowOverwrite?}) → {sizeBytes, sha256}` (plaintext size and SHA-256 computed in the write pipeline; `STORAGE_TOO_LARGE` past the ceiling; `STORAGE_CONFLICT` on an existing key unless overwrite is allowed; `STORAGE_INTEGRITY` when a declared digest/size differs), `getStream(key, {maxBytes}) → {stream, sizeBytes|null, contentType|null}` (bounded; `STORAGE_NOT_FOUND`), `head`, `exists`, `delete` (idempotent), `probe()` (bounded reachability). Errors are `StorageError` codes with fixed messages — never a path, key or bucket.

### 3.2 Canonical keys (`src/storage/keys.ts`)

`tenants/<companyId>/{documents|exports|reports|scans|branding}/<id>[.<ext>]` and `health/<id>`. Components are allow-listed (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`, no `..`), 2–6 components, tenant id numeric; absolute paths, `..`, `%2e%2e`, backslashes, NUL bytes, hidden names and unknown roots cannot form a key. Ids are random UUIDs (branding: 32-hex form).

### 3.3 Filesystem driver (`src/storage/fs-driver.ts`)

Root must be absolute, not `/`, outside the process working directory (the repository / bundle) and outside `/var/www`, `/usr/share/nginx`, `/etc`, `/proc`, `/sys`, `/dev`; created `0700`; a symlinked root is refused. Every component below the root is `lstat`ed and refused when it is a symbolic link (file or directory); files are opened `O_NOFOLLOW`; non-regular files are refused. Writes stream `plaintext → size/SHA-256 limiter → encryption → private 0600 temp file (`O_EXCL`) in the destination directory`, `fsync`, then `rename` into place (+ directory sync); the temp file is unlinked on any failure, so a partial object is never visible and plaintext never touches disk. Reads stream `file → authenticated decryption → bounded PassThrough`; integrity failures end the stream with a sanitized error. Directories are `0700`, files `0600`.

### 3.4 Encryption envelope (`src/storage/envelope.ts`) — format v1

```
"LCPO" | version u8 (=1) | header length u16 | header JSON
frame*     : plaintext length u32 | AES-256-GCM ciphertext | tag (16)   type 0 (data)
final frame: same shape, type 1, plaintext = JSON { size, sha256, chunks }
header JSON = { v:1, k:<key id = sha256(key)[:16]>, n:<8-byte random nonce prefix, hex>, c:<chunk size, 256 KiB default>, o:<storage key> }
nonce = prefix || u32 frame counter;  AAD = header bytes || u32 counter || u8 frame type
```

Honest encryption at rest: authenticated (GCM) per frame so every emitted plaintext byte has passed its tag; random per-object nonce prefix; the storage key is bound into the authenticated header (a ciphertext moved to another key fails `KEY_MISMATCH`); the key id makes a wrong key fail clearly; frame counters detect reordering/dropping; the authenticated final frame carries plaintext size, SHA-256 and chunk count, which the reader recomputes and refuses to finish without — so size and digest are verifiable **without** weakening authentication (they are also stored in `storage_objects`). Streaming encryption in bounded memory was feasible with this chunked design, so no deviation from the requirement was needed.

**Key requirements.** `OBJECT_STORAGE_ENCRYPTION_KEY` = exactly 32 bytes (64 hex chars from `openssl rand -hex 32`, or base64). Dedicated secret: not `JOBS_PAYLOAD_ENCRYPTION_KEY`, not `SESSION_SECRET`, not database or Google credentials. **Required** whenever the fs driver runs in production (startup refuses otherwise); outside production an explicit `OBJECT_STORAGE_TEST_EPHEMERAL_KEY=true` may substitute a random per-process key (objects do not survive a restart — tests only). Never logged, audited, returned or committed. **Before any hosted cutover the owner must hold an offline, owner-controlled recovery copy of the key**: without it every stored object is unrecoverable, and backups of the volume are useless.

### 3.5 Capability URLs (`src/storage/capability.ts`, `src/routes/files.ts`)

After the normal auth / tenant / permission checks, the feature route mints `base64url(payload).base64url(HMAC-SHA256)` with payload `{v:1, op:"put"|"get", o:<object id>, c:<company id>, u:<user id|null>, exp, fn?, d?}`; the signing key is HKDF-derived from `SESSION_SECRET` with a dedicated label (never the raw secret, never the object key). TTLs: uploads 900 s, downloads 300 s (configurable). URLs are absolute on the request origin (`req.protocol://host`, honouring the trusted proxy), falling back to `APP_BASE_URL`. `PUT /api/files/uploads/:id?t=` streams the raw body into the boundary (mounted **before** the JSON parsers; a declared `Content-Length` beyond the kind's ceiling is refused with 413 before reading; a staged/active object answers 409; a bad/foreign/expired token 403). `GET /api/files/:id?t=` (HEAD supported) re-checks tenant + `active` state and streams with `Content-Type` (validated token), `Content-Length`, `Content-Disposition` (inline only for image/PDF/plain-text types, attachment otherwise), `Cache-Control: private, no-store, no-transform`, `X-Content-Type-Options: nosniff`. The query string is stripped from request logs. Scan images keep `GET /scans/:id/image` (bearer auth), logos keep the randomized first-party routes.

### 3.6 Object manager (`src/services/storage.service.ts`) — lifecycle

States: `pending → staged → active → deleting → deleted`, plus `failed`. **Reserve → write → activate**: the inventory row is written before any byte can land; client uploads move the row to `staged` after the verified write; `attachStaged(tx, …)` activates it **inside the feature transaction** (document / version insert) and refuses anything that is not a staged object of this tenant and kind with the reserved content type; server-side writes (`storeBuffer`) activate after the write and bind the entity (export run / report / scan / company). A write failure leaves a `failed` row and no bytes; a database failure after the write removes the bytes (nothing untracked) and the sweep settles the row. **Tombstone first, bytes second**: `deleteByReference` marks `deleting` (an unknown / legacy reference gets a `deleted` tombstone) so a deleted object is unservable immediately and can **never** reappear through the legacy fallback; a failed physical delete stays `deleting` and is retried by the durable job `storage.deleteObject` (dedupe key per object) and by the maintenance sweep. Company deletion tombstones every object of the tenant in the same transaction that removes the company (the inventory has no FK on purpose) and enqueues `storage.purgeCompany` (bounded batches that re-enqueue themselves). Logo replacement and scan-image replacement tombstone the previous object. Only `active` rows are ever served.

**Legacy fallback (transition only).** With `OBJECT_STORAGE_LEGACY_FALLBACK=true` and a bucket configured, a reference **without** an inventory row may be served from its legacy location (documents/exports/reports `PRIVATE_OBJECT_DIR/uploads/<uuid>`, scans `scans/<cid>/<id>.jpg`, logos `branding/<cid>/<id>.<ext>` — the embedded tenant id must match the caller's tenant); it is registered on first use (`driver=gcs`, `legacy_key`) so later reads, deletes and the migration share one record. A migrated row whose primary copy is missing may also be served from its recorded legacy location ("fs-first reads with GCS fallback"). Every fallback read is counted (`legacyFallbackReads`) and logged.

**Strict mirror (transition only).** `OBJECT_STORAGE_MIRROR=gcs` copies every primary write to the bucket under the canonical key; a mirror failure fails the write, rolls the primary object back and counts `mirrorFailures`.

**Maintenance sweep (`storageSweep` in the recurring maintenance task).** Reserved-but-never-uploaded rows past `OBJECT_STORAGE_PENDING_TTL_MS`, uploaded-but-never-attached rows past `OBJECT_STORAGE_STAGED_TTL_MS`, `failed` rows, `deleting` retries, objects whose company or feature row (version / export run / report / scan) no longer exists, logos whose company now points elsewhere, and day-old tombstones of deleted companies — bounded by `OBJECT_STORAGE_SWEEP_BATCH`, idempotent.

### 3.7 Readiness, metrics, logs

`GET /readyz` keeps its body contract; `checks.storage` now probes the **primary driver**: fs = write → read → verify → delete of one random 1 KiB object under `health/` with a 2.5 s budget, no path in the response, nothing left behind; gcs = the legacy single-object list; `not_configured` when no driver. `GET /metrics` (platform owner) gains an additive `storage` block (driver, `legacyFallback`, `mirror`, counters `primaryFailures` / `legacyFallbackReads` / `mirrorFailures` / `migrationVerifyFailures` / `deleteFailures`, inventory backlog `pendingUploads` / `pendingDeletes` — `null` when the inventory cannot be read, never a fabricated 0). Structured logs carry ids, kinds, tenant ids and error codes only — never contents, credentials, tokens, paths or full checksums. Startup (`initStorage`) validates the configuration and refuses to boot a production node with an unusable root or a missing key.

## 4. Schema additions (additive; no existing column altered or removed)

`storage_objects`: `id uuid PK` (app-generated), `company_id int` (no FK — tombstones must outlive the company), `kind` (`document|export|report|scan_image|branding_logo`), `entity_type`, `entity_id`, `reference` (the feature-column value), `storage_key` (canonical tenant key), `driver` (`fs|gcs|memory`), `legacy_key` (`gs://bucket/object` when known), `content_type`, `size_bytes bigint`, `sha256`, `state` (`pending|staged|active|deleting|deleted|failed`), `mirror_state`, `last_error`, `created_at`, `updated_at`, `deleted_at`. Indexes: unique `(company_id, kind, reference)`, `company_id`, `(state, updated_at)`, `(entity_type, entity_id)`. Applied with `pnpm --filter @workspace/db run push` (no versioned SQL migrations in this repository).

## 5. API and client contract

Unchanged response shapes: `POST /documents/upload-url → {uploadURL, objectPath}`, `GET /documents/{id}/download` and `/versions/{versionId}/download → {url, fileName, mimeType}`, `GET /exports/runs/{id}/download → {url, fileName}`, `downloadUrl` on export runs and executive reports, `logoUrl` on branding, `imageUrl` on scans, `/readyz` and `/healthz` bodies. New: `PUT /files/uploads/{id}` and `GET /files/{id}` (documented in `lib/api-spec/openapi.yaml`, tag `files`; clients never construct them), `FileUploadReceipt {sizeBytes, sha256}`, `MetricsSnapshot.storage`. Clients (`lib/api-client-react`, `lib/api-zod`) were regenerated. The unchanged web and mobile clients keep working because the URLs they PUT to / download from are absolute and self-contained, exactly like the former signed URLs. Documents' `fileSize` now records the **verified** stored size.

## 6. Configuration reference (`artifacts/api-server/src/config.ts`, `.env.example` §1d)

| Variable | Meaning | Default |
|---|---|---|
| `OBJECT_STORAGE_DRIVER` | `fs` / `gcs` / `memory` / `none`; unset → fs when a root is set, else gcs when a bucket is set, else memory outside production, else none | unset |
| `OBJECT_STORAGE_FS_ROOT` | absolute private directory (fs driver) | — |
| `OBJECT_STORAGE_ENCRYPTION_KEY` | 32-byte dedicated key; required in production fs mode | — |
| `OBJECT_STORAGE_TEST_EPHEMERAL_KEY` | non-production only: random per-process key | `false` |
| `OBJECT_STORAGE_LEGACY_FALLBACK` | serve references without an inventory row from the legacy bucket | `false` |
| `OBJECT_STORAGE_MIRROR` | `gcs` = strict mirrored writes | off |
| `OBJECT_STORAGE_LEGACY_DELETE` | physically delete legacy bucket objects on tombstone | `false` (never in Phase 1) |
| `OBJECT_STORAGE_UPLOAD_TTL_SEC` / `OBJECT_STORAGE_DOWNLOAD_TTL_SEC` | capability lifetimes | 900 / 300 |
| `OBJECT_STORAGE_PENDING_TTL_MS` / `OBJECT_STORAGE_STAGED_TTL_MS` / `OBJECT_STORAGE_SWEEP_BATCH` | sweep windows / batch | 1 h / 24 h / 200 |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS`, `GOOGLE_APPLICATION_CREDENTIALS`, `OBJECT_STORAGE_AUTH` | TEMPORARY legacy bucket (migration source / fallback / mirror) | unset |

Hosted compose: every `OBJECT_STORAGE_*` is passed through **empty** by default, so a deploy of this branch would keep the bucket driver unchanged (transition mode 1). The named volume `objectdata:/data/objects` and the image directory `/data/objects` (owned by the app user, `0700`) are prepared; `compose.vps.yml` carries the commented host bind mount for activation; nginx's `/api/` body limit was raised to 30 MiB for the 25 MiB document ceiling (the CloudPanel edge proxy limit is a hosted-activation check).

## 7. Local development setup (exact)

```bash
sudo install -d -m 700 -o "$USER" /var/lib/lcp-objects-dev          # any absolute dir OUTSIDE the repo
export OBJECT_STORAGE_DRIVER=fs
export OBJECT_STORAGE_FS_ROOT=/var/lib/lcp-objects-dev
export OBJECT_STORAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)            # keep it for the life of that directory
pnpm --filter @workspace/db run push                                    # adds storage_objects (verify the dev DB first)
# API shell (plus the B24 variables): PORT=8080 LOGIN_RATE_MAX=1000 JOBS_DRIVER=postgres … pnpm --filter @workspace/api-server run dev
# test shell: export the SAME three OBJECT_STORAGE_* values — test/b25-storage.test.ts asserts on-disk effects under the root
```

`GET /readyz` must report `checks.storage: "ok"`. Without any `OBJECT_STORAGE_*` and without a bucket the API selects the in-process memory driver outside production (uploads work for a single process; nothing survives a restart) — the formerly storage-gated suites then still run, but the B25 suite requires the fs root. Migration command (not needed locally unless a legacy bucket is configured): `pnpm --filter @workspace/api-server run migrate-storage -- --dry-run | --copy | --verify`.

## 8. Migration and hosted activation (future, owner-approved; NOT executed)

`scripts/migrate-storage.ts` (core `src/storage/migration.ts`, DB side `src/storage/migration-db.ts`): resumable and idempotent; `--dry-run` discovers every DB-referenced legacy object (document versions, export runs, executive reports, scan images, logos), attributes it to tenant + entity, registers it in the inventory and reports present / missing / already-copied; `--copy` copies with bounded concurrency (`--concurrency 1..16`, `--batch`), verifies size + SHA-256 by reading the target back, never overwrites a conflicting verified local object (reported as `conflict`), never deletes a source object, resumes on rerun (already-copied detection); `--verify` proves every migrated object exists and matches the inventory digest and reports rows still on the legacy driver. Output: sanitized machine-readable JSON (ids, kinds, counts, error codes — no keys, paths, bucket names, contents); exit 0 only when complete, 2 when incomplete/corrupt, 1 on configuration errors.

Transitional modes for the later hosted activation (each a separately approved step; rollback = revert the switch of that step, nothing destructive happens before step 7):

1. **Deploy without changing reads** — ship the code with every `OBJECT_STORAGE_*` unset: the api keeps the GCS driver (`driver: gcs` in `/metrics`), new writes still land in the bucket but are now inventoried.
2. **Prepare the volume and secrets** — create the private host directory (outside web root / Git, app uid, `0700`), generate `OBJECT_STORAGE_ENCRYPTION_KEY`, **owner stores the offline recovery copy**, set `OBJECT_STORAGE_DRIVER=fs`, `OBJECT_STORAGE_FS_ROOT=/data/objects`, `OBJECT_STORAGE_LEGACY_FALLBACK=true`, `OBJECT_STORAGE_MIRROR=gcs`; redeploy → strict mirrored writes (fs primary + bucket copy), legacy reads served from the bucket and registered.
3. **Copy + verify** — `migrate-storage --dry-run`, then `--copy` (resumable), then `--verify` until `complete: true`.
4. **fs-first reads with GCS fallback** — already the behaviour of migrated rows; watch `legacyFallbackReads` reach 0 and `migrationVerifyFailures` stay 0.
5. **Prove every referenced object exists and matches** — `--verify` complete, `/readyz` storage `ok`, smoke of upload/download/logo/scan/export on the hosted stack.
6. **Disable fallback and mirror** — unset `OBJECT_STORAGE_LEGACY_FALLBACK` / `OBJECT_STORAGE_MIRROR`; the bucket becomes read-nothing / write-nothing.
7. **Remove Google Cloud** — only after 1–6 are verified and a VPS-level backup of the volume + key recovery copy exists: delete the credential mount, env vars, `GCS_CREDENTIAL_GID`, the deploy-script credential check, `src/lib/objectStorage.ts`, `src/storage/gcs-driver.ts`, the `@google-cloud/storage` dependency, then (owner decision) the bucket objects.

Rollback at any step before 7: set `OBJECT_STORAGE_DRIVER` back to the previous value (or unset) and redeploy; inventory rows keep both locations (`storage_key` and `legacy_key`), so no data is lost. Tombstones are never resurrected by any mode.

## 9. Durability and backup implications

Until off-host storage is activated, product files on the VPS volume have **single-host durability**: a loss of the application VPS loses the files unless Hostinger-managed snapshots or a later off-host copy exist. The volume must be backed up **together with** the PostgreSQL database (the inventory) **and** the encryption key (offline, owner-controlled); a backup of the volume without the key is unreadable. `docs/BACKUP_AND_RECOVERY.md` records this as the B25 interim position; the deferred off-host design (B23 G-6D) remains non-blocking.

## 10. What remains before Google Cloud can be removed (honest list)

1. Owner approval and execution of the hosted phases 1–6 in §8 (separate task; not part of Phase 1).
2. A verified `migrate-storage --verify` run with `complete: true` against the hosted inventory, and `legacyFallbackReads` at 0 over an agreed observation window.
3. Owner-held offline recovery copy of `OBJECT_STORAGE_ENCRYPTION_KEY` and a backup procedure for the volume (§9).
4. Removal of the GCS driver, client, dependency, credentials, env vars and deploy-script check (step 7), then the bucket itself — only after 1–3.
5. Hosted-activation checks that Phase 1 could not perform: CloudPanel edge body-size limit ≥ 30 MiB for `/api/files/uploads/*`, volume ownership for the container uid, VPS disk capacity.

Until then: GCS is **temporarily available only for migration, fallback and mirror**; no claim that Google Cloud has been removed is made anywhere in this branch.

## 11. Verification performed in Phase 1 (local only, no live GCS, no hosted service)

Unit: `unit-storage-keys` (grammar / traversal / ownership), `unit-storage-envelope` (round trip, streaming, wrong key, key binding, tampering, reordering, truncation, trailing data, ceiling, key parsing), `unit-storage-fs-driver` (root validation, permissions, atomic publish + temp cleanup, integrity, overwrite, wrong key, corruption, cross-key copy, traversal / encoded traversal / NUL / absolute keys, symlink file and directory escapes, probe cleanup), `unit-storage-capability`, `unit-storage-config`, `unit-storage-migration` (dry run, copy, resume, missing source, conflict, checksum mismatch, failure, tombstone, concurrency, verify), `unit-storage-service` (legacy fallback registration, tenant-bound legacy keys, tombstone never resurrected, fs-first + legacy fallback, strict mirror success / failure, primary failure, DB failure after write, delete retry idempotency, company purge, sweep, metrics), `unit-health-storage`, `unit-metrics-live`. Integration (`test/b25-storage.test.ts`, fs driver): capability upload URL / 409 / 403 / 413-before-read, storage failure after reservation, cross-tenant handle 400, mimeType mismatch, download headers / HEAD / tampered-expired-mismatched-foreign tokens, no internals in payloads, scan image store / serve / replace tombstone, export artifact + capability download, logo replace tombstone + public route boundary + storage-failure rollback, company deletion purge, readiness cleanup, metrics block. The formerly storage-gated suites (`documents`, `ocr-pipeline`, `executive-intelligence`, `b9-reports-exports`, `b18-branding`) run green on the fs driver. Totals: `docs/LOCALHOST_DEVELOPMENT.md` §7.
