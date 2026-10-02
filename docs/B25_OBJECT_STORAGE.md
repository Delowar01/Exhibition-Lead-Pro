# B25 — Provider-Neutral Object Storage and Hostinger Filesystem Foundation (Phase 1)

> **Status (Phase 1, 2026-10-02): implemented and verified LOCALLY on branch
> `claude/b25-object-storage-hostinger`. NOT merged, NOT deployed, NOT migrated.**
> The hosted dev stack (`dev.kaptnow.com`) still runs the pre-B25 Google Cloud
> Storage path unchanged; no hosted object, credential, bucket or VPS was
> touched. Google Cloud Storage remains in the codebase **only** as the
> temporary legacy / migration / fallback driver. **B25 is not complete** until
> the owner-approved hosted phases below have been executed and verified, and
> Google Cloud can be removed only after that (§10).
>
> **Correction 1 (2026-10-02, same branch, local only):** safe pre-B25
> compatibility without new environment, authenticated private byte routes
> (no credential in any URL), race-free lease-based upload publication,
> primary + mirror rollback cleanup, real rollback to GCS from persisted copy
> locations, scan-image bind atomicity, genuinely read-only migration
> `--dry-run` / `--verify`, and duplicate-reference detection — §12. Still not
> merged, deployed, migrated or activated.

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

Consequence for the design: response shapes (`uploadURL`/`objectPath`, `url`/`fileName`/`mimeType`, `downloadUrl`) stay, `/objects/…` handles plus the branding key format remain valid references, and — since Correction 1 — upload and download URLs are **plain API URLs on the API's own origin that carry no credential**: the web and mobile clients were updated to send the normal session (and, for uploads, the header-bound capability) instead of treating the URL as self-contained (§3.5, §5).

## 3. Architecture

```
feature route (auth → tenant → permission)            clients (web / mobile)
        │  reserve / store / mint / delete                      │ opaque URLs only
        ▼                                                       ▼
services/storage.service.ts  ── ONE boundary ──►  routes/files.ts  (PUT /files/uploads/:id   GET /files/:id)
        │  write-ahead inventory row  ▲ session auth + tenant + permission; PUT adds the
        ▼                             │ header-bound capability (X-Storage-Capability, HMAC)
storage_objects (inventory, leases, tombstones, entity binding, digests, mirror / legacy copy locations)
        │
        ▼
storage/contract.ts  StorageDriver { put, getStream, head, exists, delete, probe }
   ├─ fs-driver.ts      encrypted files under OBJECT_STORAGE_FS_ROOT   (dev, tests, VPS)
   ├─ gcs-driver.ts     TEMPORARY legacy driver (fallback reads, mirror, migration source)
   └─ memory-driver.ts  deterministic in-process driver (unit tests only; refused in production)
```

**Trust boundaries.** Clients never see storage keys, filesystem paths, bucket names or provider URLs; they only receive opaque `/objects/<uuid>` handles (or the legacy-compatible `branding/<cid>/<32hex>.<ext>` key, which doubles as the public logo id) and credential-free byte URLs on the API's own origin (`/api/files/<object id>`). A client can never supply a company id, a storage key or a GCS location that controls access: the tenant comes from the authenticated user, keys are built server-side (`storage/keys.ts`), copy locations are read from the inventory row only, and every byte route re-checks the current user, the tenant, the operation, the row (ownership + state) and the feature permission at byte time (§3.5). Cross-tenant access keeps the existing conventions (404 for tenant resources, 403 for the platform-owner firewall, 400 "Invalid objectPath" for a foreign or unknown handle so the probe reveals nothing).

### 3.1 Storage contract (`src/storage/contract.ts`)

`put(key, Readable|Buffer, {contentType, maxBytes, expectedSha256?, expectedSize?, allowOverwrite?}) → {sizeBytes, sha256}` (plaintext size and SHA-256 computed in the write pipeline; `STORAGE_TOO_LARGE` past the ceiling; `STORAGE_CONFLICT` on an existing key unless overwrite is allowed; `STORAGE_INTEGRITY` when a declared digest/size differs), `getStream(key, {maxBytes}) → {stream, sizeBytes|null, contentType|null}` (bounded; `STORAGE_NOT_FOUND`), `head`, `exists`, `delete` (idempotent), `probe()` (bounded reachability). Errors are `StorageError` codes with fixed messages — never a path, key or bucket.

### 3.2 Canonical keys (`src/storage/keys.ts`)

`tenants/<companyId>/{documents|exports|reports|scans|branding}/<id>[.<ext>]` and `health/<id>`. Components are allow-listed (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`, no `..`), 2–6 components, tenant id numeric; absolute paths, `..`, `%2e%2e`, backslashes, NUL bytes, hidden names and unknown roots cannot form a key. Ids are random UUIDs (branding: 32-hex form).

### 3.3 Filesystem driver (`src/storage/fs-driver.ts`)

Root must be absolute, not `/`, outside the process working directory (the repository / bundle) and outside `/var/www`, `/usr/share/nginx`, `/etc`, `/proc`, `/sys`, `/dev`; created `0700`; a symlinked root is refused. Every component below the root is `lstat`ed and refused when it is a symbolic link (file or directory); files are opened `O_NOFOLLOW`; non-regular files are refused. Writes stream `plaintext → size/SHA-256 limiter → encryption → private 0600 temp file (`O_EXCL`) in the destination directory`, `fsync`, then publish (+ directory sync): with `allowOverwrite=false` (every first publication) the temp file is **hard-linked** to the final name — an atomic create-only operation that fails with `STORAGE_CONFLICT` when the final name already exists (an `exists` check followed by `rename` would be racy) — and with `allowOverwrite=true` (lease recovery, mirror re-copy) it is `rename`d; the writer unlinks only its **own** temp file on any failure and never a final object, so a partial object is never visible, a concurrent winner is never clobbered and plaintext never touches disk. Reads stream `file → authenticated decryption → bounded PassThrough`; integrity failures end the stream with a sanitized error. Directories are `0700`, files `0600`.

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

### 3.5 Authenticated byte routes (`src/routes/files.ts`, `src/storage/capability.ts`) — Correction 1

**No credential ever travels in a URL.** Download URLs are `https://<api origin>/api/files/<object id>` and upload targets `…/api/files/uploads/<object id>`; both are mounted behind `rejectQueryCredentials → requireAuth → requireTenantUser`, so a legacy `?t=` / `?token=` / `?capability=` is answered `403 STORAGE_QUERY_CREDENTIAL_REJECTED` before anything else, an unauthenticated request gets `401`, and a platform operator the usual `403` firewall.

**Request flow for a private byte (`GET /api/files/:id`, `HEAD` supported):** bearer token → `requireAuth` loads the fresh user row and the live server-side session (a logged-out, force-logged-out or deactivated user fails here on the very next request) → `requireTenantUser` → `storage.authorizeObject(user, id, "get")` resolves the inventory row **under the caller's tenant scope** (`canAccessCompany`; unknown or foreign object → `404`, no disclosure) and requires an `active` row → `permissionForKind(kind, "get")` is checked against the user's **current** permissions (documents → `documents.view` is implied by tenant access, exports → `reports.view`, executive reports → `ai_executive.view`; scan images and logos are tenant-only; a revoked permission takes effect immediately because `requireAuth` reloads permissions per request) → `openObject(row)` streams a readable copy (§3.6). Responses carry `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store, no-transform`, `X-Content-Type-Options: nosniff`, an exact `Content-Length` and a `Content-Disposition` (inline only for image / PDF / plain-text types) whose file name comes from the feature row, never from a client value. The web portal additionally declares `<meta name="referrer" content="no-referrer">`.

**Uploads (`PUT /api/files/uploads/:id`)** require the same session **plus** the secondary capability minted at reservation, presented only in the dedicated `X-Storage-Capability` header: `base64url(payload).base64url(HMAC-SHA256)` with payload `{v:1, op:"put", o:<object id>, c:<company id>, u:<user id>, exp}` signed with an HKDF-derived key (`SESSION_SECRET`, dedicated label; never the raw secret, never the object key), lifetime `OBJECT_STORAGE_UPLOAD_TTL_SEC` (900 s). The order of checks is: valid unexpired capability → row resolved under the current user's tenant (`404` otherwise) → capability bound to **this** object, tenant and user (`403 STORAGE_UPLOAD_INVALID` otherwise) → feature permission for the kind (`documents.create|edit`) → state (`409` if already published) → declared `Content-Length` beyond the kind's ceiling refused with `413` **before** reading → exclusive lease (§3.6). The route is mounted before the JSON parsers so the raw body streams straight into the boundary.

**Logging.** The request serializer (`src/lib/log-redaction.ts`) logs the path only (no query string, invitation tokens masked) and never serializes `Authorization`, `Cookie`, `Set-Cookie` or `X-Storage-Capability`; nginx-style access logs of these routes contain no secret because the URL carries none. `test/unit-files-log-redaction.test.ts` and `test/b25c1-files-auth.test.ts` assert both.

**Explicit public exceptions (unchanged):** the managed branding logo by its random id (`GET /branding/logos/:companyId/:id`) and the published card logo (`GET /cards/public/:token/logo`). They expose only their constrained projections and never the private byte route. There are no public signed URLs anywhere.

**Clients.** Web: `artifacts/web-app/src/lib/private-files.ts` (`fetchPrivateBlob`, `downloadPrivateFile`, `putPrivateUpload`) uses the generated client's `customFetch`, which attaches the session bearer and handles the 401 refresh; `DocumentsPanel`, the export panels and Executive Intelligence download through it (blob → object URL → save / preview) instead of navigating an `<a>`, `<img>` or `<iframe>` at the URL. Mobile: `artifacts/mobile/lib/private-files.ts` (`downloadPrivateFile`, `fetchPrivateBlob`, `openPrivateBlobInBrowser`, `putPrivateUpload`) sends the cached bearer with `FileSystem.downloadAsync` / `uploadAsync` and the capability header on uploads; `lib/documents.ts` and `lib/export-share.ts` use it. Scan images keep `GET /scans/:id/image` (bearer).

### 3.6 Object manager (`src/services/storage.service.ts`) — lifecycle

States: `pending → uploading → staged → active → deleting → deleted`, plus `failed`. **Reserve → claim → write → publish → release → activate**: the inventory row is written before any byte can land (`reserveUpload` returns `{objectId, reference, uploadURL, uploadToken}`; when strict mirroring is configured the row also persists its `mirror_key` at this point so a later cleanup always knows every copy). Client uploads move the row to `staged` after the verified write; `attachStaged(tx, …)` activates it **inside the feature transaction** (document / version insert) and refuses anything that is not a staged object of this tenant and kind with the reserved content type; server-side writes (`storeBuffer`) activate after the write and bind the entity (export run / report / scan / company). Only `active` rows are ever served.

**Race-free publication (Correction 1).** Before a single byte is accepted, `receiveUpload` performs a database compare-and-set claim (`repo.claimUpload`): `pending` / `failed` (or `uploading` with an **expired** lease) → `uploading` with a random lease token and `lease_expires_at = now + OBJECT_STORAGE_UPLOAD_LEASE_MS` (15 min default, ≥ 10 s). Exactly one writer per upload intent wins; a concurrent PUT finds the row claimed and is answered `409 STORAGE_UPLOAD_IN_PROGRESS` (or `409 STORAGE_CONFLICT` once published) without ever touching the object. The winner writes with `allowOverwrite=false` — the fs driver publishes atomically with a create-only hard link (§3.3), the GCS driver with `ifGenerationMatch: 0` (a 412 becomes `STORAGE_CONFLICT`, nothing is deleted), the memory driver with an atomic check-and-set — and then releases the lease with a second CAS on its own token (`repo.releaseUpload`): a writer whose lease was lost in the meantime gets `409 STORAGE_UPLOAD_LEASE_LOST` and **never deletes anything**, because only the lease owner may roll back. A crashed writer leaves an `uploading` row whose lease expires; the sweep moves it to `failed` (`LEASE_EXPIRED`) and the failed-row pass removes its unverified copies, while a new client PUT may reclaim it (`allowOverwrite=true` only in that recovery path, replacing the writer's own unverified leftover). Temp files are removed only by the writer that created them. Fault-injection coverage: `test/b25c1-concurrency.test.ts` (barrier-controlled two-writer races on the fs driver and on the fake GCS adapter: one success, one 409, exactly one staged row, bytes = winner, no temp file, no successful object deleted; lease loss; expired-lease recovery), `test/b25-storage.test.ts` (two concurrent HTTP PUTs).

**One idempotent rollback helper (Correction 1).** Every write builds a `WriteAttempt` listing the **exact** copies it produced (primary key, mirror key); `rollbackAttempt(attempt, reason)` deletes those copies — both of them — on any failure before the inventory commit (mirror failure under strict mode, database failure after the write, integrity failure) and marks the row `failed` with a sanitized reason (`MIRROR_FAILED`, `DB_FAILURE`, the storage error code) or `CLEANUP_PENDING` when a provider refused the delete; `CLEANUP_PENDING` rows stay discoverable (`/metrics.storage.pendingDeletes`, `listStale("failed")`) and the sweep / delete job retries exactly those copies. Because the copy list comes from the attempt and the row, cleanup is independent of the configuration that applies later, and a retry can never remove another request's committed object (`test/b25c1-service.test.ts` §5).

**Pre-B25 compatibility — `legacyReadMode()` (Correction 1).** A reference without an inventory row is a pre-B25 object. It is served from the legacy bucket when:

| Configuration | `legacyReads` | Behaviour |
|---|---|---|
| GCS is the primary driver (`OBJECT_STORAGE_DRIVER` unset or `gcs` with a bucket — **the hosted stack today**) | `primary` | **Automatic, no new environment variable**: served, and registered in the inventory on first use (`driver=gcs`, `legacy_key`). No dangerous window exists on deployment. |
| Non-GCS primary (fs) with `OBJECT_STORAGE_LEGACY_FALLBACK=true` | `fallback` | Served and registered (counted as `legacyFallbackReads`); the explicit transition state while the migration runs. |
| Non-GCS primary, fallback off | `off` | Never served: an unregistered legacy reference is a 404. This is the post-migration state — nothing falls back silently. |

Serving a legacy reference is **ownership-checked**: document / export / report handles (`/objects/uploads/<uuid>`) are not tenant-namespaced in the bucket, so a handle is served only to the tenant whose `document_versions.object_path`, `export_runs.object_path` or `executive_reports.object_path` row carries it; scan (`scans/<cid>/<id>.jpg`) and logo (`branding/<cid>/<id>.<ext>`) keys embed the tenant id, must match the caller and are also cross-checked against the feature row. Unknown keys, cross-tenant keys and tombstoned references are never served. **Registration therefore happens lazily** (first read, first delete, company deletion) and in bulk by `migrate-storage --copy`; `--dry-run` / `--verify` only report what registration would do. Deleting a legacy reference writes a `deleted` tombstone with `LEGACY_RETAINED` (the bucket object is kept while `OBJECT_STORAGE_LEGACY_DELETE` is off) — such rows are excluded from the tombstone purge and listed by `countRetainedLegacyObjects` (`/metrics.storage.retainedLegacyObjects`) so nothing is silently left behind. **Company deletion** first discovers every legacy reference of the tenant (`discoverLegacyReferences({companyId, tx})`: document versions, export runs, executive reports, scans, the branding logo), registers each as a `deleting` tombstone **inside the deletion transaction**, then tombstones the native rows (`tombstoneCompany`), so the purge job sees every object and the test `b25c1-service › 1b` proves no untracked legacy object remains.

**Real rollback to GCS — persisted copies only (Correction 1).** `locateCopies(row)` lists the copies readable under the **current** configuration, in order, from persisted locations only: the primary copy when the configured driver kind equals `row.driver`; and, when GCS is the active driver or the explicit fallback is on, the strict-mirror copy **only if `mirror_state = "ok"`** (`mirror_key`) and the legacy / migration-source copy (`legacy_key`). `openObject` tries them in order and otherwise fails closed with `STORAGE_UNAVAILABLE` / reason `NO_READABLE_COPY`. A failed or incomplete mirror is never presented as a rollback copy; a client value never selects a copy; a row of another tenant is unreachable by construction (the row is resolved under the caller's tenant first). Proven by `test/b25c1-service.test.ts` §2: legacy → migrated → driver switched back to GCS → readable; fs primary + successful strict mirror → switched → readable via the mirror; mirror failed → switched → fails closed with the sanitized reason; cross-tenant resolution impossible. Prerequisites and limits: §8.

**Scan images (Correction 1).** `scans.service.storeAndBindScanImage` stores the new object, then binds it to the scan row with a compare-and-set (`scansRepo.bindImage(scanId, companyId, reference, expectedPrevious)`); if the bind throws or returns false (the scan changed or disappeared) the **new** object is tombstoned at once (a failed tombstone is retried by the sweep) and the previous image is untouched; only after the bind committed is the previous reference retired (tombstone-first, physical delete retried by the durable job). A crash between activation and bind leaves an active object no scan references: the sweep's **entity-orphan pass** retires any active object no feature row references any more, after a grace window of `OBJECT_STORAGE_PENDING_TTL_MS` so a binding transaction in flight is never raced (`test/b25c1-scans.test.ts`: injected bind failures on initial upload and replacement, cleanup retry, orphan detection, no cross-tenant effect).

**Strict mirror (transition only).** `OBJECT_STORAGE_MIRROR=gcs` copies every primary write to the bucket under the canonical key (`mirror_key = gs://<bucket>/<storage key>`, persisted at reservation); a mirror failure fails the write, rolls back **both** copies and counts `mirrorFailures`; `mirror_state = "ok"` is the only state that makes the mirror a rollback copy.

**Maintenance sweep (`storageSweep` in the recurring maintenance task).** Expired upload leases → `failed`; reserved-but-never-uploaded rows past `OBJECT_STORAGE_PENDING_TTL_MS`; uploaded-but-never-attached rows past `OBJECT_STORAGE_STAGED_TTL_MS`; `failed` rows (including `CLEANUP_PENDING`); `deleting` retries; objects whose company no longer exists; active objects **no feature row references** (document version, export run, executive report, scan image, company logo — a reference shared by several rows is kept while any of them lives, `b25c1-service › 8`), after the grace window; and day-old tombstones of deleted companies, never a `LEGACY_RETAINED` record — bounded by `OBJECT_STORAGE_SWEEP_BATCH`, idempotent.

### 3.7 Readiness, metrics, logs

`GET /readyz` keeps its body contract; `checks.storage` now probes the **primary driver**: fs = write → read → verify → delete of one random 1 KiB object under `health/` with a 2.5 s budget, no path in the response, nothing left behind; gcs = the legacy single-object list; `not_configured` when no driver. `GET /metrics` (platform owner) gains an additive `storage` block (driver, `legacyFallback`, `mirror`, **`legacyReads`** = `primary` / `fallback` / `off` (the compatibility state, §3.6), counters `primaryFailures` / `legacyFallbackReads` / **`legacyRegistrations`** / `mirrorFailures` / `migrationVerifyFailures` / `deleteFailures`, inventory backlog `pendingUploads` / `pendingDeletes` / **`retainedLegacyObjects`** — `null` when the inventory cannot be read, never a fabricated 0; no key, bucket name or path). Structured logs carry ids, kinds, tenant ids and error codes only — never contents, credentials, tokens, paths or full checksums. Startup (`initStorage`) validates the configuration and refuses to boot a production node with an unusable root or a missing key.

## 4. Schema additions (additive; no existing column altered or removed)

`storage_objects`: `id uuid PK` (app-generated), `company_id int` (no FK — tombstones must outlive the company), `kind` (`document|export|report|scan_image|branding_logo`), `entity_type`, `entity_id`, `reference` (the feature-column value), `storage_key` (canonical tenant key), `driver` (`fs|gcs|memory`), `legacy_key` (`gs://bucket/object` when known), `content_type`, `size_bytes bigint`, `sha256`, `state` (`pending|uploading|staged|active|deleting|deleted|failed`), `mirror_state`, `last_error`, `created_at`, `updated_at`, `deleted_at`. **Correction 1 (additive, nullable):** `mirror_key` (persisted mirror location — the rollback copy when `mirror_state = "ok"`, the cleanup target otherwise), `lease_token`, `lease_expires_at` (exclusive upload publication lease); new state `uploading`; the sentinel `last_error = LEGACY_RETAINED` marks a tombstone whose bucket object was deliberately kept. Applied to the **local** dev database only — the hosted database is untouched. Indexes: unique `(company_id, kind, reference)`, `company_id`, `(state, updated_at)`, `(entity_type, entity_id)`. Applied with `pnpm --filter @workspace/db run push` (no versioned SQL migrations in this repository).

## 5. API and client contract

Response shapes: `POST /documents/upload-url → {uploadURL, objectPath, uploadToken}` (**`uploadToken` added in Correction 1** — the header-bound capability the client must send as `X-Storage-Capability`), `GET /documents/{id}/download` and `/versions/{versionId}/download → {url, fileName, mimeType}`, `GET /exports/runs/{id}/download → {url, fileName}`, `downloadUrl` on export runs and executive reports, `logoUrl` on branding, `imageUrl` on scans, `/readyz` and `/healthz` bodies — all unchanged in shape, but `uploadURL` / `url` / `downloadUrl` now carry **no credential** and are served only to the authenticated session (§3.5). Routes: `PUT /files/uploads/{id}` (bearer + `X-Storage-Capability`; `401` / `403` / `404` / `409` / `413`) and `GET /files/{id}` (bearer; `401` / `403` / `404`) documented in `lib/api-spec/openapi.yaml` (tag `files`; clients never construct them), `FileUploadReceipt {sizeBytes, sha256}`, `MetricsSnapshot.storage` (+ `legacyReads`, `legacyRegistrations`, `retainedLegacyObjects`). Clients (`lib/api-client-react`, `lib/api-zod`) were regenerated. **Web and mobile clients were updated** to fetch private bytes with the normal session (`private-files.ts` in each app); a pre-Correction-1 client that PUT without headers or opened the URL directly now receives `401`. Documents' `fileSize` records the **verified** stored size.

## 6. Configuration reference (`artifacts/api-server/src/config.ts`, `.env.example` §1d)

| Variable | Meaning | Default |
|---|---|---|
| `OBJECT_STORAGE_DRIVER` | `fs` / `gcs` / `memory` / `none`; unset → fs when a root is set, else gcs when a bucket is set, else memory outside production, else none | unset |
| `OBJECT_STORAGE_FS_ROOT` | absolute private directory (fs driver) | — |
| `OBJECT_STORAGE_ENCRYPTION_KEY` | 32-byte dedicated key; required in production fs mode | — |
| `OBJECT_STORAGE_TEST_EPHEMERAL_KEY` | non-production only: random per-process key | `false` |
| `OBJECT_STORAGE_LEGACY_FALLBACK` | non-GCS primary only: serve references without an inventory row from the legacy bucket (`legacyReads: fallback`). **Not needed while GCS is the primary** — compatibility is automatic there (`legacyReads: primary`) | `false` |
| `OBJECT_STORAGE_MIRROR` | `gcs` = strict mirrored writes; the persisted, verified mirror is the rollback copy | off |
| `OBJECT_STORAGE_LEGACY_DELETE` | physically delete legacy bucket objects on tombstone | `false` (never in Phase 1) |
| `OBJECT_STORAGE_UPLOAD_TTL_SEC` | upload capability lifetime (header-bound). The former `OBJECT_STORAGE_DOWNLOAD_TTL_SEC` is retired: downloads carry no capability | 900 |
| `OBJECT_STORAGE_UPLOAD_LEASE_MS` | exclusive upload publication lease; an expired lease is reclaimable (crash recovery); must exceed the longest acceptable single upload | 15 min (≥ 10 s) |
| `OBJECT_STORAGE_PENDING_TTL_MS` / `OBJECT_STORAGE_STAGED_TTL_MS` / `OBJECT_STORAGE_SWEEP_BATCH` | sweep windows (pending TTL doubles as the entity-orphan grace window) / batch | 1 h / 24 h / 200 |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS`, `GOOGLE_APPLICATION_CREDENTIALS`, `OBJECT_STORAGE_AUTH` | TEMPORARY legacy bucket (migration source / fallback / mirror) | unset |

Hosted compose: every `OBJECT_STORAGE_*` is passed through **empty** by default, so a deploy of this branch would keep the bucket driver unchanged (transition step 1) with every pre-B25 object still readable through `legacyReads: primary` — no new variable, no filesystem activation, no window in which existing files are unreachable. The named volume `objectdata:/data/objects` and the image directory `/data/objects` (owned by the app user, `0700`) are prepared; `compose.vps.yml` carries the commented host bind mount for activation; nginx's `/api/` body limit was raised to 30 MiB for the 25 MiB document ceiling (the CloudPanel edge proxy limit is a hosted-activation check).

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

`scripts/migrate-storage.ts` (core `src/storage/migration.ts`, DB side `src/storage/migration-db.ts`), resumable and idempotent. **Discovery is separated from mutation** (Correction 1):

| Mode | Reads | Writes | Purpose |
|---|---|---|---|
| `--dry-run` | DB feature tables, inventory, source bucket (`head`), target (`head` for already-present copies) | **none** — zero inventory rows, zero objects (proven with adapters that throw on any mutating method, `test/b25c1-migration.test.ts`) | report what registration and copying would do: `sourceReferences`, `uniqueObjects`, `registrationsPlanned`, `planned` / `already` / `missing_source`, duplicate groups |
| `--copy` | same | registers unregistered references in the inventory (`driver=gcs`, `legacy_key`), copies with bounded concurrency (`--concurrency 1..16`, `--batch`), verifies size + SHA-256 by reading the target back, flips the row to the target driver; never overwrites a conflicting local object (`conflict`), never deletes a source object, resumes on rerun | the only mutating mode |
| `--verify` | same | **none** | prove every migrated object exists and matches the inventory digest; report rows still on the legacy driver (`not_migrated`) and references not yet registered (`unregistered`) |

Output: sanitized machine-readable JSON (ids, kinds, counts, error codes, a 16-hex-character hash of a legacy key where a group must be identified — never keys, paths, bucket names or contents); exit 0 only when complete, 2 when incomplete / corrupt, 1 on configuration errors (`--copy` / `--dry-run` need the bucket configured and `OBJECT_STORAGE_DRIVER=fs`; `OBJECT_STORAGE_LEGACY_DELETE` must be off).

**Duplicate legacy references (Correction 1).** Candidates are grouped by `(company, kind-independent legacy key)`; a group with more than one feature row (several document versions sharing one object, or a cross-feature collision such as an export run and a report pointing at one key) is reported once as `DUPLICATE_REFERENCE` with the company, the sanitized key hash, the kinds and the entity ids, counted under `duplicate`, and **marks the run incomplete**: copy and cutover are blocked until the owner resolves the association (the inventory keys one row per `(company, kind, reference)` and does not model several associations). Deleting one of the associations never tombstones bytes another live row still references (the sweep decides orphans by live feature references, §3.6), and `--verify` keeps failing while duplicates remain.

Transitional steps for the later hosted activation (each separately approved; rollback = revert that step's switch; nothing destructive happens before step 7):

1. **Deploy without changing reads** — ship the code with every `OBJECT_STORAGE_*` unset: the api keeps the GCS driver (`driver: gcs`, `legacyReads: primary` in `/metrics`); every pre-B25 object is served as before and registered on first use; new writes land in the bucket, inventoried and lease-protected.
2. **Prepare the volume and secrets** — create the private host directory (outside web root / Git, app uid, `0700`), generate `OBJECT_STORAGE_ENCRYPTION_KEY`, **owner stores the offline recovery copy**, set `OBJECT_STORAGE_DRIVER=fs`, `OBJECT_STORAGE_FS_ROOT=/data/objects`, `OBJECT_STORAGE_LEGACY_FALLBACK=true`, `OBJECT_STORAGE_MIRROR=gcs`; redeploy → strict mirrored writes (fs primary + verified bucket copy with `mirror_key` / `mirror_state`), legacy reads served from the bucket and registered (`legacyReads: fallback`).
3. **Copy + verify** — `migrate-storage --dry-run` (read-only), resolve any `DUPLICATE_REFERENCE`, then `--copy` (resumable), then `--verify` (read-only) until `complete: true`.
4. **fs-first reads with GCS fallback** — the behaviour of migrated rows; watch `legacyFallbackReads` reach 0, `migrationVerifyFailures` and `mirrorFailures` stay 0.
5. **Prove every referenced object exists and matches** — `--verify` complete, `/readyz` storage `ok`, smoke of upload / download / logo / scan / export on the hosted stack with the updated web and mobile clients.
6. **Disable fallback and mirror** — unset `OBJECT_STORAGE_LEGACY_FALLBACK` / `OBJECT_STORAGE_MIRROR` (`legacyReads: off`); the bucket becomes read-nothing / write-nothing. **This is the last step at which configuration rollback alone restores GCS for objects written after step 2** — see the limits below.
7. **Remove Google Cloud** — only after 1–6 are verified, `retainedLegacyObjects` has been reviewed, and a VPS-level backup of the volume + key recovery copy exists: delete the credential mount, env vars, `GCS_CREDENTIAL_GID`, the deploy-script credential check, `src/lib/objectStorage.ts`, `src/storage/gcs-driver.ts`, the `@google-cloud/storage` dependency, then (owner decision) the bucket objects.

**Rollback prerequisites and exact limits (Correction 1).** Rollback = set `OBJECT_STORAGE_DRIVER` back to `gcs` (or unset) and redeploy; reads then come from persisted copy locations only (§3.6):

- Objects that existed before B25, migrated or not: readable as long as their bucket object exists (`legacy_key`; `OBJECT_STORAGE_LEGACY_DELETE` off). Prerequisite: none beyond the bucket credentials.
- Objects written while the strict mirror was on (steps 2–5) with `mirror_state = "ok"`: readable from `mirror_key`. Prerequisite: the mirror was enabled **before** the fs cutover and every write succeeded under strict mode (a mirror failure fails the write, so no "half-mirrored" active object exists).
- Objects written with the mirror **off** (after step 6, or if step 2 skipped the mirror): **no GCS copy exists — rollback to GCS loses them**. The row fails closed (`NO_READABLE_COPY`) rather than serving a wrong object.
- **Point of no return:** once legacy / mirror objects are deleted from the bucket (`OBJECT_STORAGE_LEGACY_DELETE=true`, step 7, or manual bucket cleanup) rollback for those objects is impossible; `retainedLegacyObjects` and `legacyFallbackReads = 0` over the observation window are the signals to review before that step.
- Tombstones are never resurrected by any mode; inventory rows keep every location (`storage_key`, `mirror_key`, `legacy_key`) so a rollback never has to guess.

## 9. Durability and backup implications

Until off-host storage is activated, product files on the VPS volume have **single-host durability**: a loss of the application VPS loses the files unless Hostinger-managed snapshots or a later off-host copy exist. The volume must be backed up **together with** the PostgreSQL database (the inventory) **and** the encryption key (offline, owner-controlled); a backup of the volume without the key is unreadable. `docs/BACKUP_AND_RECOVERY.md` records this as the B25 interim position; the deferred off-host design (B23 G-6D) remains non-blocking.

## 10. What remains before Google Cloud can be removed (honest list)

1. Owner approval and execution of the hosted phases 1–6 in §8 (separate task; not part of Phase 1).
2. A verified `migrate-storage --verify` run with `complete: true` (no `unregistered`, `not_migrated`, `duplicate` or mismatch) against the hosted inventory, `legacyFallbackReads` at 0 over an agreed observation window, and a reviewed `retainedLegacyObjects` count (tombstoned legacy objects deliberately kept in the bucket).
3. Owner-held offline recovery copy of `OBJECT_STORAGE_ENCRYPTION_KEY` and a backup procedure for the volume (§9).
4. Removal of the GCS driver, client, dependency, credentials, env vars and deploy-script check (step 7), then the bucket itself — only after 1–3.
5. Hosted-activation checks that Phase 1 could not perform: CloudPanel edge body-size limit ≥ 30 MiB for `/api/files/uploads/*`, volume ownership for the container uid, VPS disk capacity.

Until then: GCS is **temporarily available only as the current hosted primary, the migration source, the fallback and the mirror**; no claim that Google Cloud has been removed is made anywhere in this branch. The second backup VPS / off-host copy (B23 G-6D, deferred by the owner) is **not** a prerequisite for any step above and does not block B25.

## 11. Verification performed (local only, no live GCS, no hosted service)

Unit: `unit-storage-keys` (grammar / traversal / ownership), `unit-storage-envelope` (round trip, streaming, wrong key, key binding, tampering, reordering, truncation, trailing data, ceiling, key parsing), `unit-storage-fs-driver` (root validation, permissions, atomic publish + temp cleanup, integrity, overwrite, wrong key, corruption, cross-key copy, traversal / encoded traversal / NUL / absolute keys, symlink file and directory escapes, probe cleanup), `unit-storage-capability`, `unit-storage-config`, `unit-storage-migration` (read-only dry run, copy, resume, missing source, conflict, checksum mismatch, failure, tombstone, concurrency, verify), `unit-storage-service` (legacy fallback registration with ownership, tenant-bound legacy keys, tombstone never resurrected, fs-first + legacy fallback, strict mirror success / failure, primary failure, DB failure after write → rolled back and settled, delete retry idempotency, company purge, sweep, metrics), `unit-health-storage`, `unit-metrics-live`, `unit-files-log-redaction`. **Correction 1 suites:** `b25c1-service` (pre-B25 compatibility in GCS-primary mode for every kind, cross-tenant / unknown / unowned handles, diagnostics, company-deletion registration, rollback to GCS, primary + mirror cleanup, shared references), `b25c1-migration` (zero-write dry-run / verify with throwing adapters, duplicate groups incl. version and cross-feature fixtures, verify fails while duplicates remain), `b25c1-concurrency` (barrier races on fs and fake GCS, lease loss, expired-lease recovery), `b25c1-scans` (bind failures, replacement, cleanup retry, orphan grace window), `b25c1-files-auth` (HTTP: 401 / 403 / 404 / query credential / logout / deactivation / revoked permission / foreign tenant / headers / log fixtures / public logo and card routes). Integration (`test/b25-storage.test.ts`, fs driver): authenticated upload target / 409 / 401 / 403 / 404 / 413-before-read, concurrent PUTs, storage failure after reservation, cross-tenant handle 400, mimeType mismatch, download headers / HEAD / no-credential URLs, no internals in payloads, scan image store / serve / replace tombstone, export artifact download, logo replace tombstone + public route boundary + storage-failure rollback, company deletion purge, readiness cleanup, metrics block. The formerly storage-gated suites (`documents`, `ocr-pipeline`, `executive-intelligence`, `b9-reports-exports`, `b18-branding`) run green on the fs driver with the authenticated flow. Totals: `docs/LOCALHOST_DEVELOPMENT.md` §7.

## 12. Correction 1 (2026-10-02) — defects found in the Phase 1 baseline and their fixes

Each defect was first reproduced by a failing test against the Phase 1 head (`df7392a…`), then fixed; the red evidence is in the batch report.

| # | Defect in Phase 1 | Fix | Proof |
|---|---|---|---|
| 1 | Pre-B25 objects were served only with `OBJECT_STORAGE_LEGACY_FALLBACK=true` — a plain deploy would have made every existing file unreachable; company deletion ignored unregistered legacy objects | `legacyReadMode()` (`primary` / `fallback` / `off`), ownership-checked lazy registration, `LEGACY_RETAINED` tombstones, legacy discovery inside `tombstoneCompany`, `legacyReads` / `legacyRegistrations` / `retainedLegacyObjects` in `/metrics` | `b25c1-service` §1, §1b; `unit-storage-service` |
| 2 | Rollback to GCS was only asserted: `driverFor()` threw for rows whose driver no longer matched the configuration; the mirror location was not persisted | `mirror_key` persisted at reservation, `locateCopies()` over persisted locations, fail-closed `NO_READABLE_COPY`, mirror usable only when `mirror_state = "ok"` | `b25c1-service` §2 |
| 3 | Capability secrets travelled in `?t=` query strings on upload and download URLs (proxy logs, history, referrers); byte routes needed no session, so a logged-out or deactivated user could keep using a URL | Session-authenticated byte routes, header-bound upload capability, byte-time re-validation of user / tenant / operation / ownership / permission, query credentials rejected, redacted request serializer, `Referrer-Policy: no-referrer`, updated web and mobile clients | `b25c1-files-auth`, `b25-storage`, `unit-files-log-redaction`, `documents` |
| 4 | Two concurrent PUTs for one reserved object could both succeed (`exists` + `rename` race; GCS put without a precondition) | DB lease claim / release (CAS), create-only hard-link publish, `ifGenerationMatch: 0`, lease-owner-only rollback, expired-lease recovery | `b25c1-concurrency`, `b25-storage` (concurrent PUT) |
| 5 | A failed commit removed the primary copy only; the mirror copy and a failed cleanup were not tracked | `WriteAttempt` + `rollbackAttempt()` over exact copies, `CLEANUP_PENDING` discoverability and retry, no cross-request deletion | `b25c1-service` §5; `unit-storage-service` |
| 6 | A scan image was activated before the scan row was bound; the previous image was retired before the new reference committed | `storeAndBindScanImage` with CAS bind, new-object tombstone on bind failure, old image retired only after commit, entity-orphan grace window | `b25c1-scans` |
| 7 | `--dry-run` registered inventory rows (a write) | Read-only `--dry-run` / `--verify` (`findByReference` only; `register` / `update` only in `--copy`), `registrationsPlanned` reported instead | `b25c1-migration`, `unit-storage-migration` |
| 8 | Several feature rows pointing at one legacy object were registered as one row and the second association silently lost | Duplicate grouping (`DUPLICATE_REFERENCE`, sanitized), run marked incomplete, copy / cutover blocked, orphan decisions by live feature references | `b25c1-migration`, `b25c1-service` §8 |
