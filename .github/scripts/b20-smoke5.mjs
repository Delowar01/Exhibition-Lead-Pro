// =============================================================================
// TEMPORARY — Batch 22 production & provider verification hosted smoke (GitHub
// runner, API-level, no browser). Public hosts only: PLATFORM_HOST (elite) and
// TENANT_HOST (admin). Disposable fixtures only: tenants "B20 SMOKE <tag> B22-A /
// B22-B" (the "B20 SMOKE" prefix is the cleanup marker), their administrators, one
// employee, ONE disposable platform owner inserted by `smoke-setup`.
//   runtime  readiness / liveness through the public gateway, metrics gate, TLS,
//            direct-port exposure probe (only 443 may answer), http→https note
//   gcs      the application's REAL document path (presigned PUT → object storage →
//            create → signed GET → bytes verified → unsigned / tampered access
//            refused → cross-tenant 404 → RBAC 403 → platform-owner 403 → soft
//            delete) and the managed-logo path (raw upload → public read → own read →
//            app-side delete). Object names go to STATE_FILE for the ops phases.
//   gemini   configuration + routing through the Enterprise AI Layer with NO
//            billable call: settings / health / stub refused in production / one
//            scan attempt that the layer records as an error with zero usage.
//   smtp     invitation e-mail queued → durable worker → skipped (provider not
//            configured); no e-mail is ever sent.
// Every created id goes to STATE_FILE immediately so the always-run cleanup
// phases remove exactly those rows and objects. The existing customer
// (company EXISTING_COMPANY_ID) is only READ. Never prints passwords, tokens,
// hashes, signed URLs, bucket names or host IPs.
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import dns from "node:dns/promises";
import zlib from "node:zlib";
import crypto from "node:crypto";

const env = (k, d) => { const v = process.env[k]; if (v == null || v === "") { if (d !== undefined) return d; throw new Error(`missing env ${k}`); } return v; };
const PLATFORM = env("PLATFORM_HOST", "https://elite.kaptnow.com");
const TENANT = env("TENANT_HOST", "https://admin.kaptnow.com");
const OWNER_EMAIL = env("OWNER_EMAIL"), OWNER_PASSWORD = env("OWNER_PASSWORD"), OWNER_USER_ID = Number(env("OWNER_USER_ID"));
const PW = { aAdmin: env("A_ADMIN_PASSWORD"), bAdmin: env("B_ADMIN_PASSWORD"), emp: env("A_EMPLOYEE_PASSWORD") };
const TAG = env("TAG"), DOMAIN = env("SMOKE_DOMAIN", "b20smoke.invalid");
const OUT_DIR = env("OUT_DIR"), STATE_FILE = env("STATE_FILE");
const EXISTING = Number(env("EXISTING_COMPANY_ID", "1"));
const WAIT_MS = Number(env("WAIT_MS", "45000"));
const FIXTURE_IMAGE = env("FIXTURE_IMAGE", "artifacts/api-server/scripts/ocr-fixtures/english-clean.jpg");
fs.mkdirSync(OUT_DIR, { recursive: true });

const state = { tag: TAG, startMs: Date.now(), companyIds: [], userIds: [OWNER_USER_ID], roleIds: [], objects: [], documentIds: [], scanIds: [], invitationIds: [], expectedEmailJobs: 0 };
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));
saveState();

let S = "init";
const results = [];
let failures = 0, findings = 0;
const trunc = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 900 ? s.slice(0, 900) + "…" : s; };
function check(name, ok, detail) { results.push({ section: S, name, ok: !!ok, detail: detail ?? null }); if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"} [${S}] ${name}${detail != null ? ` — ${trunc(detail)}` : ""}`); }
function note(name, detail) { results.push({ section: S, name, ok: null, detail: detail ?? null }); console.log(`NOTE [${S}] ${name} — ${trunc(detail ?? "")}`); }
function finding(name, ok, detail) { if (ok) { check(name, true, detail); return; } results.push({ section: S, name, ok: false, kind: "finding", detail: detail ?? null }); findings += 1; console.log(`FINDING [${S}] ${name} — ${trunc(detail ?? "")}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 20000, every = 1000) { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(every); } return last; }

async function api(host, method, p, body, token) {
  const res = await fetch(`${host}/api${p}`, { method, headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text: json ? null : text.slice(0, 160), headers: res.headers };
}
// Raw request (binary body / binary response) — returns the bytes, never logs them.
async function raw(host, method, p, body, token, contentType) {
  const res = await fetch(`${host}/api${p}`, { method, headers: { ...(contentType ? { "content-type": contentType } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body, redirect: "manual" });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes: buf, contentType: res.headers.get("content-type"), etag: res.headers.get("etag"), headers: res.headers };
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));
const subView = (s) => pick(s ?? {}, ["companyId", "plan", "status", "billingSource", "accessMode", "reasonCode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "limitOverrides", "statusChangedAt"]);
const listOf = (j) => Array.isArray(j) ? j : (j && typeof j === "object" ? (Object.values(j).find((v) => Array.isArray(v)) ?? []) : []);
const O = { t: null };
const own = (m, p, b) => api(PLATFORM, m, p, b, O.t);
const platformSub = (cid) => own("GET", `/platform/subscriptions/${cid}`);
const act = (cid, verb, body) => own("POST", `/platform/subscriptions/${cid}/${verb}`, body ?? {});
const tenantLogin = (email, password) => api(TENANT, "POST", "/auth/login", { email, password });
const ten = (tok) => ({ get: (p) => api(TENANT, "GET", p, undefined, tok), post: (p, b) => api(TENANT, "POST", p, b ?? {}, tok), patch: (p, b) => api(TENANT, "PATCH", p, b ?? {}, tok), del: (p) => api(TENANT, "DELETE", p, undefined, tok) });
const authView = (r) => ({ status: r.status, userId: r.json?.user?.id ?? null, role: r.json?.user?.role ?? null, companyId: r.json?.user?.companyId ?? null, hasToken: typeof r.json?.token === "string", error: r.json?.error ?? null, code: r.json?.code ?? null });
const errView = (r) => ({ status: r.status, code: r.json?.code ?? null, error: r.json?.error ?? null });

// ── tiny valid PNG (RGBA, solid color) for the managed-logo path ─────────────
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function makePng(w, h, rgba) { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; const rows = []; for (let y = 0; y < h; y++) { const row = Buffer.alloc(1 + w * 4); row[0] = 0; for (let x = 0; x < w; x++) row.set(rgba, 1 + x * 4); rows.push(row); } const idat = zlib.deflateSync(Buffer.concat(rows)); return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]); }

// ── network probes (never print addresses) ──────────────────────────────────
function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r) => { try { s.destroy(); } catch {} resolve(r); };
    s.setTimeout(timeoutMs, () => done("timeout"));
    s.once("connect", () => done("open"));
    s.once("error", (e) => done(e?.code === "ECONNREFUSED" ? "refused" : `error:${e?.code ?? "unknown"}`));
  });
}
const signedUrlView = (u) => { try { const x = new URL(u); return { hostOk: x.hostname === "storage.googleapis.com", https: x.protocol === "https:", algorithm: x.searchParams.get("X-Goog-Algorithm"), expiresSec: Number(x.searchParams.get("X-Goog-Expires")), signed: (x.searchParams.get("X-Goog-Signature") ?? "").length > 0, credentialScoped: (x.searchParams.get("X-Goog-Credential") ?? "").includes("goog4_request"), tail: x.pathname.split("/").pop() }; } catch { return { invalid: true }; } };

const fx = { A: {}, B: {} };
let TA = null, TB = null, TE = null;
async function section(name, fn) {
  S = name;
  try { await fn(); } catch (e) {
    results.push({ section: name, name: `section "${name}" aborted by an unexpected error`, ok: false, detail: String(e?.message ?? e).slice(0, 300) });
    failures += 1; console.log(`FAIL [${name}] section aborted — ${String(e?.message ?? e).slice(0, 300)}`);
  }
}
const nameOf = (k) => `B20 SMOKE ${TAG} B22-${k}`;

async function main() {
  const t0 = Date.now();
  // ── fixtures ────────────────────────────────────────────────────────────────
  S = "fixtures";
  const ol = await api(PLATFORM, "POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  check("disposable platform owner logs in on elite (no MFA)", ol.status === 200 && ol.json?.token && !ol.json?.mfaRequired && ol.json?.user?.id === OWNER_USER_ID && ol.json?.user?.role === "platform_owner", authView(ol));
  if (!ol.json?.token) throw new Error("owner login failed; nothing created");
  O.t = ol.json.token;
  const billing = await own("GET", "/platform/billing/status");
  check("billing provider unavailable, checkout disabled (Stripe stays disabled)", billing.json?.available === false && (billing.json?.selfServiceCheckoutEnabled ?? false) === false, pick(billing.json ?? {}, ["provider", "available", "unavailableReason", "selfServiceCheckoutEnabled"]));
  const ex0 = await platformSub(EXISTING);
  check("existing customer baseline active / free / manual / full (never mutated below)", ex0.status === 200 && ex0.json?.status === "active" && ex0.json?.plan === "free" && ex0.json?.billingSource === "manual" && ex0.json?.accessMode === "full", subView(ex0.json));

  async function mkTenant(key, pw) {
    const c = await own("POST", "/companies", { name: nameOf(key), plan: "free", industry: "smoke-test", country: "ZZ" });
    const cid = c.json?.id; if (Number.isInteger(cid)) { state.companyIds.push(cid); saveState(); }
    check(`tenant ${key} created via API (company + canonical trial)`, c.status === 201 && Number.isInteger(cid) && c.json?.subscription?.status === "trialing", { status: c.status, companyId: cid, subscription: subView(c.json?.subscription) });
    if (!Number.isInteger(cid)) throw new Error(`tenant ${key} creation failed`);
    const adminEmail = `b20-smoke-${TAG}-${key.toLowerCase()}-admin@${DOMAIN}`;
    const a = await own("POST", "/users", { email: adminEmail, name: `B20 SMOKE B22-${key} admin (disposable)`, role: "primary_admin", companyId: cid, password: pw });
    const aid = a.json?.id; if (Number.isInteger(aid)) { state.userIds.push(aid); saveState(); }
    check(`tenant ${key} primary admin created via API`, a.status === 201 && Number.isInteger(aid), { status: a.status, userId: aid });
    if (!Number.isInteger(aid)) throw new Error(`tenant ${key} admin creation failed`);
    const actd = await act(cid, "activate");
    check(`tenant ${key} manually activated (active / full baseline)`, actd.status === 200 && actd.json?.status === "active" && actd.json?.accessMode === "full", subView(actd.json));
    fx[key] = { cid, adminId: aid, adminEmail };
  }
  await mkTenant("A", PW.aAdmin);
  await mkTenant("B", PW.bAdmin);
  const la = await tenantLogin(fx.A.adminEmail, PW.aAdmin), lb = await tenantLogin(fx.B.adminEmail, PW.bAdmin);
  check("tenant admins A and B log in on the tenant host", la.status === 200 && lb.status === 200 && la.json?.user?.companyId === fx.A.cid && lb.json?.user?.companyId === fx.B.cid, { a: authView(la), b: authView(lb) });
  TA = la.json?.token; TB = lb.json?.token;
  if (!TA || !TB) throw new Error("tenant admin logins failed");
  const A = ten(TA), B = ten(TB);
  const empEmail = `b20-smoke-${TAG}-a-employee@${DOMAIN}`;
  const emp = await A.post("/users", { email: empEmail, name: "B20 SMOKE B22-A employee (disposable)", role: "employee", companyId: fx.A.cid, password: PW.emp });
  fx.A.empId = emp.json?.id; if (Number.isInteger(fx.A.empId)) { state.userIds.push(fx.A.empId); saveState(); }
  check("tenant A employee (deny-by-default permissions) created by its own admin", emp.status === 201 && Number.isInteger(fx.A.empId), { status: emp.status, userId: fx.A.empId });
  const le = await tenantLogin(empEmail, PW.emp);
  TE = le.json?.token;
  check("tenant A employee logs in on the tenant host", le.status === 200 && !!TE && le.json?.user?.companyId === fx.A.cid, authView(le));
  if (!TE) throw new Error("employee login failed");
  const E = ten(TE);

  // ── runtime / infrastructure (public gateway) ───────────────────────────────
  await section("runtime", async () => {
    for (const [label, host] of [["platform", PLATFORM], ["tenant", TENANT]]) {
      const rz = await api(host, "GET", "/readyz");
      check(`${label} host: /api/readyz ok with database ok and storage ok through the public gateway`, rz.status === 200 && rz.json?.status === "ok" && rz.json?.checks?.database === "ok" && rz.json?.checks?.storage === "ok", { status: rz.status, body: rz.json });
      const hz = await api(host, "GET", "/healthz");
      check(`${label} host: /api/healthz ok`, hz.status === 200 && hz.json?.status === "ok", { status: hz.status, body: hz.json });
      const wz = await fetch(`${host}/healthz`, { redirect: "manual" }); const wt = (await wz.text()).trim();
      check(`${label} host: web gateway /healthz answers ok`, wz.status === 200 && wt === "ok", { status: wz.status, body: wt.slice(0, 40) });
    }
    const mAnon = await api(PLATFORM, "GET", "/metrics");
    const mOwn = await own("GET", "/metrics");
    check("/api/metrics is gated (401 anonymous) and readable by the platform owner", mAnon.status === 401 && mOwn.status === 200 && typeof mOwn.json?.uptimeSeconds === "number", { anonymous: mAnon.status, owner: mOwn.status, uptimeSeconds: mOwn.json?.uptimeSeconds, requestsTotal: mOwn.json?.requests?.total, jobs: mOwn.json?.jobs ?? null });
    const hostName = new URL(PLATFORM).hostname;
    let httpRedirect = null;
    try { const r = await fetch(`http://${hostName}/api/healthz`, { redirect: "manual" }); httpRedirect = { status: r.status, locationHttps: (r.headers.get("location") ?? "").startsWith("https://") }; } catch (e) { httpRedirect = { error: e?.code ?? e?.cause?.code ?? String(e?.message ?? e).slice(0, 60) }; }
    note("plain http on the public host (edge proxy behaviour, not the stack)", httpRedirect);
    let ip = null; try { ip = (await dns.lookup(hostName)).address; } catch {}
    if (!ip) { note("direct-port exposure probe skipped (DNS lookup failed)", {}); }
    else {
      const probes = {}; for (const port of [443, 18080, 8080, 5000, 5432]) probes[port] = await tcpProbe(ip, port);
      check("direct-port exposure: 443 answers; 18080 / 8080 / 5000 / 5432 are not reachable from the internet", probes[443] === "open" && ["18080", "8080", "5000", "5432"].every((p) => probes[p] !== "open"), probes);
    }
    const noAuth = await api(TENANT, "GET", "/contacts");
    check("tenant API refuses anonymous access (401)", noAuth.status === 401, errView(noAuth));
  });

  // ── GCS — the application's real storage paths ──────────────────────────────
  await section("gcs", async () => {
    const cat = await A.get("/documents/categories");
    check("document category catalog served (company categories include 'Other Attachments')", cat.status === 200 && Array.isArray(cat.json?.company) && cat.json.company.includes("Other Attachments"), { status: cat.status, company: cat.json?.company?.length });
    const content = Buffer.from(`B20 SMOKE ${TAG} B22 document ${crypto.randomBytes(16).toString("hex")}\n`.repeat(64), "utf8");
    const fileName = `b20-smoke-${TAG}-b22.txt`, mimeType = "text/plain", fileSize = content.byteLength;
    const up = await A.post("/documents/upload-url", { fileName, contentType: mimeType, size: fileSize });
    const upv = signedUrlView(up.json?.uploadURL ?? "");
    const objectPath = up.json?.objectPath ?? "";
    const uuid = (objectPath.match(/^\/objects\/uploads\/([0-9a-f-]{36})$/) ?? [])[1] ?? null;
    if (uuid) { state.objects.push(`doc:${uuid}`); saveState(); }
    check("upload-url: V4-signed PUT URL for the private bucket (https, storage.googleapis.com, GOOG4-RSA-SHA256, bounded expiry) and a normalized /objects/uploads/<uuid> path", up.status === 200 && upv.hostOk && upv.https && upv.algorithm === "GOOG4-RSA-SHA256" && upv.signed && upv.credentialScoped && upv.expiresSec > 0 && upv.expiresSec <= 900 && !!uuid, { status: up.status, ...upv, objectTail: uuid });
    if (!uuid) throw new Error("upload-url failed");
    const put = await fetch(up.json.uploadURL, { method: "PUT", body: content });
    check("PUT of the disposable bytes directly to object storage succeeds", put.ok, { status: put.status });
    const created = await A.post("/documents", { entityType: "company", entityId: fx.A.cid, category: "Other Attachments", name: `B20 SMOKE ${TAG} B22 document`, objectPath, fileName, fileSize, mimeType });
    const docId = created.json?.id; if (Number.isInteger(docId)) { state.documentIds.push(docId); saveState(); }
    check("document created against the stored object (company attachment, first version)", created.status === 201 && Number.isInteger(docId) && created.json?.currentVersion?.fileSize === fileSize, { status: created.status, id: docId, fileSize: created.json?.currentVersion?.fileSize, mimeType: created.json?.currentVersion?.mimeType });
    if (!Number.isInteger(docId)) throw new Error("document creation failed");
    const dl = await A.get(`/documents/${docId}/download`);
    const dlv = signedUrlView(dl.json?.url ?? "");
    check("download: short-lived V4-signed GET URL minted after the tenant / permission checks", dl.status === 200 && dlv.hostOk && dlv.https && dlv.signed && dlv.expiresSec > 0 && dlv.expiresSec <= 300 && dl.json?.fileName === fileName, { status: dl.status, ...dlv });
    const got = await fetch(dl.json.url);
    const gotBytes = Buffer.from(await got.arrayBuffer());
    check("signed GET returns exactly the uploaded bytes (read verified)", got.ok && gotBytes.equals(content), { status: got.status, bytes: gotBytes.length, expected: fileSize, equal: gotBytes.equals(content) });
    const u = new URL(dl.json.url);
    const unsigned = await fetch(`${u.origin}${u.pathname}`);
    check("unsigned GET of the same object is refused by the bucket (private objects)", unsigned.status === 401 || unsigned.status === 403, { status: unsigned.status });
    const tampered = new URL(dl.json.url); const sig = tampered.searchParams.get("X-Goog-Signature") ?? ""; tampered.searchParams.set("X-Goog-Signature", sig.slice(0, -6) + (sig.endsWith("000000") ? "111111" : "000000"));
    const tam = await fetch(tampered.toString());
    check("tampered signature is refused by the bucket", tam.status === 400 || tam.status === 403, { status: tam.status });
    const bGet = await B.get(`/documents/${docId}`), bDl = await B.get(`/documents/${docId}/download`), bList = await B.get(`/documents?entityType=company&entityId=${fx.A.cid}`);
    check("tenant B cannot see, download or list tenant A's document (404 / 404 / empty)", bGet.status === 404 && bDl.status === 404 && bList.status === 200 && !listOf(bList.json).some((d) => d.id === docId), { get: bGet.status, download: bDl.status, listStatus: bList.status, listHits: listOf(bList.json).filter((d) => d.id === docId).length });
    const eUp = await E.post("/documents/upload-url", { fileName, contentType: mimeType, size: fileSize });
    const eCreate = await E.post("/documents", { entityType: "company", entityId: fx.A.cid, category: "Other Attachments", objectPath, fileName, fileSize, mimeType });
    check("employee without the documents permission is refused on upload-url and create (403)", eUp.status === 403 && eCreate.status === 403, { uploadUrl: errView(eUp), create: errView(eCreate) });
    const oList = await own("GET", "/documents"), oUp = await own("POST", "/documents/upload-url", { fileName, contentType: mimeType, size: fileSize });
    check("platform owner is fenced from customer documents (403)", oList.status === 403 && oUp.status === 403, { list: oList.status, uploadUrl: oUp.status });
    const del = await A.del(`/documents/${docId}`);
    const afterGet = await A.get(`/documents/${docId}`), afterDl = await A.get(`/documents/${docId}/download`);
    check("soft delete through the app hides the document and its download (404); the object is removed by the ops cleanup", del.status === 200 && afterGet.status === 404 && afterDl.status === 404, { del: del.status, get: afterGet.status, download: afterDl.status });

    // managed logo path (app-side write / read / delete on the bucket)
    const png = makePng(64, 64, [0x1e, 0x88, 0xe5, 0xff]);
    const lg = await raw(TENANT, "POST", "/organization/branding/logo", png, TA, "image/png");
    const lgj = (() => { try { return JSON.parse(lg.bytes.toString("utf8")); } catch { return null; } })();
    const own_ = await raw(TENANT, "GET", "/organization/branding/logo", undefined, TA);
    // The edge proxy may re-emit the ETag as a weak validator (W/"…"); the object id is the quoted value either way.
    const etagFile = (own_.etag ?? "").replace(/^W\//, "").replace(/"/g, "");
    const m = etagFile.match(/^([0-9a-f]{32})\.(png|jpg)$/);
    if (m) { state.objects.push(`logo:${fx.A.cid}:${etagFile}`); saveState(); }
    check("managed logo uploaded through the app and stored in the bucket (own-logo read returns the normalized image; ETag = object id)", lg.status === 200 && own_.status === 200 && (own_.contentType ?? "").startsWith("image/") && own_.bytes.length > 0 && !!m, { upload: lg.status, uploadLogoFlag: lgj?.logo ?? lgj?.hasLogo ?? null, read: own_.status, contentType: own_.contentType, bytes: own_.bytes.length, objectTail: etagFile || null });
    if (m) {
      const pub = await raw(PLATFORM, "GET", `/branding/logos/${fx.A.cid}/${m[1]}`);
      const pubWrong = await raw(PLATFORM, "GET", `/branding/logos/${fx.A.cid}/${"0".repeat(32)}`);
      const pubOther = await raw(PLATFORM, "GET", `/branding/logos/${fx.B.cid}/${m[1]}`);
      check("public logo route serves the bytes by unguessable id; a wrong id or another tenant's id answers 404", pub.status === 200 && pub.bytes.equals(own_.bytes) && pubWrong.status === 404 && pubOther.status === 404, { public: pub.status, bytesEqual: pub.bytes.equals(own_.bytes), wrongId: pubWrong.status, otherTenant: pubOther.status });
      const bOwn = await raw(TENANT, "GET", "/organization/branding/logo", undefined, TB);
      check("tenant B's own-logo route never resolves tenant A's logo (404, no logo of its own)", bOwn.status === 404, { status: bOwn.status });
      const rm = await A.del("/organization/branding/logo");
      const pubAfter = await raw(PLATFORM, "GET", `/branding/logos/${fx.A.cid}/${m[1]}`);
      const ownAfter = await raw(TENANT, "GET", "/organization/branding/logo", undefined, TA);
      check("logo removed through the app: public and own routes answer 404 (the object is deleted by the app itself — verified by the ops object check)", rm.status === 200 && pubAfter.status === 404 && ownAfter.status === 404, { remove: rm.status, publicAfter: pubAfter.status, ownAfter: ownAfter.status });
    }
  });

  // ── Gemini — configuration + routing through the Enterprise AI Layer ───────
  await section("gemini", async () => {
    const st = await A.get("/ai/settings");
    check("tenant AI settings resolve to provider gemini / model gemini-2.5-flash, enabled, with gemini as the ONLY available provider (no stub in production)", st.status === 200 && st.json?.provider === "gemini" && st.json?.model === "gemini-2.5-flash" && st.json?.enabled === true && JSON.stringify(st.json?.availableProviders) === JSON.stringify(["gemini"]), pick(st.json ?? {}, ["provider", "model", "enabled", "availableProviders", "hasCustomSettings"]));
    const hl = await A.get("/ai/health");
    check("AI health reports gemini / gemini-2.5-flash NOT configured (status unconfigured) — no credential on the hosted stack", hl.status === 200 && hl.json?.provider === "gemini" && hl.json?.model === "gemini-2.5-flash" && hl.json?.configured === false && hl.json?.status === "unconfigured", pick(hl.json ?? {}, ["provider", "model", "configured", "status", "pricingAvailable", "last24h"]));
    const stub = await A.patch("/ai/settings", { provider: "stub" });
    check("the deterministic stub provider is refused in production (400)", stub.status === 400 && /gemini/.test(stub.json?.error ?? ""), errView(stub));
    const oSt = await own("GET", "/ai/settings"), oPu = await own("GET", "/ai/platform/usage");
    check("platform owner is fenced from tenant AI settings (403) and uses the platform usage view (200)", oSt.status === 403 && oPu.status === 200, { settings: oSt.status, platformUsage: oPu.status });
    const img = fs.readFileSync(FIXTURE_IMAGE);
    const dataUrl = `data:image/jpeg;base64,${img.toString("base64")}`;
    const scan = await A.post("/scans", { imageData: dataUrl, appLanguage: "en", captureSource: "camera" });
    const scanId = scan.json?.id; if (Number.isInteger(scanId)) { state.scanIds.push(scanId); state.objects.push(`scan:${fx.A.cid}:${scanId}`); saveState(); }
    check("scan attempt with a fixture card is refused without a provider credential: controlled error, scan row marked failed, no extracted data, no billable call", (scan.status === 502 || scan.status === 503) && Number.isInteger(scanId) && scan.json?.status === "failed" && (scan.json?.extractedData ?? null) === null, { status: scan.status, code: scan.json?.code ?? null, error: scan.json?.error ?? null, scanId, scanStatus: scan.json?.status ?? null, fixtureBytes: img.length });
    finding("unconfigured Gemini surfaces to the client as a generic card-read failure rather than a configuration error (observation, not a defect fix)", !(scan.status === 502 && /retake the photo/i.test(scan.json?.error ?? "")), { status: scan.status, error: scan.json?.error ?? null });
    if (Number.isInteger(scanId)) {
      const imgRead = await waitFor(async () => { const r = await raw(TENANT, "GET", `/scans/${scanId}/image`, undefined, TA); return r.status === 200 ? r : null; }, 25000, 1500);
      check("scan image stored in the bucket by the app (fire-and-forget) and streamed back through the API (JPEG)", !!imgRead && (imgRead.contentType ?? "").startsWith("image/jpeg") && imgRead.bytes.length > 100 && imgRead.bytes[0] === 0xff && imgRead.bytes[1] === 0xd8, { status: imgRead?.status ?? null, contentType: imgRead?.contentType ?? null, bytes: imgRead?.bytes?.length ?? 0 });
      const bScan = await B.get(`/scans/${scanId}`), bImg = await raw(TENANT, "GET", `/scans/${scanId}/image`, undefined, TB);
      check("tenant B cannot read tenant A's scan or its image (404 / 404)", bScan.status === 404 && bImg.status === 404, { scan: bScan.status, image: bImg.status });
      const sc = await A.get(`/scans/${scanId}`);
      check("the failed scan is persisted honestly (status failed, no extracted data)", sc.status === 200 && sc.json?.status === "failed" && (sc.json?.extractedData ?? null) === null, pick(sc.json ?? {}, ["id", "status", "confidence"]));
    }
    const usage = await waitFor(async () => { const r = await A.get("/ai/usage"); return r.status === 200 && (r.json?.totals?.requests ?? 0) >= 1 ? r : null; }, 15000, 1000);
    const tot = usage?.json?.totals ?? {}; const recent = usage?.json?.recent ?? []; const last = recent[0] ?? null;
    const tokenKeys = Object.keys(tot).filter((k) => /token/i.test(k)); const costKeys = Object.keys(tot).filter((k) => /cost/i.test(k));
    check("Enterprise AI Layer ledger recorded exactly one card_extraction attempt as an error with zero tokens and zero cost (gemini / gemini-2.5-flash)", !!usage && tot.requests === 1 && tot.errors === 1 && tokenKeys.every((k) => Number(tot[k]) === 0) && costKeys.every((k) => Number(tot[k]) === 0) && last?.feature === "card_extraction" && last?.status === "error" && last?.model === "gemini-2.5-flash" && Number(last?.totalTokens ?? 0) === 0 && Number(last?.costUsd ?? 0) === 0, { totals: tot, recent: last ? pick(last, ["feature", "status", "model", "totalTokens", "costUsd", "latencyMs"]) : null });
  });

  // ── SMTP — configuration + durable queue behaviour ─────────────────────────
  await section("smtp", async () => {
    const inviteeEmail = `b20-smoke-${TAG}-invitee@${DOMAIN}`;
    const inv = await A.post("/invitations", { email: inviteeEmail, name: "B20 SMOKE B22 invitee (disposable)", role: "employee" });
    const invRow = inv.json?.invitation ?? inv.json ?? {};
    const invId = invRow?.id; if (Number.isInteger(invId)) { state.invitationIds.push(invId); state.expectedEmailJobs += 1; saveState(); }
    // The create response reflects the optimistic "queued" state (async delivery); the worker may already have settled it.
    check("invitation created; its e-mail is QUEUED on the durable queue (never reported as sent)", inv.status === 201 && Number.isInteger(invId) && (invRow?.emailStatus === "queued" || invRow?.emailStatus === "skipped"), { status: inv.status, id: invId, emailStatus: invRow?.emailStatus ?? null, emailError: invRow?.emailError ?? null });
    if (!Number.isInteger(invId)) throw new Error("invitation creation failed");
    const settled = await waitFor(async () => { const r = await A.get("/invitations"); const row = listOf(r.json).find((i) => i.id === invId); return row && row.emailStatus !== "queued" ? row : null; }, WAIT_MS, 1500);
    check("durable worker processed the job and recorded SKIPPED with 'provider is not configured' (no send, no retry storm)", !!settled && settled.emailStatus === "skipped" && /not configured/i.test(settled.emailError ?? "") && !!settled.emailUpdatedAt, settled ? pick(settled, ["id", "status", "emailStatus", "emailError", "emailUpdatedAt"]) : { settled: null });
    check("the e-mail was never reported as sent", !settled || settled.emailStatus !== "sent", { emailStatus: settled?.emailStatus ?? null });
    const bInv = await B.get("/invitations");
    check("tenant B's invitation list never shows tenant A's invitation", bInv.status === 200 && !listOf(bInv.json).some((i) => i.id === invId), { status: bInv.status, hits: listOf(bInv.json).filter((i) => i.id === invId).length });
  });

  // ── preservation ────────────────────────────────────────────────────────────
  S = "preservation";
  const ex1 = await platformSub(EXISTING);
  check("existing customer unchanged after the smoke (active / free / manual / full, same timestamps)", ex1.status === 200 && ["plan", "status", "billingSource", "accessMode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "statusChangedAt"].every((k) => ex1.json?.[k] === ex0.json?.[k]) && JSON.stringify(ex1.json?.limitOverrides ?? {}) === "{}", { before: subView(ex0.json), after: subView(ex1.json) });
  const fa = await platformSub(fx.A.cid), fb = await platformSub(fx.B.cid);
  check("both disposable tenants end active / full", fa.json?.status === "active" && fa.json?.accessMode === "full" && fb.json?.status === "active" && fb.json?.accessMode === "full", { a: subView(fa.json), b: subView(fb.json) });
  note("elapsed", { ms: Date.now() - t0 });
}

async function finish(exitCode) {
  saveState();
  const sections = {};
  for (const r of results) { const s = (sections[r.section] ??= { passed: 0, failed: 0, findings: 0, notes: 0 }); if (r.ok === true) s.passed++; else if (r.ok === false && r.kind === "finding") s.findings++; else if (r.ok === false) s.failed++; else s.notes++; }
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify({ tag: TAG, fixtures: fx, state, failures, findings, sections, results }, null, 2));
  console.log(`\nB22 SUMMARY: ${results.filter((r) => r.ok === true).length} passed, ${failures} failed, ${findings} findings, ${results.filter((r) => r.ok === null).length} notes; sections=${JSON.stringify(sections)}; state=${JSON.stringify(state)}`);
  process.exit(exitCode);
}

main()
  .then(async () => { await finish(failures > 0 ? 1 : 0); })
  .catch(async (e) => {
    console.error(`SMOKE ERROR [${S}]: ${e?.message ?? e}`);
    results.push({ section: S, name: "unexpected error", ok: false, detail: String(e?.message ?? e).slice(0, 300) }); failures += 1;
    await finish(1);
  });
