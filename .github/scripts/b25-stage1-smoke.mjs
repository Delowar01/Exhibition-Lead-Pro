// TEMPORARY — B25 Stage 1 disposable smoke, run on the GitHub runner against the
// public API origin (ONE-OFF ops script, not application code). No OCR, Gemini,
// SMTP or Stripe is touched. Everything it creates is disposable (tenant names
// "B25 SMOKE <tag>", e-mails under b25smoke.invalid) and is removed by the
// workflow's always-step. Prints ids, status codes and booleans only — never a
// token, capability, password, URL with credentials, bucket name or key.
//
// STEP=run       create 2 disposable tenants (+ admin/employee users), exercise
//                the first-party upload / download contract, branding logo
//                upload / read / replace / remove; write ids to OUT (JSON)
// STEP=recheck   (after the api container was recreated) read the smoke
//                document again, then delete the disposable tenants through
//                the product API (tombstones + purge job)
// STEP=teardown  always-step: delete the disposable tenants if they still exist
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.SMOKE_BASE === "http://localhost:80" ? "http://localhost:80" : "https://admin.kaptnow.com";
const LOCAL = BASE === "http://localhost:80"; // local dry run against the development stack only
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
async function api(method, path, { token, body, headers = {}, raw = false, capability } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (capability) h["X-Storage-Capability"] = capability;
  let payload = body;
  if (body !== undefined && !raw) { h["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: payload, redirect: "manual" });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) { try { json = JSON.parse(buf.toString("utf8")); } catch { json = null; } }
  return { status: res.status, headers: res.headers, buf, json };
}
async function login(email, password) {
  const r = await api("POST", "/api/auth/login", { body: { email, password } });
  must(`login ${email.replace(/@.*/, "@…")}`, r.status === 200 && r.json && r.json.token, `status ${r.status}`);
  return r.json.token;
}
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
// A first-party URL: relative, or absolute on exactly the configured origin (default ports normalized); fixed path shape; no query, no hash.
function firstParty(url, pathRe) {
  try { const u = new URL(String(url), BASE); return u.origin === new URL(BASE).origin && pathRe.test(u.pathname) && u.search === "" && u.hash === "" && !u.username && !u.password; } catch { return false; }
}
const toPath = (url) => new URL(String(url), BASE).pathname;
const state = () => { try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return { tag: TAG, companies: [], users: [], capabilityPrefix: "" }; } };
const save = (s) => writeFileSync(OUT, JSON.stringify(s), { mode: 0o600 });

async function run() {
  const s = { tag: TAG, companies: [], users: [], capabilityPrefix: "", documentId: null, fileUrl: null, fileSha: null, fileSize: 0 };
  const po = await login(PO_EMAIL, PO_PASSWORD);
  // 1. disposable tenants A and B
  const mk = async (suffix) => {
    const r = await api("POST", "/api/companies", { token: po, body: { name: `B25 SMOKE ${TAG} ${suffix}`, plan: "professional", primaryContactName: "disposable", primaryContactEmail: `b25-smoke-${TAG}-${suffix}@b25smoke.invalid` } });
    must(`create tenant ${suffix}`, r.status === 201 && r.json && Number.isInteger(r.json.id), errDetail(r));
    s.companies.push(r.json.id); save(s);
    return r.json.id;
  };
  const A = await mk("a"); const B = await mk("b");
  const mkUser = async (cid, suffix, role, permissions) => {
    const email = `b25-smoke-${TAG}-${suffix}@b25smoke.invalid`;
    const password = `S1-${randomBytes(18).toString("base64url")}`;
    const r = await api("POST", "/api/users", { token: po, body: { email, name: `B25 smoke ${suffix} (disposable)`, role, companyId: cid, password, permissions, contactVisibility: "all", companyVisibility: "own" } });
    must(`create user ${suffix} (${role})`, r.status === 201 && r.json && Number.isInteger(r.json.id), errDetail(r));
    s.users.push(r.json.id); save(s);
    return { email, password };
  };
  const adminA = await mkUser(A, "admin-a", "primary_admin", {});
  s.adminA = adminA; save(s);
  const empA = await mkUser(A, "emp-a", "employee", {});
  const adminB = await mkUser(B, "admin-b", "primary_admin", {});
  const tA = await login(adminA.email, adminA.password);
  const tE = await login(empA.email, empA.password);
  const tB = await login(adminB.email, adminB.password);

  // 2. upload intent
  // documents accept a fixed allow-list of types (application/pdf is one); the payload is a PDF-prefixed random blob
  const MIME = "application/pdf";
  const bytes = Buffer.concat([Buffer.from(`%PDF-1.4\n% B25 smoke ${TAG} ${randomUUID()}\n`), randomBytes(48 * 1024)]);
  s.fileSha = sha256(bytes); s.fileSize = bytes.length;
  const intent = await api("POST", "/api/documents/upload-url", { token: tA, body: { fileName: `b25-smoke-${TAG}.pdf`, contentType: MIME, size: bytes.length } });
  must("upload intent (tenant admin)", intent.status === 200 && intent.json && intent.json.uploadURL && intent.json.objectPath && intent.json.uploadToken, errDetail(intent));
  const { uploadURL, objectPath, uploadToken } = intent.json;
  s.capabilityPrefix = String(uploadToken).slice(0, 16); save(s);
  check("uploadURL is a first-party /api/files/uploads/<uuid> URL on the configured origin, no query", firstParty(uploadURL, /^\/api\/files\/uploads\/[0-9a-f-]{36}$/), "shape");
  check("objectPath is a native handle /objects/<uuid>", /^\/objects\/[0-9a-f-]{36}$/.test(objectPath));
  const putPath = toPath(uploadURL);
  const deniedIntent = await api("POST", "/api/documents/upload-url", { token: tE, body: { fileName: "x.pdf", contentType: MIME, size: 10 } });
  check("employee without documents permission: upload intent denied (403)", deniedIntent.status === 403, `status ${deniedIntent.status}`);
  const poIntent = await api("POST", "/api/documents/upload-url", { token: po, body: { fileName: "x.pdf", contentType: MIME, size: 10 } });
  check("platform owner denied on the tenant documents module (403)", poIntent.status === 403, `status ${poIntent.status}`);

  // 3. capability rules on the first-party PUT
  const noCap = await api("PUT", putPath, { token: tA, body: bytes, raw: true, headers: { "Content-Type": MIME } });
  check("PUT without capability refused", noCap.status === 403 || noCap.status === 401, `status ${noCap.status} code ${noCap.json && noCap.json.code}`);
  const wrongCap = await api("PUT", putPath, { token: tA, body: bytes, raw: true, headers: { "Content-Type": MIME }, capability: `${uploadToken.slice(0, -4)}xxxx` });
  check("PUT with a tampered capability refused", wrongCap.status === 403 || wrongCap.status === 401, `status ${wrongCap.status}`);
  const noAuth = await api("PUT", putPath, { body: bytes, raw: true, headers: { "Content-Type": MIME }, capability: uploadToken });
  check("PUT without a session refused (401)", noAuth.status === 401, `status ${noAuth.status}`);
  const queryCred = await api("PUT", `${putPath}?t=${encodeURIComponent(uploadToken)}`, { token: tA, body: bytes, raw: true, headers: { "Content-Type": MIME } });
  check("PUT with a query-string credential refused", queryCred.status !== 200, `status ${queryCred.status}`);
  const put = await api("PUT", putPath, { token: tA, body: bytes, raw: true, headers: { "Content-Type": MIME }, capability: uploadToken });
  must("first-party PUT with bearer + capability", put.status === 200 && put.json, errDetail(put));
  check("receipt sizeBytes matches", put.json.sizeBytes === bytes.length, `${put.json.sizeBytes}`);
  check("receipt sha256 matches", put.json.sha256 === s.fileSha);
  const reuse = await api("PUT", putPath, { token: tA, body: bytes, raw: true, headers: { "Content-Type": MIME }, capability: uploadToken });
  check("reused capability after completion refused (409 STORAGE_CONFLICT)", reuse.status === 409 && reuse.json && reuse.json.code === "STORAGE_CONFLICT", `status ${reuse.status} code ${reuse.json && reuse.json.code}`);
  for (const r of [noCap, wrongCap, noAuth, queryCred, reuse, put]) {
    check("no capability echoed in an API body", !Buffer.from(JSON.stringify(r.json || {})).includes(uploadToken.slice(0, 16)));
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
  const poGet = await api("GET", getPath, { token: po });
  check("platform owner GET → 403 (tenant firewall)", poGet.status === 403, `status ${poGet.status}`);
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

  // 6. metrics (platform owner): driver stays gcs, fallback / mirror off, legacyReads primary
  const m = await api("GET", "/api/metrics", { token: po });
  const st = m.json && m.json.storage;
  check("metrics storage block present", m.status === 200 && !!st, `status ${m.status}`);
  if (LOCAL) check("metrics storage driver (local dry run: recorded only)", !!st, st ? `${st.driver}/${st.legacyFallback}/${st.mirror}/${st.legacyReads}` : "");
  else check("metrics storage block: driver=gcs legacyFallback=false mirror=false legacyReads=primary", !!st && st.driver === "gcs" && st.legacyFallback === false && st.mirror === false && st.legacyReads === "primary", st ? `${st.driver}/${st.legacyFallback}/${st.mirror}/${st.legacyReads}` : "");
  check("metrics carry no bucket / path", !/gs:\/\/|\/data\/objects|storage\.googleapis/.test(JSON.stringify(m.json || {})));
  save(s);
}

async function recheck() {
  const s = state();
  // the tenant admin's server-side session survives the container recreation; a fresh login is also fine
  if (s.fileUrl && s.adminA) {
    const tA = await login(s.adminA.email, s.adminA.password);
    const get = await api("GET", s.fileUrl, { token: tA });
    check("smoke document readable after api recreation", get.status === 200 && sha256(get.buf) === s.fileSha && Number(get.headers.get("content-length")) === s.fileSize, `status ${get.status}`);
  } else {
    check("smoke document readable after api recreation", false, "no smoke document recorded");
  }
  // delete the disposable tenants through the product API: tombstones in the same transaction, purge job enqueued
  const po = await login(PO_EMAIL, PO_PASSWORD);
  for (const cid of s.companies) {
    const d = await api("DELETE", `/api/companies/${cid}`, { token: po });
    check(`delete disposable tenant ${cid} through the API`, d.status === 200, `status ${d.status}`);
  }
}

async function teardown() {
  const s = state();
  let po = null;
  try { po = await login(PO_EMAIL, PO_PASSWORD); } catch { console.log("teardown: owner login unavailable (already removed?)"); return; }
  for (const cid of s.companies) {
    const g = await api("GET", `/api/companies/${cid}`, { token: po });
    if (g.status === 404) { console.log(`tenant ${cid}: already absent`); continue; }
    const d = await api("DELETE", `/api/companies/${cid}`, { token: po });
    console.log(`tenant ${cid}: delete status ${d.status}`);
  }
}

const main = { run, recheck, teardown }[STEP];
if (!main) throw new Error(`unknown STEP ${STEP}`);
main().then(() => {
  console.log(`\n${STEP}: ${results.length - failures} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}).catch((e) => { console.log(`\n${STEP} aborted: ${e.message}`); process.exit(1); });
