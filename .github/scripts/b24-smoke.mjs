// =============================================================================
// TEMPORARY — Batch 24 hosted activation: focused GET /metrics verification on
// the dev VPS (GitHub runner, API-level, no browser). Public hosts only:
// PLATFORM_HOST (elite) and TENANT_HOST (admin). Disposable fixtures only: ONE
// disposable platform owner inserted by `smoke-setup`, ONE tenant
// "B20 SMOKE <tag> B24-A" (the "B20 SMOKE" prefix is the cleanup marker) with
// ONE primary admin. The platform owner never calls a tenant CRM route.
//
// Proves: GET /metrics is 401 unauthenticated (both hosts), 403 for the tenant
// admin, 200 for the platform owner; the 200 body carries exactly the four
// documented top-level keys and a `jobs` object with exactly the six QueueStats
// counters, every one a non-negative integer (pending is never -1); nothing in
// the body looks like a payload, job name, tenant id, e-mail, SQL, connection
// string or credential; /healthz, /api/healthz and /api/readyz answer as before
// on both hosts; both portals serve their HTML shell. The owner's bearer token
// is written to TOKEN_FILE (mode 0600) for the READ-ONLY `b24-bracket` phase
// and is never printed. No 503 is injected, no queue row is written, no
// schema / env / provider / backup change. Cleanup runs afterwards by ids.
// =============================================================================
import fs from "node:fs";
import path from "node:path";

const env = (k, d) => { const v = process.env[k]; if (v == null || v === "") { if (d !== undefined) return d; throw new Error(`missing env ${k}`); } return v; };
const PLATFORM = env("PLATFORM_HOST", "https://elite.kaptnow.com");
const TENANT = env("TENANT_HOST", "https://admin.kaptnow.com");
const OWNER_EMAIL = env("OWNER_EMAIL"), OWNER_PASSWORD = env("OWNER_PASSWORD"), OWNER_USER_ID = Number(env("OWNER_USER_ID"));
const A_ADMIN_PASSWORD = env("A_ADMIN_PASSWORD");
const TAG = env("TAG"), DOMAIN = env("SMOKE_DOMAIN", "b20smoke.invalid");
const OUT_DIR = env("OUT_DIR"), STATE_FILE = env("STATE_FILE"), TOKEN_FILE = env("TOKEN_FILE");
const EXISTING = Number(env("EXISTING_COMPANY_ID", "1"));
// The owner id drives cleanup; it must be a positive integer before anything is created.
if (!Number.isInteger(OWNER_USER_ID) || OWNER_USER_ID <= 0) throw new Error("OWNER_USER_ID must be a positive integer");
if (!Number.isInteger(EXISTING) || EXISTING <= 0) throw new Error("EXISTING_COMPANY_ID must be a positive integer");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });

// ── secrets that must never reach the log or the evidence files ──────────────
const SECRETS = [OWNER_PASSWORD, A_ADMIN_PASSWORD];
const TOKENS = [];
const scrub = (s) => { let t = String(s ?? ""); for (const p of [...SECRETS, ...TOKENS]) if (p) t = t.split(p).join("[redacted]"); return t; };

const state = { tag: TAG, startMs: Date.now(), companyIds: [], userIds: [OWNER_USER_ID], metricsCalls: 0 };
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));
saveState();

let S = "init";
const results = [];
let failures = 0;
const trunc = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 900 ? s.slice(0, 900) + "…" : s; };
function check(name, ok, detail) { const d = detail == null ? null : scrub(trunc(detail)); results.push({ section: S, name, ok: !!ok, detail: d }); if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"} [${S}] ${name}${d != null ? ` — ${d}` : ""}`); }
function note(name, detail) { const d = scrub(trunc(detail ?? "")); results.push({ section: S, name, ok: null, detail: d }); console.log(`NOTE [${S}] ${name} — ${d}`); }

async function api(host, method, p, body, token) {
  const res = await fetch(`${host}/api${p}`, { method, headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, contentType: res.headers.get("content-type") ?? "" };
}
async function rawGet(host, p) {
  const res = await fetch(`${host}${p}`, { method: "GET", headers: { accept: "*/*" }, redirect: "manual" });
  const text = await res.text();
  return { status: res.status, text, contentType: res.headers.get("content-type") ?? "" };
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));
const subView = (s) => pick(s ?? {}, ["companyId", "plan", "status", "billingSource", "accessMode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "limitOverrides", "statusChangedAt"]);
const authView = (r) => ({ status: r.status, userId: r.json?.user?.id ?? null, role: r.json?.user?.role ?? null, companyId: r.json?.user?.companyId ?? null, hasToken: typeof r.json?.token === "string", error: r.json?.error ?? null, code: r.json?.code ?? null });
const O = { t: null };
const own = (m, p, b) => api(PLATFORM, m, p, b, O.t);
const platformSub = (cid) => own("GET", `/platform/subscriptions/${cid}`);
const act = (cid, verb, body) => own("POST", `/platform/subscriptions/${cid}/${verb}`, body ?? {});
const tenantLogin = (email, password) => api(TENANT, "POST", "/auth/login", { email, password });

// ── /metrics contract (B24) ──────────────────────────────────────────────────
const JOB_KEYS = ["pending", "active", "enqueued", "completed", "failed", "deadLettered"];
const TOP_KEYS = ["uptimeSeconds", "timestamp", "requests", "jobs"];
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
// Anything that would indicate payload / identity / SQL / credential content in an operator snapshot.
const LEAK = /payload|gcm1|postgres|select |insert |update |delete |job_queue|@|secret|token|password|authorization|company|email|dedupe|"name"/i;
const jobsOk = (j) => !!j && typeof j === "object" && !Array.isArray(j) && sameSet(Object.keys(j), JOB_KEYS) && JOB_KEYS.every((k) => Number.isInteger(j[k]) && j[k] >= 0);
const metricsView = (r) => ({ status: r.status, topKeys: r.json && typeof r.json === "object" ? Object.keys(r.json) : null, jobs: r.json?.jobs ?? null, requests: r.json?.requests ? pick(r.json.requests, ["total", "errors", "errorRate", "byStatusClass"]) : null, uptimeSeconds: r.json?.uptimeSeconds ?? null, error: r.json?.error ?? null, code: r.json?.code ?? null });
const metrics = async (host, token) => { state.metricsCalls += 1; saveState(); return api(host, "GET", "/metrics", undefined, token); };

const fx = { A: {} };
async function section(name, fn) {
  S = name;
  try { await fn(); } catch (e) {
    results.push({ section: name, name: `section "${name}" aborted by an unexpected error`, ok: false, detail: scrub(String(e?.message ?? e)).slice(0, 300) });
    failures += 1; console.log(`FAIL [${name}] section aborted — ${scrub(String(e?.message ?? e)).slice(0, 300)}`);
  }
}
const nameOf = (k) => `B20 SMOKE ${TAG} B24-${k}`;

async function main() {
  const t0 = Date.now();

  // ── 401: unauthenticated on both public hosts ─────────────────────────────
  await section("metrics-unauthenticated", async () => {
    for (const [label, host] of [["platform host", PLATFORM], ["tenant host", TENANT]]) {
      const r = await metrics(host, null);
      check(`GET /metrics without a token → 401 on the ${label} (no jobs in the body)`, r.status === 401 && r.json?.jobs === undefined && typeof r.json?.error === "string", metricsView(r));
    }
  });

  // ── 200: the disposable platform owner ────────────────────────────────────
  let m1 = null;
  await section("metrics-owner", async () => {
    const ol = await api(PLATFORM, "POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    if (typeof ol.json?.token === "string") TOKENS.push(ol.json.token);
    check("disposable platform owner logs in on the platform host (no MFA)", ol.status === 200 && ol.json?.token && !ol.json?.mfaRequired && ol.json?.user?.id === OWNER_USER_ID && ol.json?.user?.role === "platform_owner", authView(ol));
    if (!ol.json?.token) throw new Error("owner login failed; nothing created");
    O.t = ol.json.token;
    fs.writeFileSync(TOKEN_FILE, `${O.t}\n`, { mode: 0o600 });
    fs.chmodSync(TOKEN_FILE, 0o600);
    note("owner token recorded for the read-only bracket phase (file mode 0600; never printed)", { bytes: fs.statSync(TOKEN_FILE).size > 0 });
    m1 = await metrics(PLATFORM, O.t);
    check("GET /metrics as the platform owner → 200 JSON", m1.status === 200 && m1.contentType.includes("application/json") && m1.json && typeof m1.json === "object", { status: m1.status, contentType: m1.contentType });
    check("body carries exactly the four documented top-level keys (uptimeSeconds, timestamp, requests, jobs)", m1.json && sameSet(Object.keys(m1.json), TOP_KEYS), { topKeys: m1.json ? Object.keys(m1.json) : null });
    check("jobs carries exactly the six QueueStats counters, each a non-negative integer", jobsOk(m1.json?.jobs), { jobs: m1.json?.jobs ?? null });
    check("jobs.pending is a live non-negative integer (never -1, never null)", Number.isInteger(m1.json?.jobs?.pending) && m1.json.jobs.pending >= 0 && m1.json.jobs.pending !== -1, { pending: m1.json?.jobs?.pending ?? null });
    check("requests block is numeric (total / errors / errorRate / latency / byStatusClass)", m1.json?.requests && ["total", "errors", "errorRate", "avgLatencyMs", "maxLatencyMs"].every((k) => typeof m1.json.requests[k] === "number") && m1.json.requests.byStatusClass && sameSet(Object.keys(m1.json.requests.byStatusClass), ["2xx", "3xx", "4xx", "5xx"]), pick(m1.json?.requests ?? {}, ["total", "errors", "errorRate", "byStatusClass"]));
    check("timestamp is a fresh ISO instant and uptime is a non-negative integer", typeof m1.json?.timestamp === "string" && Math.abs(Date.parse(m1.json.timestamp) - Date.now()) < 120000 && Number.isInteger(m1.json?.uptimeSeconds) && m1.json.uptimeSeconds >= 0, { timestamp: m1.json?.timestamp ?? null, uptimeSeconds: m1.json?.uptimeSeconds ?? null });
    check("the snapshot leaks nothing (no payload / job name / tenant id / e-mail / SQL / connection string / credential wording)", typeof m1.text === "string" && !LEAK.test(m1.text), { bytes: m1.text?.length ?? 0 });
    const m2 = await metrics(PLATFORM, O.t);
    check("a second owner read is 200 with the same contract (pending stays a non-negative integer)", m2.status === 200 && jobsOk(m2.json?.jobs), { first: m1.json?.jobs ?? null, second: m2.json?.jobs ?? null });
  });
  if (!O.t) return;

  // ── 403: a tenant admin of a disposable tenant ────────────────────────────
  let ex0 = null;
  await section("metrics-tenant-admin", async () => {
    ex0 = await platformSub(EXISTING);
    check("existing customer baseline active / free / manual / full (never mutated below)", ex0.status === 200 && ex0.json?.status === "active" && ex0.json?.plan === "free" && ex0.json?.billingSource === "manual" && ex0.json?.accessMode === "full", subView(ex0.json));
    const c = await own("POST", "/companies", { name: nameOf("A"), plan: "free", industry: "smoke-test", country: "ZZ" });
    const cid = c.json?.id; if (Number.isInteger(cid)) { state.companyIds.push(cid); saveState(); }
    check("disposable tenant A created via the platform API (company + canonical trial)", c.status === 201 && Number.isInteger(cid) && c.json?.subscription?.status === "trialing", { status: c.status, companyId: cid, subscription: subView(c.json?.subscription) });
    if (!Number.isInteger(cid)) throw new Error("tenant A creation failed");
    const adminEmail = `b20-smoke-${TAG}-a-admin@${DOMAIN}`;
    const a = await own("POST", "/users", { email: adminEmail, name: "B20 SMOKE B24-A admin (disposable)", role: "primary_admin", companyId: cid, password: A_ADMIN_PASSWORD });
    const aid = a.json?.id; if (Number.isInteger(aid)) { state.userIds.push(aid); saveState(); }
    check("tenant A primary admin created via the platform API", a.status === 201 && Number.isInteger(aid), { status: a.status, userId: aid });
    if (!Number.isInteger(aid)) throw new Error("tenant A admin creation failed");
    const actd = await act(cid, "activate");
    check("tenant A manually activated (active / full)", actd.status === 200 && actd.json?.status === "active" && actd.json?.accessMode === "full", subView(actd.json));
    fx.A = { cid, adminId: aid };
    const la = await tenantLogin(adminEmail, A_ADMIN_PASSWORD);
    const TA = la.json?.token; if (typeof TA === "string") TOKENS.push(TA);
    check("tenant A admin logs in on the tenant host", la.status === 200 && !!TA && la.json?.user?.companyId === cid && la.json?.user?.role === "primary_admin", authView(la));
    if (!TA) throw new Error("tenant admin login failed");
    const r = await metrics(TENANT, TA);
    check("GET /metrics as the tenant primary admin → 403 on the tenant host (no jobs in the body)", r.status === 403 && r.json?.jobs === undefined, metricsView(r));
    const r2 = await metrics(PLATFORM, TA);
    check("GET /metrics as the tenant primary admin → 403 on the platform host too (no jobs in the body)", r2.status === 403 && r2.json?.jobs === undefined, metricsView(r2));
  });

  // ── public health endpoints and the two portal shells ─────────────────────
  await section("health-and-portals", async () => {
    for (const [label, host] of [["platform host", PLATFORM], ["tenant host", TENANT]]) {
      const h = await rawGet(host, "/healthz");
      check(`${label}: GET /healthz → 200`, h.status === 200, { status: h.status, body: h.text.trim().slice(0, 40) });
      const ah = await api(host, "GET", "/healthz");
      check(`${label}: GET /api/healthz → 200 {"status":"ok"}`, ah.status === 200 && ah.json?.status === "ok", { status: ah.status, body: ah.json ?? ah.text?.slice(0, 80) });
      const rz = await api(host, "GET", "/readyz");
      check(`${label}: GET /api/readyz → 200 ok with database ok and storage ok (as before the deploy)`, rz.status === 200 && rz.json?.status === "ok" && rz.json?.checks?.database === "ok" && rz.json?.checks?.storage === "ok", { status: rz.status, body: rz.json ?? rz.text?.slice(0, 80) });
      const root = await rawGet(host, "/");
      check(`${label}: GET / → 200 text/html with the SPA root element`, root.status === 200 && /text\/html/i.test(root.contentType) && /<div id="root">/.test(root.text), { status: root.status, contentType: root.contentType, bytes: root.text.length, hasRoot: /<div id="root">/.test(root.text) });
    }
  });

  // ── preservation ──────────────────────────────────────────────────────────
  await section("preservation", async () => {
    const ex1 = await platformSub(EXISTING);
    check("existing customer unchanged after the smoke (active / free / manual / full, same timestamps)", ex1.status === 200 && ex0?.json && ["plan", "status", "billingSource", "accessMode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "statusChangedAt"].every((k) => ex1.json?.[k] === ex0.json?.[k]) && JSON.stringify(ex1.json?.limitOverrides ?? {}) === "{}", { before: subView(ex0?.json), after: subView(ex1.json) });
    if (Number.isInteger(fx.A.cid)) {
      const fa = await platformSub(fx.A.cid);
      check("the disposable tenant ends active / full (removed by cleanup next)", fa.json?.status === "active" && fa.json?.accessMode === "full", subView(fa.json));
    }
    const m3 = await metrics(PLATFORM, O.t);
    check("final owner read of /metrics is still 200 with six non-negative integer counters", m3.status === 200 && jobsOk(m3.json?.jobs), { jobs: m3.json?.jobs ?? null, metricsCalls: state.metricsCalls });
    note("elapsed", { ms: Date.now() - t0, metricsCalls: state.metricsCalls });
  });
}

async function finish(exitCode) {
  saveState();
  const sections = {};
  for (const r of results) { const s = (sections[r.section] ??= { passed: 0, failed: 0, notes: 0 }); if (r.ok === true) s.passed++; else if (r.ok === false) s.failed++; else s.notes++; }
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify({ tag: TAG, fixtures: fx, state, failures, sections, results }, null, 2));
  console.log(`\nB24 SUMMARY: ${results.filter((r) => r.ok === true).length} passed, ${failures} failed, ${results.filter((r) => r.ok === null).length} notes; metricsCalls=${state.metricsCalls}; sections=${JSON.stringify(sections)}; state=${JSON.stringify(state)}`);
  process.exit(exitCode);
}

main()
  .then(async () => { await finish(failures > 0 ? 1 : 0); })
  .catch(async (e) => {
    console.error(`SMOKE ERROR [${S}]: ${scrub(String(e?.message ?? e))}`);
    results.push({ section: S, name: "unexpected error", ok: false, detail: scrub(String(e?.message ?? e)).slice(0, 300) }); failures += 1;
    await finish(1);
  });
