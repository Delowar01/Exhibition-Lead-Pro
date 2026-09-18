// =============================================================================
// TEMPORARY — Batch 23 G-3 hosted protected-export verification (GitHub runner,
// API-level, no browser). Public hosts only: PLATFORM_HOST (elite) and
// TENANT_HOST (admin). Disposable fixtures only: tenants "B20 SMOKE <tag> G3-A"
// and "B20 SMOKE <tag> G3-B" (the "B20 SMOKE" prefix is the cleanup marker),
// their administrators, ONE disposable platform owner inserted by `smoke-setup`,
// a small uniquely stamped set of synthetic contacts, and exactly TWO on-demand
// password-protected contact CSV exports (aes256, zip20) produced by the REAL
// API against the REAL object storage.
//
// Proves, per export: 201 completed run with the expected row count / nonzero
// size / .zip name / passwordProtected=true; the run in GET /exports/runs; a
// short-lived V4-signed download URL for that exact run; the downloaded bytes
// match the run's size (sha256 + md5 recorded for the ops-side object check);
// the archive identifies the requested method; the wrong password cannot
// extract the CSV and the right one can; the CSV rows equal the fixture and
// contain nothing from another tenant; unauthenticated / cross-tenant /
// platform-owner access to the download endpoint is refused; no public
// export-run deletion route exists; the signed URL stops working after expiry.
//
// The export passwords are generated inside this process, never printed, never
// placed on a command line for the API, and only handed to the local archive
// tools as an argument (execFile, no shell). Every API response is scanned for
// them. Signed URLs, object keys, tokens, hashes and bucket names are never
// written to the console or the evidence files. Object labels (exp:<uuid>) go
// to STATE_FILE so the ops phases can check, md5-verify and delete exactly the
// two objects this smoke created. No Stripe, e-mail, Gemini, APK or schema work.
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const env = (k, d) => { const v = process.env[k]; if (v == null || v === "") { if (d !== undefined) return d; throw new Error(`missing env ${k}`); } return v; };
const PLATFORM = env("PLATFORM_HOST", "https://elite.kaptnow.com");
const TENANT = env("TENANT_HOST", "https://admin.kaptnow.com");
const OWNER_EMAIL = env("OWNER_EMAIL"), OWNER_PASSWORD = env("OWNER_PASSWORD"), OWNER_USER_ID = Number(env("OWNER_USER_ID"));
const A_ADMIN_PASSWORD = env("A_ADMIN_PASSWORD"), B_ADMIN_PASSWORD = env("B_ADMIN_PASSWORD");
const TAG = env("TAG"), DOMAIN = env("SMOKE_DOMAIN", "b20smoke.invalid");
const OUT_DIR = env("OUT_DIR"), STATE_FILE = env("STATE_FILE"), WORK_DIR = env("WORK_DIR");
const EXISTING = Number(env("EXISTING_COMPANY_ID", "1"));
const ROWS = Number(env("G3_ROWS", "5"));
const WAIT_EXPIRY = env("G3_WAIT_EXPIRY", "1") === "1";
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

// ── secrets that must never leave this process ───────────────────────────────
const genPassword = () => `Xp0rt!${crypto.randomBytes(24).toString("base64url").replace(/[-_]/g, "z").slice(0, 26)}`;
const PW = { aes256: genPassword(), zip20: genPassword() };
if (PW.aes256 === PW.zip20) throw new Error("password generation failure");
const SECRETS = [PW.aes256, PW.zip20, OWNER_PASSWORD, A_ADMIN_PASSWORD, B_ADMIN_PASSWORD];
const containsSecret = (s) => SECRETS.some((p) => s.includes(p));
const captured = []; // every API response body (string) for the non-exposure scan

const state = { tag: TAG, startMs: Date.now(), companyIds: [], userIds: [OWNER_USER_ID], roleIds: [], objects: [], documentIds: [], scanIds: [], invitationIds: [], exportRunIds: [], contactIds: [], expectedEmailJobs: 0, downloads: {} };
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));
saveState();

let S = "init";
const results = [];
let failures = 0, findings = 0;
const trunc = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 900 ? s.slice(0, 900) + "…" : s; };
function check(name, ok, detail) { results.push({ section: S, name, ok: !!ok, detail: detail ?? null }); if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"} [${S}] ${name}${detail != null ? ` — ${trunc(detail)}` : ""}`); }
function note(name, detail) { results.push({ section: S, name, ok: null, detail: detail ?? null }); console.log(`NOTE [${S}] ${name} — ${trunc(detail ?? "")}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(host, method, p, body, token) {
  const res = await fetch(`${host}/api${p}`, { method, headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text(); captured.push(text);
  let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text: json ? null : text.slice(0, 160), headers: res.headers };
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));
const subView = (s) => pick(s ?? {}, ["companyId", "plan", "status", "billingSource", "accessMode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "limitOverrides", "statusChangedAt"]);
const listOf = (j) => Array.isArray(j) ? j : (j && typeof j === "object" ? (Object.values(j).find((v) => Array.isArray(v)) ?? []) : []);
const O = { t: null };
const own = (m, p, b) => api(PLATFORM, m, p, b, O.t);
const platformSub = (cid) => own("GET", `/platform/subscriptions/${cid}`);
const act = (cid, verb, body) => own("POST", `/platform/subscriptions/${cid}/${verb}`, body ?? {});
const tenantLogin = (email, password) => api(TENANT, "POST", "/auth/login", { email, password });
const ten = (tok) => ({ get: (p) => api(TENANT, "GET", p, undefined, tok), post: (p, b) => api(TENANT, "POST", p, b ?? {}, tok), del: (p) => api(TENANT, "DELETE", p, undefined, tok) });
const authView = (r) => ({ status: r.status, userId: r.json?.user?.id ?? null, role: r.json?.user?.role ?? null, companyId: r.json?.user?.companyId ?? null, hasToken: typeof r.json?.token === "string", error: r.json?.error ?? null, code: r.json?.code ?? null });
// Signed-URL view: shape only — never the URL, path, query or signature.
const signedUrlView = (u) => { try { const x = new URL(u); return { hostOk: x.hostname === "storage.googleapis.com", https: x.protocol === "https:", algorithm: x.searchParams.get("X-Goog-Algorithm"), expiresSec: Number(x.searchParams.get("X-Goog-Expires")), signed: (x.searchParams.get("X-Goog-Signature") ?? "").length > 0, credentialScoped: (x.searchParams.get("X-Goog-Credential") ?? "").includes("goog4_request"), uuidTail: /^[0-9a-f-]{36}$/.test(x.pathname.split("/").pop() ?? "") }; } catch { return { invalid: true }; } };
const uuidOf = (u) => { try { const t = new URL(u).pathname.split("/").pop() ?? ""; return /^[0-9a-f-]{36}$/.test(t) ? t : null; } catch { return null; } };
const runView = (r) => pick(r ?? {}, ["id", "companyId", "scheduleId", "entityType", "format", "status", "fileName", "fileSize", "rowCount", "passwordProtected", "error"]);

// ── archive tooling (runner-local; no product dependency) ────────────────────
function which(bin) { try { execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: ["ignore", "pipe", "ignore"] }); return true; } catch { return false; } }
const SEVENZ = which("7zz") ? "7zz" : which("7z") ? "7z" : null;
const UNZIP = which("unzip") ? "unzip" : null;
function run(bin, args) { try { const out = execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }); return { code: 0, out: out.toString("utf8"), err: "" }; } catch (e) { return { code: e.status ?? -1, out: e.stdout?.toString("utf8") ?? "", err: e.stderr?.toString("utf8") ?? "" }; } }
// Sanitize tool output before it can reach the log: tool messages never echo the
// password, but the check detail is scrubbed anyway.
const scrub = (s) => { let t = String(s ?? ""); for (const p of SECRETS) t = t.split(p).join("[redacted]"); return t.slice(0, 400); };

// Parse the first ZIP local file header: flags bit 0 (encrypted), compression
// method (99 = WinZip AES), and the AES extra field (0x9901) strength byte.
function zipHeaderInfo(buf) {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) return { valid: false };
  const flags = buf.readUInt16LE(6), method = buf.readUInt16LE(8);
  const nameLen = buf.readUInt16LE(26), extraLen = buf.readUInt16LE(28);
  const name = buf.subarray(30, 30 + nameLen).toString("utf8");
  const extra = buf.subarray(30 + nameLen, 30 + nameLen + extraLen);
  let aes = null, i = 0;
  while (i + 4 <= extra.length) {
    const id = extra.readUInt16LE(i), len = extra.readUInt16LE(i + 2);
    if (id === 0x9901 && len >= 7) aes = { version: extra.readUInt16LE(i + 4), vendor: extra.subarray(i + 6, i + 8).toString("ascii"), strength: extra[i + 8], actualMethod: extra.readUInt16LE(i + 9) };
    i += 4 + len;
  }
  const observed = method === 99 && aes ? `AES-${aes.strength === 3 ? 256 : aes.strength === 2 ? 192 : aes.strength === 1 ? 128 : "?"}` : (flags & 1) ? "ZipCrypto" : "none";
  return { valid: true, encrypted: (flags & 1) === 1, method, aes, observed, entryName: name };
}
// RFC 4180 CSV parser (quotes, doubled quotes, CRLF/LF), BOM tolerant.
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const fx = { A: {}, B: {}, contacts: [], exports: {} };
let TA = null, TB = null;
async function section(name, fn) {
  S = name;
  try { await fn(); } catch (e) {
    results.push({ section: name, name: `section "${name}" aborted by an unexpected error`, ok: false, detail: scrub(String(e?.message ?? e)).slice(0, 300) });
    failures += 1; console.log(`FAIL [${name}] section aborted — ${scrub(String(e?.message ?? e)).slice(0, 300)}`);
  }
}
const nameOf = (k) => `B20 SMOKE ${TAG} G3-${k}`;

async function main() {
  const t0 = Date.now();
  S = "fixtures";
  note("archive tooling on the runner", { sevenZip: SEVENZ, unzip: UNZIP });
  if (!SEVENZ) throw new Error("no 7-Zip binary on the runner (7zz/7z) — AES-256 verification impossible; nothing created");
  const ol = await api(PLATFORM, "POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  check("disposable platform owner logs in on elite (no MFA)", ol.status === 200 && ol.json?.token && !ol.json?.mfaRequired && ol.json?.user?.id === OWNER_USER_ID && ol.json?.user?.role === "platform_owner", authView(ol));
  if (!ol.json?.token) throw new Error("owner login failed; nothing created");
  O.t = ol.json.token;
  const billing = await own("GET", "/platform/billing/status");
  check("billing provider unavailable, checkout disabled (Stripe stays disabled)", billing.json?.available === false && (billing.json?.selfServiceCheckoutEnabled ?? false) === false, pick(billing.json ?? {}, ["provider", "available", "unavailableReason", "selfServiceCheckoutEnabled"]));
  const ex0 = await platformSub(EXISTING);
  check("existing customer baseline active / free / manual / full (never touched below)", ex0.status === 200 && ex0.json?.status === "active" && ex0.json?.plan === "free" && ex0.json?.billingSource === "manual" && ex0.json?.accessMode === "full", subView(ex0.json));
  for (const key of ["A", "B"]) {
    const c = await own("POST", "/companies", { name: nameOf(key), plan: "free", industry: "smoke-test", country: "ZZ" });
    const cid = c.json?.id; if (Number.isInteger(cid)) { state.companyIds.push(cid); saveState(); }
    check(`tenant ${key} created via API (company + canonical trial)`, c.status === 201 && Number.isInteger(cid) && c.json?.subscription?.status === "trialing", { status: c.status, companyId: cid, subscription: subView(c.json?.subscription) });
    if (!Number.isInteger(cid)) throw new Error(`tenant ${key} creation failed`);
    const adminEmail = `b20-smoke-${TAG}-${key.toLowerCase()}-admin@${DOMAIN}`;
    const a = await own("POST", "/users", { email: adminEmail, name: `B20 SMOKE G3-${key} admin (disposable)`, role: "primary_admin", companyId: cid, password: key === "A" ? A_ADMIN_PASSWORD : B_ADMIN_PASSWORD });
    const aid = a.json?.id; if (Number.isInteger(aid)) { state.userIds.push(aid); saveState(); }
    check(`tenant ${key} primary admin created via API`, a.status === 201 && Number.isInteger(aid), { status: a.status, userId: aid });
    if (!Number.isInteger(aid)) throw new Error(`tenant ${key} admin creation failed`);
    const actd = await act(cid, "activate");
    check(`tenant ${key} manually activated (active / full)`, actd.status === 200 && actd.json?.status === "active" && actd.json?.accessMode === "full", subView(actd.json));
    fx[key] = { cid, adminId: aid, adminEmail };
    const la = await tenantLogin(adminEmail, key === "A" ? A_ADMIN_PASSWORD : B_ADMIN_PASSWORD);
    if (key === "A") TA = la.json?.token; else TB = la.json?.token;
    check(`tenant ${key} admin logs in on the tenant host`, la.status === 200 && !!la.json?.token && la.json?.user?.companyId === cid, authView(la));
    if (!la.json?.token) throw new Error(`tenant ${key} admin login failed`);
  }
  const A = ten(TA), B = ten(TB);

  // ── synthetic contacts (expected export values recorded BEFORE any export) ──
  await section("contacts", async () => {
    for (let i = 1; i <= ROWS; i++) {
      const body = { firstName: "G3", lastName: `Row${i} ${TAG}`, jobTitle: `Export Row ${i}`, contactCompany: `B20 SMOKE ${TAG} Org`, email: `g3-${TAG}-${i}@${DOMAIN}`, mobile: `+97150${String(100000 + i).slice(-6)}`, country: "ZZ", dedupeResolution: "create_separate" };
      const r = await A.post("/contacts", body);
      const id = r.json?.id; if (Number.isInteger(id)) { state.contactIds.push(id); saveState(); }
      check(`tenant A synthetic contact ${i} created`, r.status === 201 && Number.isInteger(id) && r.json?.email === body.email, { status: r.status, id });
      fx.contacts.push({ id, expected: { "First Name": body.firstName, "Last Name": body.lastName, "Job Title": body.jobTitle, Company: body.contactCompany, Email: body.email, Mobile: body.mobile, Country: body.country } });
    }
    // One contact in tenant B: its e-mail must NEVER appear in tenant A's exports.
    const rb = await B.post("/contacts", { firstName: "G3", lastName: `OtherTenant ${TAG}`, jobTitle: "Must not leak", contactCompany: `B20 SMOKE ${TAG} Org B`, email: `g3-${TAG}-other-tenant@${DOMAIN}`, mobile: "+971500000999", country: "ZZ", dedupeResolution: "create_separate" });
    if (Number.isInteger(rb.json?.id)) { state.contactIds.push(rb.json.id); saveState(); }
    fx.B.otherEmail = `g3-${TAG}-other-tenant@${DOMAIN}`;
    check("tenant B control contact created (must be absent from tenant A's exports)", rb.status === 201 && Number.isInteger(rb.json?.id), { status: rb.status, id: rb.json?.id });
    const la = await A.get("/contacts?limit=100");
    const listedA = listOf(la.json).map((c) => c.email);
    check(`tenant A lists exactly the ${ROWS} synthetic contacts`, la.status === 200 && listedA.length === ROWS && fx.contacts.every((c) => listedA.includes(c.expected.Email)) && !listedA.includes(fx.B.otherEmail), { status: la.status, listed: listedA.length, expected: ROWS });
    if (fx.contacts.some((c) => !Number.isInteger(c.id))) throw new Error("fixture contacts incomplete — no export is requested");
  });
  if (failures > 0) { note("exports skipped", "fixture failures — no export was requested"); return; }

  // ── the two exports ───────────────────────────────────────────────────────
  const runsBefore = await A.get("/exports/runs");
  check("tenant A starts with an empty export history", runsBefore.status === 200 && (runsBefore.json?.total ?? -1) === 0, pick(runsBefore.json ?? {}, ["total"]));
  for (const method of ["aes256", "zip20"]) {
    await section(`export:${method}`, async () => {
      const t1 = Date.now();
      const created = await A.post("/exports", { entityType: "contact", format: "csv", passwordProtected: true, password: PW[method], encryptionMethod: method });
      const ms = Date.now() - t1;
      const run = created.json ?? {};
      const runId = run.id;
      if (Number.isInteger(runId)) { state.exportRunIds.push(runId); saveState(); }
      const mintedAt = Date.now();
      check(`POST /exports (${method}) → 201 completed run: ${ROWS} rows, nonzero size, .zip name, passwordProtected=true`, created.status === 201 && Number.isInteger(runId) && run.status === "completed" && run.entityType === "contact" && run.format === "csv" && run.rowCount === ROWS && Number.isInteger(run.fileSize) && run.fileSize > 0 && typeof run.fileName === "string" && run.fileName.endsWith(".zip") && run.passwordProtected === true && (run.error ?? null) === null && run.companyId === fx.A.cid && typeof run.downloadUrl === "string", { status: created.status, ...runView(run), hasDownloadUrl: typeof run.downloadUrl === "string", latencyMs: ms });
      check("the creation response never echoes the password and carries no object path", created.text === null && !containsSecret(JSON.stringify(run)) && run.objectPath === undefined && run.password === undefined && run.encryptionMethod === undefined, { keys: Object.keys(run) });
      if (!Number.isInteger(runId) || run.status !== "completed") throw new Error(`export ${method} was not created/completed — the remaining ${method} checks are not attempted`);
      const list = await A.get("/exports/runs");
      const hit = listOf(list.json).find((r) => r.id === runId);
      check("the run appears in GET /exports/runs for tenant A with the same metadata", list.status === 200 && !!hit && hit.status === "completed" && hit.fileName === run.fileName && hit.fileSize === run.fileSize && hit.rowCount === ROWS && hit.passwordProtected === true && hit.downloadUrl === undefined, { total: list.json?.total ?? null, hit: runView(hit) });
      const dl = await A.get(`/exports/runs/${runId}/download`);
      const dlv = signedUrlView(dl.json?.url ?? "");
      check("GET /exports/runs/:id/download → short-lived V4-signed GET URL for that run (https, storage.googleapis.com, GOOG4-RSA-SHA256, 300 s, uuid object)", dl.status === 200 && dl.json?.fileName === run.fileName && dlv.hostOk && dlv.https && dlv.algorithm === "GOOG4-RSA-SHA256" && dlv.signed && dlv.credentialScoped && dlv.expiresSec === 300 && dlv.uuidTail, { status: dl.status, fileNameMatches: dl.json?.fileName === run.fileName, ...dlv });
      const uuid = uuidOf(dl.json?.url ?? "");
      if (uuid) { state.objects.push(`exp:${uuid}`); saveState(); }
      const objUuidMatchesCreate = uuidOf(run.downloadUrl ?? "") === uuid;
      check("the creation response's downloadUrl and the download endpoint point at the same object", !!uuid && objUuidMatchesCreate, { sameObject: objUuidMatchesCreate });
      // Fetch promptly (the URL lives 300 s) and verify the bytes against the run.
      const got = await fetch(dl.json.url);
      const bytes = Buffer.from(await got.arrayBuffer());
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex"), md5 = crypto.createHash("md5").update(bytes).digest("hex");
      state.downloads[`exp:${uuid}`] = { method, runId, bytes: bytes.length, sha256, md5 }; saveState();
      check("signed GET returns exactly fileSize bytes of a ZIP (content-type application/zip; sha256/md5 recorded for the ops-side object comparison)", got.ok && bytes.length === run.fileSize && bytes.readUInt32LE(0) === 0x04034b50 && (got.headers.get("content-type") ?? "").includes("zip"), { status: got.status, bytes: bytes.length, expected: run.fileSize, contentType: got.headers.get("content-type"), sha256: sha256.slice(0, 16) + "…" });
      const u = new URL(dl.json.url);
      const unsigned = await fetch(`${u.origin}${u.pathname}`);
      check("unsigned GET of the same object is refused by the bucket (private object; the signed URL is a short-lived bearer capability, not app-authenticated)", unsigned.status === 401 || unsigned.status === 403, { status: unsigned.status });

      // ── archive verification on the runner ──────────────────────────────────
      const zipPath = path.join(WORK_DIR, `${method}.zip`);
      fs.writeFileSync(zipPath, bytes);
      const hdr = zipHeaderInfo(bytes);
      const listing = run(SEVENZ, ["l", "-slt", zipPath]);
      const methodLine = (listing.out.match(/^Method = .*$/m) ?? [""])[0];
      const expectedHdr = method === "aes256" ? hdr.encrypted && hdr.method === 99 && hdr.aes?.strength === 3 && hdr.observed === "AES-256" : hdr.encrypted && hdr.method !== 99 && hdr.aes === null && hdr.observed === "ZipCrypto";
      const expectedTool = method === "aes256" ? /AES-256/.test(methodLine) : /ZipCrypto/.test(methodLine);
      check(`archive identifies the requested method — ZIP local header + 7-Zip listing agree on ${method === "aes256" ? "AES-256 (WinZip AE, method 99, strength 3)" : "legacy ZipCrypto (flag bit 0, no AES extra field)"}`, hdr.valid && expectedHdr && listing.code === 0 && expectedTool && hdr.entryName.endsWith(".csv"), { header: pick(hdr, ["encrypted", "method", "observed", "entryName"]), aesExtra: hdr.aes, sevenZipMethod: methodLine.replace(/^Method = /, ""), tool: SEVENZ });
      fx.exports[method] = { runId, observedMethod: hdr.observed, sevenZipMethod: methodLine.replace(/^Method = /, ""), fileName: run.fileName, fileSize: run.fileSize, rowCount: run.rowCount, mintedAt };

      const wrongDir = path.join(WORK_DIR, `${method}-wrong`), rightDir = path.join(WORK_DIR, `${method}-right`);
      fs.mkdirSync(wrongDir, { recursive: true }); fs.mkdirSync(rightDir, { recursive: true });
      const wrongPw = `${PW[method]}x`;
      const bad = run(SEVENZ, ["x", `-p${wrongPw}`, "-y", `-o${wrongDir}`, zipPath]);
      const badFiles = fs.readdirSync(wrongDir);
      const badCsvValid = badFiles.some((f) => { try { return parseCsv(fs.readFileSync(path.join(wrongDir, f), "utf8")).some((r) => r.includes(fx.contacts[0].expected.Email)); } catch { return false; } });
      check("the WRONG password cannot extract the CSV (7-Zip fails and no readable fixture data appears)", bad.code !== 0 && !badCsvValid, { exitCode: bad.code, message: scrub((bad.err || bad.out).split("\n").filter((l) => /wrong|password|error|crc|data/i.test(l)).slice(0, 3).join(" | ")), filesLeft: badFiles.length });
      const good = run(SEVENZ, ["x", `-p${PW[method]}`, "-y", `-o${rightDir}`, zipPath]);
      const goodFiles = fs.readdirSync(rightDir).filter((f) => f.endsWith(".csv"));
      let rows = [], header = [], parsed = false;
      if (goodFiles.length === 1) { const text = fs.readFileSync(path.join(rightDir, goodFiles[0]), "utf8"); const all = parseCsv(text); header = all[0] ?? []; rows = all.slice(1); parsed = true; }
      check("the RIGHT password extracts exactly one CSV entry", good.code === 0 && goodFiles.length === 1 && parsed, { exitCode: good.code, entries: goodFiles.length, headerColumns: header.length });
      if (parsed) {
        const col = (name) => header.indexOf(name);
        const need = ["First Name", "Last Name", "Job Title", "Company", "Email", "Mobile", "Country"];
        const missingCols = need.filter((n) => col(n) < 0);
        const byEmail = new Map(rows.map((r) => [r[col("Email")], r]));
        const rowMatches = fx.contacts.map((c) => { const r = byEmail.get(c.expected.Email); if (!r) return { email: c.expected.Email, found: false }; const diffs = need.filter((n) => r[col(n)] !== c.expected[n]); return { found: true, diffs }; });
        const allMatch = rowMatches.every((m) => m.found && m.diffs.length === 0);
        const emails = rows.map((r) => r[col("Email")]);
        const foreign = emails.filter((e) => !fx.contacts.some((c) => c.expected.Email === e));
        check(`CSV rows equal the synthetic fixture: ${ROWS} data rows, every stamped contact exactly once, all compared columns identical`, missingCols.length === 0 && rows.length === ROWS && allMatch && new Set(emails).size === ROWS, { rows: rows.length, expected: ROWS, missingColumns: missingCols, mismatches: rowMatches.filter((m) => !m.found || m.diffs.length).slice(0, 3) });
        check("the CSV contains no other tenant's data (tenant B's control e-mail absent; no foreign rows at all)", foreign.length === 0 && !emails.includes(fx.B.otherEmail) && rows.every((r) => !r.some((cell) => cell.includes(fx.B.otherEmail))), { foreignRows: foreign.length });
      }
      // Legacy-tool compatibility evidence (the reason zip20 exists) — Info-ZIP unzip.
      if (UNZIP) {
        const compatDir = path.join(WORK_DIR, `${method}-unzip`); fs.mkdirSync(compatDir, { recursive: true });
        const uz = run(UNZIP, ["-P", PW[method], "-o", "-d", compatDir, zipPath]);
        const uzWrong = run(UNZIP, ["-P", wrongPw, "-o", "-d", path.join(WORK_DIR, `${method}-unzip-wrong`), zipPath]);
        if (method === "zip20") check("legacy-tool compatibility: Info-ZIP unzip opens the ZipCrypto archive with the password and refuses the wrong one", uz.code === 0 && fs.readdirSync(compatDir).length === 1 && uzWrong.code !== 0, { unzipExit: uz.code, wrongExit: uzWrong.code, message: scrub((uzWrong.err || uzWrong.out).split("\n").filter((l) => /password|incorrect/i.test(l)).slice(0, 1).join("")) });
        else note("AES-256 archive with Info-ZIP unzip (expected: unsupported — an AES-capable tool such as 7-Zip is required)", { unzipExit: uz.code, message: scrub((uz.err || uz.out).split("\n").filter((l) => /unsupported|compression method|need PK|skipping/i.test(l)).slice(0, 1).join("")) });
        fs.rmSync(compatDir, { recursive: true, force: true }); fs.rmSync(path.join(WORK_DIR, `${method}-unzip-wrong`), { recursive: true, force: true });
      }
      // Decrypted content never leaves the runner: remove it now.
      fs.rmSync(wrongDir, { recursive: true, force: true }); fs.rmSync(rightDir, { recursive: true, force: true });
    });
  }

  // ── access control on the application endpoint ───────────────────────────
  await section("access-control", async () => {
    const runA = fx.exports.aes256?.runId ?? fx.exports.zip20?.runId;
    if (!Number.isInteger(runA)) { note("skipped", "no completed run to test against"); return; }
    const noAuth = await api(TENANT, "GET", `/exports/runs/${runA}/download`);
    check("unauthenticated GET /exports/runs/:id/download → 401", noAuth.status === 401, { status: noAuth.status });
    const noAuthList = await api(TENANT, "GET", "/exports/runs");
    check("unauthenticated GET /exports/runs → 401", noAuthList.status === 401, { status: noAuthList.status });
    const bDl = await B.get(`/exports/runs/${runA}/download`);
    const bList = await B.get("/exports/runs");
    check("tenant B's request for tenant A's run is refused without disclosing it (404, not 403) and B's history does not list it", bDl.status === 404 && !JSON.stringify(bDl.json ?? {}).includes("url") && bList.status === 200 && (bList.json?.total ?? -1) === 0 && !listOf(bList.json).some((r) => state.exportRunIds.includes(r.id)), { download: bDl.status, error: bDl.json?.error ?? null, bTotal: bList.json?.total ?? null });
    const poDl = await own("GET", `/exports/runs/${runA}/download`);
    check("the platform owner is fenced off the tenant export module (403)", poDl.status === 403, { status: poDl.status });
    const del = await A.del(`/exports/runs/${runA}`);
    const del2 = await A.del(`/exports/runs/${runA}/download`);
    check("no public export-run deletion route exists (DELETE /exports/runs/:id and …/download → 404/405); the run row stays", [404, 405].includes(del.status) && [404, 405].includes(del2.status) && (await A.get(`/exports/runs/${runA}/download`)).status === 200, { delete: del.status, deleteDownload: del2.status });
  });

  // ── non-exposure ─────────────────────────────────────────────────────────
  await section("non-exposure", async () => {
    const leaked = captured.filter((t) => containsSecret(t)).length;
    check("no API response body captured by this smoke contains either export password (or any fixture password)", leaked === 0, { responsesScanned: captured.length, leaked });
    const list = await A.get("/exports/runs");
    const runs = listOf(list.json).filter((r) => state.exportRunIds.includes(r.id));
    check("the export-run rows expose only metadata (no password, no encryption method, no object path, no URL)", runs.length === 2 && runs.every((r) => ["password", "encryptionMethod", "objectPath", "url", "downloadUrl"].every((k) => !(k in r))), { keys: runs[0] ? Object.keys(runs[0]) : null });
  });

  // ── signed URL expiry (short-lived capability) ───────────────────────────
  await section("expiry", async () => {
    const first = fx.exports.aes256 ?? fx.exports.zip20;
    if (!first) { note("skipped", "no run"); return; }
    if (!WAIT_EXPIRY) { note("skipped by configuration", "G3_WAIT_EXPIRY=0"); return; }
    const dl = await A.get(`/exports/runs/${first.runId}/download`);
    const mintedAt = Date.now();
    const live = await fetch(dl.json.url, { method: "HEAD" });
    check("a freshly minted URL works (HEAD 200)", live.status === 200, { status: live.status });
    const waitMs = 300 * 1000 + 8000 - (Date.now() - mintedAt);
    note("waiting for the 300 s expiry of that URL", { waitSeconds: Math.ceil(waitMs / 1000) });
    await sleep(Math.max(0, waitMs));
    const dead = await fetch(dl.json.url, { method: "HEAD" });
    check("the same URL is refused by the bucket after its 300 s lifetime (expired signature)", dead.status === 400 || dead.status === 403, { status: dead.status, elapsedSeconds: Math.round((Date.now() - mintedAt) / 1000) });
    const again = await A.get(`/exports/runs/${first.runId}/download`);
    check("the application still mints a fresh URL for the run on request (the run itself is unaffected by URL expiry)", again.status === 200 && signedUrlView(again.json?.url ?? "").signed, { status: again.status });
  });

  S = "preservation";
  const ex1 = await platformSub(EXISTING);
  check("existing customer unchanged after the smoke (active / free / manual / full, same timestamps)", ex1.status === 200 && ["plan", "status", "billingSource", "accessMode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "statusChangedAt"].every((k) => ex1.json?.[k] === ex0.json?.[k]) && JSON.stringify(ex1.json?.limitOverrides ?? {}) === "{}", { before: subView(ex0.json), after: subView(ex1.json) });
  for (const key of ["A", "B"]) { const f = await platformSub(fx[key].cid); check(`disposable tenant ${key} ends active / full`, f.json?.status === "active" && f.json?.accessMode === "full", subView(f.json)); }
  note("elapsed", { ms: Date.now() - t0, exports: Object.keys(fx.exports), rows: ROWS });
}

async function finish(exitCode) {
  saveState();
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  const sections = {};
  for (const r of results) { const s = (sections[r.section] ??= { passed: 0, failed: 0, findings: 0, notes: 0 }); if (r.ok === true) s.passed++; else if (r.ok === false && r.kind === "finding") s.findings++; else if (r.ok === false) s.failed++; else s.notes++; }
  const summary = { tag: TAG, fixtures: { A: fx.A, B: pick(fx.B, ["cid", "adminId", "adminEmail"]), rows: ROWS, exports: fx.exports }, state, failures, findings, sections, results };
  // Evidence must never carry a password, a signed URL, a signature, a token or a bucket name.
  const text = JSON.stringify(summary, null, 2);
  const forbidden = containsSecret(text) || /X-Goog-Signature|storage\.googleapis\.com\/|"token"|Bearer /.test(text);
  if (forbidden) { console.log("EVIDENCE SCRUB FAILED — summary.json not written"); fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify({ tag: TAG, error: "scrub failed; evidence withheld", failures: failures + 1 })); exitCode = 1; }
  else fs.writeFileSync(path.join(OUT_DIR, "summary.json"), text);
  const stateText = fs.readFileSync(STATE_FILE, "utf8");
  if (containsSecret(stateText) || /X-Goog|storage\.googleapis/.test(stateText)) { console.log("STATE SCRUB FAILED"); exitCode = 1; }
  console.log(`\nG3 SUMMARY: ${results.filter((r) => r.ok === true).length} passed, ${failures} failed, ${findings} findings, ${results.filter((r) => r.ok === null).length} notes; exports=${JSON.stringify(Object.fromEntries(Object.entries(fx.exports).map(([k, v]) => [k, pick(v, ["runId", "observedMethod", "sevenZipMethod", "fileSize", "rowCount"])])))}; state=${JSON.stringify(pick(state, ["tag", "companyIds", "userIds", "exportRunIds", "contactIds", "objects", "expectedEmailJobs"]))}`);
  process.exit(exitCode);
}

main()
  .then(async () => { await finish(failures > 0 ? 1 : 0); })
  .catch(async (e) => {
    console.error(`SMOKE ERROR [${S}]: ${scrub(String(e?.message ?? e))}`);
    results.push({ section: S, name: "unexpected error", ok: false, detail: scrub(String(e?.message ?? e)).slice(0, 300) }); failures += 1;
    await finish(1);
  });
