// TEMPORARY — B25 Stage 1 disposable smoke, run on the GitHub runner against the
// public API origins (ONE-OFF ops script, not application code). No OCR, Gemini,
// SMTP or Stripe is touched. Everything it creates is disposable (tenant names
// "B25 SMOKE <tag>", e-mails under b25smoke.invalid) and is removed by the
// workflow's always-step. Prints ids, status codes and booleans only — never a
// token, capability, password, URL with credentials, bucket name or key.
//
// CREDENTIAL HYGIENE (run 38005492289 correction): a genuine capability, bearer token or
// password is NEVER placed in a URL — the only query-string requests this script sends carry
// the clearly synthetic, never-valid value SYNTHETIC_QUERY_CREDENTIAL, and the api() helper
// refuses any other query value. The capability travels only in X-Storage-Capability. The
// state file records a TOKEN-SPECIFIC leak detector (the capability's HMAC signature
// component, unique per capability) instead of the former 16-character prefix, which is
// shared by every capability (base64url of the same JSON payload head) and therefore matched
// historical log lines of other runs.
//
// STEP=run       create 2 disposable tenants (+ admin/employee users), exercise
//                the first-party upload / download contract, branding logo
//                upload / read / replace / remove; write ids to OUT (JSON)
// STEP=recheck   (after the api container was recreated) read the smoke
//                document again, then delete the disposable tenants through
//                the product API (tombstones + purge job)
// STEP=postcheck (after smoke-settle) every /metrics storage counter back at the
//                pre-smoke baseline recorded by STEP=run
// STEP=teardown  always-step: delete the disposable tenants if they still exist
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

// Split-portal deployment (artifacts/api-server/src/lib/portal-host.ts): a platform_owner may
// sign in only on the platform portal and tenant roles only on the customer portal — the API
// refuses the other combination with 403 before any session exists. Platform-owner login and
// platform administration (companies, users, metrics) therefore use PLATFORM; tenant login,
// tenant file operations, branding and public file / logo reads use CUSTOMER. Both origins are
// fixed constants: nothing taken from a response ever selects an origin.
const HOSTED_CUSTOMER = "https://admin.kaptnow.com";
const HOSTED_PLATFORM = "https://elite.kaptnow.com";
// Local dry run only (development stack / local harness): SMOKE_BASE must be exactly
// http://localhost:80; SMOKE_PLATFORM_BASE may then name a second LOOPBACK http origin that
// stands in for the platform portal (default: the same localhost origin, where every role is
// accepted). Neither variable can redirect a hosted run.
const LOCAL = process.env.SMOKE_BASE === "http://localhost:80";
if (process.env.SMOKE_BASE && !LOCAL) throw new Error("SMOKE_BASE is accepted only as http://localhost:80 (local dry run)");
if (process.env.SMOKE_PLATFORM_BASE && (!LOCAL || !/^http:\/\/(localhost|127\.0\.0\.1):[0-9]{2,5}$/.test(process.env.SMOKE_PLATFORM_BASE))) throw new Error("SMOKE_PLATFORM_BASE is accepted only in the local dry run and only as a loopback http origin");
const CUSTOMER = LOCAL ? "http://localhost:80" : HOSTED_CUSTOMER;
const PLATFORM = LOCAL ? (process.env.SMOKE_PLATFORM_BASE || "http://localhost:80") : HOSTED_PLATFORM;
// B25 STAGE 2A CORRECTION 1 (run 38847884691): the stored-logo facts (logoSha / logoSize) are the
// bytes the first-party logo route SERVED, never the uploaded fixture — the product normalizes logos.
// B25 STAGE 2A CORRECTION 2 (run 38922592504): the AUTHENTICATED tenant logo route is the authoritative
// served observation; the public randomized route must serve the identical bytes; Content-Length is
// validated only when present (contentLengthRule / servedLogoRule below).
// B25 STAGE 2A: SMOKE_STAGE=2a runs the SAME first-party contract against the filesystem
// primary with the strict GCS mirror (ops/b25-stage2a-fs-activation-tooling). Differences:
// a DETERMINISTIC fixture carrying a plaintext marker (the VPS side proves the encrypted
// file never contains it), the branding logo is uploaded once and kept for the tenant
// purge (no replace / remove), and the metrics block must report driver=fs,
// legacyFallback=true, mirror=true, legacyReads=fallback. Tenant B still stores nothing
// (it exists only as the foreign principal of the cross-tenant 404 probe).
const STAGE = process.env.SMOKE_STAGE || "1";
if (STAGE !== "1" && STAGE !== "2a") throw new Error("SMOKE_STAGE must be 1 or 2a");
const STAGE2A = STAGE === "2a";
const STEP = process.env.STEP || "run";
const TAG = process.env.SMOKE_TAG || "";
const OUT = process.env.SMOKE_OUT || "";
const PO_EMAIL = process.env.PO_EMAIL || "";
const PO_PASSWORD = process.env.PO_PASSWORD || "";
if (!/^[a-z0-9]{6,12}$/.test(TAG)) throw new Error("SMOKE_TAG must be 6-12 lowercase alphanumerics");
if (!OUT) throw new Error("SMOKE_OUT is required");
if (!/^b25-smoke-[a-z0-9]{6,12}-owner@b25smoke\.invalid$/.test(PO_EMAIL)) throw new Error("PO_EMAIL is not the disposable owner address");
if (PO_PASSWORD.length < 24) throw new Error("PO_PASSWORD missing");

const results = [];
let failures = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}
function must(name, ok, detail = "") {
  check(name, ok, detail);
  if (!ok) throw new Error(`stop: ${name}`);
}
// Fixed-string error details only (code + message of the API's ErrorResponse); never a token, URL or path.
const errDetail = (r) => `status ${r.status}${r.json && (r.json.code || r.json.error) ? ` ${r.json.code || ""} ${String(r.json.error || r.json.message || "").slice(0, 80)}` : ""}`;
// The ONLY value this script ever places in a query string: clearly synthetic and never a valid
// credential (not a capability, not a bearer token, not a password). Its sole purpose is to prove
// that the product refuses credential-named query parameters before anything else is evaluated.
const SYNTHETIC_QUERY_CREDENTIAL = "b25-smoke-SYNTHETIC-NOT-A-CREDENTIAL";
const CREDENTIAL_QUERY_KEYS = new Set(["t", "token", "capability"]);
async function api(method, path, { token, body, headers = {}, raw = false, capability, origin = CUSTOMER } = {}) {
  if (origin !== CUSTOMER && origin !== PLATFORM) throw new Error("api: unknown origin");
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new Error("api: path must be origin-relative");
  // Structural guard: a query string may carry ONLY credential-named keys with the synthetic value
  // (the deliberate rejection probes). Any other query value — in particular anything that could be a
  // genuine capability, bearer token or password — is refused here, before a request exists.
  const q = new URL(path, "http://query-guard.invalid").searchParams;
  for (const [k, v] of q) {
    if (!CREDENTIAL_QUERY_KEYS.has(k) || v !== SYNTHETIC_QUERY_CREDENTIAL) throw new Error("api: refusing a query-string value that is not the synthetic probe");
  }
  if (path.includes("#")) throw new Error("api: fragments are never sent");
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (capability) h["X-Storage-Capability"] = capability;
  let payload = body;
  if (body !== undefined && !raw) { h["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${origin}${path}`, { method, headers: h, body: payload, redirect: "manual" });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) { try { json = JSON.parse(buf.toString("utf8")); } catch { json = null; } }
  return { status: res.status, headers: res.headers, buf, json };
}
// portal = "platform" (the disposable platform owner) or "customer" (tenant users) — fixed per caller.
async function login(email, password, portal) {
  const origin = portal === "platform" ? PLATFORM : portal === "customer" ? CUSTOMER : null;
  if (!origin) throw new Error("login: portal must be platform or customer");
  const r = await api("POST", "/api/auth/login", { body: { email, password }, origin });
  must(`login ${email.replace(/@.*/, "@…")} on the ${portal} portal`, r.status === 200 && r.json && r.json.token, errDetail(r));
  return r.json.token;
}
const loginOwner = () => login(PO_EMAIL, PO_PASSWORD, "platform");
const loginTenant = (email, password) => login(email, password, "customer");
// Platform administration with the owner token (companies, users, metrics) — always the platform portal.
const platform = (method, path, opts = {}) => api(method, path, { ...opts, origin: PLATFORM });
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
// Minimal valid 64x64 RGBA PNG (CRC + zlib from node); 32 px per side is the API minimum.
function png64() {
  const W = 64, H = 64;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; for (let x = 0; x < W; x++) { const o = y * (W * 4 + 1) + 1 + x * 4; raw[o] = x * 4; raw[o + 1] = y * 4; raw[o + 2] = 128; raw[o + 3] = 255; } }
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// A first-party URL: relative, or absolute on exactly the CUSTOMER origin (default ports normalized); fixed path shape; no query, no hash.
function firstParty(url, pathRe) {
  try { const u = new URL(String(url), CUSTOMER); return u.origin === new URL(CUSTOMER).origin && pathRe.test(u.pathname) && u.search === "" && u.hash === "" && !u.username && !u.password; } catch { return false; }
}
// Only the PATH of a response URL is reused, and only against the fixed CUSTOMER origin.
const toPath = (url) => new URL(String(url), CUSTOMER).pathname;
const state = () => { try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return { tag: TAG, companies: [], users: [], leakDetector: "" }; } };
// Token-specific leak detector: the capability's signature component (base64url HMAC-SHA256, 43 chars,
// unique per capability). Any occurrence of the complete capability contains it; capabilities of other
// runs (and the shared payload prefix) never do. Returns "" when the token is not <body>.<signature>.
function leakDetectorOf(capability) {
  const m = /^[A-Za-z0-9_-]{20,}\.([A-Za-z0-9_-]{43})$/.exec(String(capability));
  return m ? m[1] : "";
}
const save = (s) => writeFileSync(OUT, JSON.stringify(s), { mode: 0o600 });

// ── CORRECTION 2 (run 38922592504): served-logo rules, pure functions over sanitized response facts ──────────
// Content-Length is NOT mandatory proof of completeness through the public edge (run 38922592504 served the
// 181-byte stored PNG with status 200 and image/png while the client gate on Content-Length failed; the header
// value itself was not recorded). Rule: a PRESENT Content-Length must be ONE canonical non-negative decimal
// integer (no sign, no leading zero, no list) equal to the received body length; an ABSENT Content-Length is
// acceptable by itself because a completed body read is the integrity fact; present-but-malformed or
// present-but-mismatched FAILS. Returns sanitized facts only (never a header dump).
function contentLengthRule(headers, bodyLength) {
  const raw = headers && typeof headers.get === "function" ? headers.get("content-length") : null;
  if (raw === null || raw === undefined) return { ok: true, present: false, value: null, exact: null, reason: "content-length absent (body read completed)" };
  if (!/^(0|[1-9][0-9]*)$/.test(String(raw))) return { ok: false, present: true, value: null, exact: false, reason: "content-length present but malformed" };
  const value = Number(raw);
  if (value !== bodyLength) return { ok: false, present: true, value, exact: false, reason: `content-length ${value} differs from the received body length ${bodyLength}` };
  return { ok: true, present: true, value, exact: true, reason: `content-length ${value} equals the body length` };
}
// The AUTHENTICATED tenant route (GET /api/organization/branding/logo, the tenant's own logo bytes) is the
// authoritative observation of the STORED, NORMALIZED logo: logoSha / logoSize are derived from ITS body only
// (never from the uploaded fixture, never from a database row, never from the public route's metadata). The
// PUBLIC randomized route must then serve exactly the same bytes (sha256, length and Buffer.equals), under the
// same conditional Content-Length rule. Inputs are {status, contentType, buf, headers}; output is a verdict with
// sanitized facts (status, content type, body length, content-length presence / value / exactness).
function servedLogoRule(auth, pub) {
  const facts = (r, cl) => ({ status: r.status, contentType: String(r.contentType || "").split(";")[0], length: r.buf ? r.buf.length : -1, contentLengthPresent: cl.present, contentLengthValue: cl.value, contentLengthExact: cl.exact });
  const image = (r) => r && r.status === 200 && String(r.contentType || "").startsWith("image/") && Buffer.isBuffer(r.buf) && r.buf.length > 0;
  const aCl = contentLengthRule(auth && auth.headers, auth && auth.buf ? auth.buf.length : -1);
  const out = { ok: false, reason: "", authenticated: facts(auth || {}, aCl), public: null, logoSha: null, logoSize: 0 };
  if (!image(auth)) { out.reason = "authenticated logo GET did not serve an image (200 + image/* + non-empty body required)"; return out; }
  if (!aCl.ok) { out.reason = `authenticated ${aCl.reason}`; return out; }
  out.logoSha = sha256(auth.buf); out.logoSize = auth.buf.length;   // the ONLY source of the stored-logo expectation
  const pCl = contentLengthRule(pub && pub.headers, pub && pub.buf ? pub.buf.length : -1);
  out.public = facts(pub || {}, pCl);
  if (!image(pub)) { out.reason = "public logo GET did not serve an image (200 + image/* + non-empty body required)"; return out; }
  if (!pCl.ok) { out.reason = `public ${pCl.reason}`; return out; }
  if (pub.buf.length !== auth.buf.length) { out.reason = `public body length ${pub.buf.length} differs from the authenticated body length ${auth.buf.length}`; return out; }
  if (sha256(pub.buf) !== out.logoSha || !pub.buf.equals(auth.buf)) { out.reason = "public body bytes differ from the authenticated body (same length, different content)"; return out; }
  out.ok = true; out.reason = "public route served exactly the authenticated stored bytes";
  return out;
}
const asServed = (r) => ({ status: r.status, contentType: r.headers.get("content-type") || "", buf: r.buf, headers: r.headers });

const METRIC_KEYS = ["retainedLegacyObjects", "publicationUncertain", "ownershipUnproven", "pendingDeletes", "pendingUploads", "unreconciledTombstones", "driver", "legacyFallback", "mirror", "legacyReads"];
async function storageMetrics(po) {
  const m = await platform("GET", "/api/metrics", { token: po });
  must("metrics readable (platform owner)", m.status === 200 && m.json && m.json.storage, errDetail(m));
  const out = {}; for (const k of METRIC_KEYS) out[k] = m.json.storage[k] ?? null; return out;
}

async function run() {
  const s = { tag: TAG, stage: STAGE, companies: [], users: [], leakDetector: "", documentId: null, fileUrl: null, fileSha: null, fileSize: 0, fixtureMarker: "", logoSha: null, logoSize: 0, metricsBaseline: null };
  const po = await loginOwner();
  s.metricsBaseline = await storageMetrics(po); save(s);
  console.log(`metrics baseline: ${JSON.stringify(s.metricsBaseline)}`);
  // 1. disposable tenants A and B
  const mk = async (suffix) => {
    const r = await platform("POST", "/api/companies", { token: po, body: { name: `B25 SMOKE ${TAG} ${suffix}`, plan: "professional", primaryContactName: "disposable", primaryContactEmail: `b25-smoke-${TAG}-${suffix}@b25smoke.invalid` } });
    must(`create tenant ${suffix}`, r.status === 201 && r.json && Number.isInteger(r.json.id), errDetail(r));
    s.companies.push(r.json.id); save(s);
    return r.json.id;
  };
  const A = await mk("a"); const B = await mk("b");
  const mkUser = async (cid, suffix, role, permissions) => {
    const email = `b25-smoke-${TAG}-${suffix}@b25smoke.invalid`;
    const password = `S1-${randomBytes(18).toString("base64url")}`;
    const r = await platform("POST", "/api/users", { token: po, body: { email, name: `B25 smoke ${suffix} (disposable)`, role, companyId: cid, password, permissions, contactVisibility: "all", companyVisibility: "own" } });
    must(`create user ${suffix} (${role})`, r.status === 201 && r.json && Number.isInteger(r.json.id), errDetail(r));
    s.users.push(r.json.id); save(s);
    return { email, password };
  };
  const adminA = await mkUser(A, "admin-a", "primary_admin", {});
  s.adminA = adminA; save(s);
  const empA = await mkUser(A, "emp-a", "employee", {});
  const adminB = await mkUser(B, "admin-b", "primary_admin", {});
  const tA = await loginTenant(adminA.email, adminA.password);
  const tE = await loginTenant(empA.email, empA.password);
  const tB = await loginTenant(adminB.email, adminB.password);

  // 2. upload intent
  // documents accept a fixed allow-list of types (application/pdf is one); the payload is a PDF-prefixed random blob
  const MIME = "application/pdf";
  // Stage 2A: deterministic bytes (a function of the tag only) carrying a plaintext marker repeated
  // through the body; the VPS-side verification proves the stored (encrypted) file holds neither the
  // marker nor the PDF header, while the first-party download returns exactly these bytes.
  const marker = STAGE2A ? `B25-STAGE2A-PLAINTEXT-MARKER-${TAG}` : "";
  const bytes = STAGE2A
    ? Buffer.concat([Buffer.from(`%PDF-1.4\n% B25 stage2a smoke ${TAG}\n`), Buffer.from(`${marker}\n`.repeat(512))])
    : Buffer.concat([Buffer.from(`%PDF-1.4\n% B25 smoke ${TAG} ${randomUUID()}\n`), randomBytes(48 * 1024)]);
  s.fileSha = sha256(bytes); s.fileSize = bytes.length; s.fixtureMarker = marker;
  const intent = await api("POST", "/api/documents/upload-url", { token: tA, body: { fileName: `b25-smoke-${TAG}.pdf`, contentType: MIME, size: bytes.length } });
  must("upload intent (tenant admin)", intent.status === 200 && intent.json && intent.json.uploadURL && intent.json.objectPath && intent.json.uploadToken, errDetail(intent));
  const { uploadURL, objectPath, uploadToken } = intent.json;
  s.leakDetector = leakDetectorOf(uploadToken); save(s);
  must("capability has the <payload>.<signature> shape (token-specific detector recorded, never printed)", s.leakDetector.length === 43);
  check("uploadURL is a first-party /api/files/uploads/<uuid> URL on the configured origin, no query", firstParty(uploadURL, /^\/api\/files\/uploads\/[0-9a-f-]{36}$/), "shape");
  check("objectPath is a native handle /objects/<uuid>", /^\/objects\/[0-9a-f-]{36}$/.test(objectPath));
  const putPath = toPath(uploadURL);
  const deniedIntent = await api("POST", "/api/documents/upload-url", { token: tE, body: { fileName: "x.pdf", contentType: MIME, size: 10 } });
  check("employee without documents permission: upload intent denied (403)", deniedIntent.status === 403, `status ${deniedIntent.status}`);
  // Deliberate: the owner token (obtained on the platform portal) is presented to a TENANT module on the
  // customer portal; the product's role firewall (requireTenantUser) must refuse it — not a login failure.
  const poIntent = await api("POST", "/api/documents/upload-url", { token: po, body: { fileName: "x.pdf", contentType: MIME, size: 10 } });
  check("platform owner denied on the tenant documents module (403, customer portal, authenticated owner token)", poIntent.status === 403, errDetail(poIntent));

  // 3. capability rules on the first-party PUT
  const noCap = await api("PUT", putPath, { token: tA, body: bytes, raw: true, headers: { "Content-Type": MIME } });
  check("PUT without capability refused", noCap.status === 403 || noCap.status === 401, `status ${noCap.status} code ${noCap.json && noCap.json.code}`);
  const wrongCap = await api("PUT", putPath, { token: tA, body: bytes, raw: true, headers: { "Content-Type": MIME }, capability: `${uploadToken.slice(0, -4)}xxxx` });
  check("PUT with a tampered capability refused", wrongCap.status === 403 || wrongCap.status === 401, `status ${wrongCap.status}`);
  const noAuth = await api("PUT", putPath, { body: bytes, raw: true, headers: { "Content-Type": MIME }, capability: uploadToken });
  check("PUT without a session refused (401)", noAuth.status === 401, `status ${noAuth.status}`);
  // Query-string credential rejection — the genuine capability is NEVER placed in a URL. Both probes carry
  // the synthetic value only; the product must answer 403 STORAGE_QUERY_CREDENTIAL_REJECTED before any
  // authentication, capability or state evaluation (the second probe presents the genuine capability in
  // the approved header only and must be refused on the query key alone).
  const queryRejected = (r) => r.status === 403 && !!r.json && r.json.code === "STORAGE_QUERY_CREDENTIAL_REJECTED";
  const queryProbePath = `${putPath}?t=${encodeURIComponent(SYNTHETIC_QUERY_CREDENTIAL)}`;
  const queryNoHeader = await api("PUT", queryProbePath, { token: tA, body: bytes, raw: true, headers: { "Content-Type": MIME } });
  check("PUT with a synthetic query credential and no capability header → 403 STORAGE_QUERY_CREDENTIAL_REJECTED", queryRejected(queryNoHeader), errDetail(queryNoHeader));
  const queryWithHeader = await api("PUT", queryProbePath, { token: tA, body: bytes, raw: true, headers: { "Content-Type": MIME }, capability: uploadToken });
  check("PUT with a synthetic query credential and the genuine capability only in X-Storage-Capability → 403 STORAGE_QUERY_CREDENTIAL_REJECTED", queryRejected(queryWithHeader), errDetail(queryWithHeader));
  // The rejected probes neither consumed nor published the intent: the object is not readable before the
  // legitimate upload (404), the legitimate credential-free-URL upload then succeeds exactly once, and a
  // second use is refused as already completed.
  const objectId = objectPath.slice("/objects/".length);
  const beforeUpload = await api("GET", `/api/files/${objectId}`, { token: tA });
  check("intent not published by the rejected probes (GET of the reserved object → 404 before the upload)", beforeUpload.status === 404, `status ${beforeUpload.status}`);
  const put = await api("PUT", putPath, { token: tA, body: bytes, raw: true, headers: { "Content-Type": MIME }, capability: uploadToken });
  must("first-party PUT with bearer + capability on the credential-free URL (intent not consumed by the rejected probes)", put.status === 200 && put.json, errDetail(put));
  check("receipt sizeBytes matches", put.json.sizeBytes === bytes.length, `${put.json.sizeBytes}`);
  check("receipt sha256 matches", put.json.sha256 === s.fileSha);
  const reuse = await api("PUT", putPath, { token: tA, body: bytes, raw: true, headers: { "Content-Type": MIME }, capability: uploadToken });
  check("reused capability after completion refused (409 STORAGE_CONFLICT) — consumed exactly once, by the legitimate upload", reuse.status === 409 && reuse.json && reuse.json.code === "STORAGE_CONFLICT", `status ${reuse.status} code ${reuse.json && reuse.json.code}`);
  // Token-specific comparison (complete capability and its signature component) — never a shared prefix.
  for (const r of [noCap, wrongCap, noAuth, queryNoHeader, queryWithHeader, beforeUpload, reuse, put]) {
    const b = Buffer.from(JSON.stringify(r.json || {}));
    check("no capability echoed in an API body (complete token / signature component)", !b.includes(uploadToken) && !b.includes(s.leakDetector));
  }

  // 4. live association + authenticated GET / HEAD
  // category catalog is keyed by entity type ({ company: [...], contact: [...], ... }); the first company category is used
  const cats = await api("GET", "/api/documents/categories", { token: tA });
  const category = cats.json && cats.json.company && cats.json.company[0] ? String(cats.json.company[0]) : "general";
  const doc = await api("POST", "/api/documents", { token: tA, body: { entityType: "company", entityId: A, category, objectPath, fileName: `b25-smoke-${TAG}.pdf`, fileSize: bytes.length, mimeType: MIME } });
  must("create document (live association)", doc.status === 201 && doc.json && Number.isInteger(doc.json.id), errDetail(doc));
  s.documentId = doc.json.id; save(s);
  const dl = await api("GET", `/api/documents/${s.documentId}/download`, { token: tA });
  must("download descriptor", dl.status === 200 && dl.json && dl.json.url, errDetail(dl));
  check("download url is a credential-free first-party /api/files/<uuid> URL on the configured origin", firstParty(dl.json.url, /^\/api\/files\/[0-9a-f-]{36}$/));
  const getPath = toPath(dl.json.url);
  s.fileUrl = getPath; save(s);
  const get = await api("GET", getPath, { token: tA });
  must("authenticated first-party GET", get.status === 200, errDetail(get));
  check("GET bytes identical (sha256)", sha256(get.buf) === s.fileSha);
  check("GET Content-Length exact", Number(get.headers.get("content-length")) === bytes.length, get.headers.get("content-length"));
  check("GET Content-Type exact", (get.headers.get("content-type") || "").startsWith(MIME), get.headers.get("content-type"));
  check("GET Referrer-Policy no-referrer", get.headers.get("referrer-policy") === "no-referrer");
  check("GET Cache-Control private/no-store", /no-store/.test(get.headers.get("cache-control") || ""));
  const head = await api("HEAD", getPath, { token: tA });
  check("HEAD supported (200, Content-Length, empty body)", head.status === 200 && Number(head.headers.get("content-length")) === bytes.length && head.buf.length === 0, `status ${head.status}`);
  const range = await api("GET", getPath, { token: tA, headers: { Range: "bytes=0-9" } });
  check("Range request handled (recorded, not required)", range.status === 206 || range.status === 200, `status ${range.status}`);
  const cross = await api("GET", getPath, { token: tB });
  check("cross-tenant GET → 404 (no disclosure)", cross.status === 404, `status ${cross.status}`);
  const poGet = await api("GET", getPath, { token: po }); // deliberate: owner token on a tenant file route (customer portal)
  check("platform owner GET → 403 (tenant firewall, authenticated owner token)", poGet.status === 403, errDetail(poGet));
  const anon = await api("GET", getPath);
  check("anonymous GET → 401", anon.status === 401, `status ${anon.status}`);
  const empGet = await api("GET", getPath, { token: tE });
  check("employee of the same tenant GET (documents are tenant-scoped open reads by the accepted design)", empGet.status === 200 || empGet.status === 403, `status ${empGet.status}`);
  const bodies = [dl, cross, poGet, anon, deniedIntent, poIntent].map((r) => JSON.stringify(r.json || {})).join("\n");
  check("no bucket / key / path / signature text in API bodies", !/gs:\/\/|storage\.googleapis\.com|\/data\/objects|\/var\/lib\/docker|X-Goog-Signature|tenants\/[0-9]+\//.test(bodies));

  // 5. branding logo upload / read / replace / remove through the B25 service
  const logo = png64();
  const up1 = await api("POST", "/api/organization/branding/logo", { token: tA, body: logo, raw: true, headers: { "Content-Type": "image/png" } });
  must("logo upload", up1.status === 200 && up1.json && up1.json.logoUrl, errDetail(up1));
  check("logoUrl is the first-party randomized route on the configured origin", firstParty(up1.json.logoUrl, /^\/api\/branding\/logos\/[0-9]+\/[0-9a-f-]+$/), "shape");
  const logoPath = toPath(up1.json.logoUrl);
  if (STAGE2A) {
    // CORRECTION 1 (run 38847884691): the product NORMALIZES every uploaded logo before storing it
    // (artifacts/api-server/src/lib/branding/logo.ts validateLogoUpload — sharp decode, rotate(), resize
    // within 1024, metadata-stripped PNG / JPEG re-encode), so the STORED bytes are never the uploaded bytes.
    // CORRECTION 2 (run 38922592504): the AUTHENTICATED tenant route is the authoritative observation of the
    // stored bytes (both routes serve the same stored buffer through the same sendLogo helper); the public
    // randomized route is fetched AFTERWARDS and must serve exactly the same bytes; Content-Length is checked
    // only when present (see contentLengthRule / servedLogoRule). The uploaded buffer is never a stored fact.
    const au = await api("GET", "/api/organization/branding/logo", { token: tA });
    const auCl = contentLengthRule(au.headers, au.buf.length);
    must("stage 2a: authenticated tenant logo GET served the stored image (200, image/*, non-empty body)", au.status === 200 && (au.headers.get("content-type") || "").startsWith("image/") && au.buf.length > 0, `status ${au.status} type ${(au.headers.get("content-type") || "").split(";")[0]} length ${au.buf.length}`);
    must("stage 2a: authenticated Content-Length — absent, or one canonical integer equal to the body", auCl.ok, auCl.reason);
    const rd = await api("GET", logoPath);   // the public randomized route, fetched after the authenticated observation
    check("logo readable (public randomized route, image/png)", rd.status === 200 && (rd.headers.get("content-type") || "").startsWith("image/"), `status ${rd.status}`);
    const verdict = servedLogoRule(asServed(au), asServed(rd));
    s.logoSha = verdict.logoSha; s.logoSize = verdict.logoSize; s.logoAuthenticated = verdict.authenticated; s.logoPublic = verdict.public; save(s);
    must("stage 2a: stored-logo facts derived from the authenticated served bytes only (never the upload, never a row)", typeof s.logoSha === "string" && /^[0-9a-f]{64}$/.test(s.logoSha) && s.logoSize === au.buf.length && s.logoSize > 0 && s.logoSha === sha256(au.buf), `authenticated ${au.buf.length} bytes (uploaded fixture ${logo.length} bytes)`);
    must("stage 2a: public randomized route serves exactly the authenticated stored bytes (200, image/*, same length, same sha256, Buffer.equals; Content-Length absent or exact)", verdict.ok, `${verdict.reason}; public status ${verdict.public ? verdict.public.status : "?"} type ${verdict.public ? verdict.public.contentType : "?"} length ${verdict.public ? verdict.public.length : "?"} content-length present=${verdict.public ? verdict.public.contentLengthPresent : "?"} value=${verdict.public ? verdict.public.contentLengthValue : "?"} exact=${verdict.public ? verdict.public.contentLengthExact : "?"}`);
    // the logo stays with the tenant: the company purge must remove its encrypted file AND its mirror
    check("stage 2a: logo kept for the tenant purge (no replace / remove)", true);
  } else {
  const rd = await api("GET", logoPath);
  check("logo readable (public randomized route, image/png)", rd.status === 200 && (rd.headers.get("content-type") || "").startsWith("image/"), `status ${rd.status}`);
  const up2 = await api("POST", "/api/organization/branding/logo", { token: tA, body: logo, raw: true, headers: { "Content-Type": "image/png" } });
  check("logo replace", up2.status === 200 && up2.json && up2.json.logoUrl && up2.json.logoUrl !== up1.json.logoUrl, `status ${up2.status}`);
  const oldRd = await api("GET", logoPath);
  check("replaced logo route no longer serves (404)", oldRd.status === 404, `status ${oldRd.status}`);
  const rm = await api("DELETE", "/api/organization/branding/logo", { token: tA });
  check("logo remove", rm.status === 200, `status ${rm.status}`);
  const ownerLogo = await api("GET", "/api/organization/branding", { token: tA });
  check("branding reports no managed logo after removal", ownerLogo.status === 200 && ownerLogo.json && ownerLogo.json.logoUrl === null, `status ${ownerLogo.status}`);
  }

  // 6. metrics (platform owner): driver stays gcs, fallback / mirror off, legacyReads primary
  const m = await platform("GET", "/api/metrics", { token: po });
  const st = m.json && m.json.storage;
  check("metrics storage block present", m.status === 200 && !!st, `status ${m.status}`);
  if (LOCAL) check("metrics storage driver (local dry run: recorded only)", !!st, st ? `${st.driver}/${st.legacyFallback}/${st.mirror}/${st.legacyReads}` : "");
  else if (STAGE2A) check("metrics storage block: driver=fs legacyFallback=true mirror=true legacyReads=fallback (Stage 2A)", !!st && st.driver === "fs" && st.legacyFallback === true && st.mirror === true && st.legacyReads === "fallback", st ? `${st.driver}/${st.legacyFallback}/${st.mirror}/${st.legacyReads}` : "");
  else check("metrics storage block: driver=gcs legacyFallback=false mirror=false legacyReads=primary", !!st && st.driver === "gcs" && st.legacyFallback === false && st.mirror === false && st.legacyReads === "primary", st ? `${st.driver}/${st.legacyFallback}/${st.mirror}/${st.legacyReads}` : "");
  if (STAGE2A) check("metrics (Stage 2A): mirrorFailures=0 integrityFailures=0 primaryFailures=0 publicationUncertain=0 ownershipUnproven=0", !!st && st.mirrorFailures === 0 && st.integrityFailures === 0 && st.primaryFailures === 0 && st.publicationUncertain === 0 && st.ownershipUnproven === 0, st ? `${st.mirrorFailures}/${st.integrityFailures}/${st.primaryFailures}/${st.publicationUncertain}/${st.ownershipUnproven}` : "");
  check("metrics carry no bucket / path", !/gs:\/\/|\/data\/objects|storage\.googleapis/.test(JSON.stringify(m.json || {})));
  save(s);
}

async function recheck() {
  const s = state();
  // the tenant admin's server-side session survives the container recreation; a fresh login is also fine
  if (s.fileUrl && s.adminA) {
    const tA = await loginTenant(s.adminA.email, s.adminA.password);
    const get = await api("GET", s.fileUrl, { token: tA });
    check("smoke document readable after api recreation", get.status === 200 && sha256(get.buf) === s.fileSha && Number(get.headers.get("content-length")) === s.fileSize, `status ${get.status}`);
  } else {
    check("smoke document readable after api recreation", false, "no smoke document recorded");
  }
  // delete the disposable tenants through the product API: tombstones in the same transaction, purge job enqueued
  const po = await loginOwner();
  for (const cid of s.companies) {
    const d = await platform("DELETE", `/api/companies/${cid}`, { token: po });
    check(`delete disposable tenant ${cid} through the API`, d.status === 200, `status ${d.status}`);
    // Correction 8: a successful deletion is recorded in the run's own state so the always-cleanup never has to
    // probe the id again (a GET on a deleted company answers 404, which the product logs at error level)
    if (d.status === 200) { s.deleted = Array.from(new Set([...(s.deleted || []), cid])); save(s); }
  }
}

// after smoke-settle: every storage counter must be back at the pre-smoke baseline
async function postcheck() {
  const s = state();
  const po = await loginOwner();
  const now = await storageMetrics(po);
  console.log(`metrics after settle: ${JSON.stringify(now)}`);
  must("metrics baseline recorded by STEP=run", !!s.metricsBaseline);
  for (const k of METRIC_KEYS) check(`metrics.storage.${k} back to baseline`, JSON.stringify(now[k]) === JSON.stringify(s.metricsBaseline[k]), `${JSON.stringify(now[k])} vs ${JSON.stringify(s.metricsBaseline[k])}`);
}

async function teardown() {
  const s = state();
  let po = null;
  try { po = await loginOwner(); } catch { console.log("teardown: owner login unavailable (already removed?)"); return; }
  const deleted = Array.isArray(s.deleted) ? s.deleted : [];
  for (const cid of s.companies) {
    // Correction 8: the recorded DELETE 200 of THIS run (exact disposable id) is the existence evidence — no GET probe,
    // so a clean run leaves no 404 error record; the VPS-side cleanup phase still proves the company's absence in the
    // database and the tenant / protected post gates still run. Tenants not recorded as deleted keep the API path.
    if (deleted.includes(cid)) { console.log(`tenant ${cid}: deleted earlier in this run (recorded DELETE 200); not probed again`); continue; }
    const g = await platform("GET", `/api/companies/${cid}`, { token: po });
    if (g.status === 404) { console.log(`tenant ${cid}: already absent`); continue; }
    const d = await platform("DELETE", `/api/companies/${cid}`, { token: po });
    console.log(`tenant ${cid}: delete status ${d.status}`);
  }
}

const main = { run, recheck, postcheck, teardown }[STEP];
if (!main) throw new Error(`unknown STEP ${STEP}`);
main().then(() => {
  console.log(`\n${STEP}: ${results.length - failures} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}).catch((e) => { console.log(`\n${STEP} aborted: ${e.message}`); process.exit(1); });
