// =============================================================================
// TEMPORARY — Batch 22 Correction 1 hosted smoke (GitHub runner, API-level, no
// browser). Public hosts only: PLATFORM_HOST (elite) and TENANT_HOST (admin).
// Disposable fixtures only: ONE tenant "B20 SMOKE <tag> B22C1-A" (the "B20 SMOKE"
// prefix is the cleanup marker), its administrator, ONE disposable platform owner
// inserted by `smoke-setup`. Exactly ONE valid-image POST /scans probe, sent only
// after the tenant's effective provider is proven to be gemini AND unconfigured
// (/ai/health configured=false) — a credential that appeared aborts the smoke
// before any probe. Expected: 503 AI_NOT_CONFIGURED with a provider-neutral
// message; one failed scan row; scan reservation released; no card_extraction
// ledger row; no stored scan image (404). Object labels go to STATE_FILE so the
// ops object check proves no GCS object was created. Never prints tokens, hashes,
// bucket names or signed URLs. No Stripe, e-mail, Gemini call or APK activity.
// =============================================================================
import fs from "node:fs";
import path from "node:path";

const env = (k, d) => { const v = process.env[k]; if (v == null || v === "") { if (d !== undefined) return d; throw new Error(`missing env ${k}`); } return v; };
const PLATFORM = env("PLATFORM_HOST", "https://elite.kaptnow.com");
const TENANT = env("TENANT_HOST", "https://admin.kaptnow.com");
const OWNER_EMAIL = env("OWNER_EMAIL"), OWNER_PASSWORD = env("OWNER_PASSWORD"), OWNER_USER_ID = Number(env("OWNER_USER_ID"));
const A_ADMIN_PASSWORD = env("A_ADMIN_PASSWORD");
const TAG = env("TAG"), DOMAIN = env("SMOKE_DOMAIN", "b20smoke.invalid");
const OUT_DIR = env("OUT_DIR"), STATE_FILE = env("STATE_FILE");
const EXISTING = Number(env("EXISTING_COMPANY_ID", "1"));
const FIXTURE_IMAGE = env("FIXTURE_IMAGE", "artifacts/api-server/scripts/ocr-fixtures/english-clean.jpg");
fs.mkdirSync(OUT_DIR, { recursive: true });

const state = { tag: TAG, startMs: Date.now(), companyIds: [], userIds: [OWNER_USER_ID], roleIds: [], objects: [], documentIds: [], scanIds: [], invitationIds: [], expectedEmailJobs: 0, probes: 0 };
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));
saveState();

let S = "init";
const results = [];
let failures = 0, findings = 0;
const trunc = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 900 ? s.slice(0, 900) + "…" : s; };
function check(name, ok, detail) { results.push({ section: S, name, ok: !!ok, detail: detail ?? null }); if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"} [${S}] ${name}${detail != null ? ` — ${trunc(detail)}` : ""}`); }
function note(name, detail) { results.push({ section: S, name, ok: null, detail: detail ?? null }); console.log(`NOTE [${S}] ${name} — ${trunc(detail ?? "")}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 20000, every = 1000) { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(every); } return last; }

async function api(host, method, p, body, token) {
  const res = await fetch(`${host}/api${p}`, { method, headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text: json ? null : text.slice(0, 160), headers: res.headers };
}
async function raw(host, method, p, token) {
  const res = await fetch(`${host}/api${p}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) }, redirect: "manual" });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes: buf, contentType: res.headers.get("content-type") };
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));
const subView = (s) => pick(s ?? {}, ["companyId", "plan", "status", "billingSource", "accessMode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "limitOverrides", "statusChangedAt"]);
const listOf = (j) => Array.isArray(j) ? j : (j && typeof j === "object" ? (Object.values(j).find((v) => Array.isArray(v)) ?? []) : []);
const O = { t: null };
const own = (m, p, b) => api(PLATFORM, m, p, b, O.t);
const platformSub = (cid) => own("GET", `/platform/subscriptions/${cid}`);
const act = (cid, verb, body) => own("POST", `/platform/subscriptions/${cid}/${verb}`, body ?? {});
const tenantLogin = (email, password) => api(TENANT, "POST", "/auth/login", { email, password });
const ten = (tok) => ({ get: (p) => api(TENANT, "GET", p, undefined, tok), post: (p, b) => api(TENANT, "POST", p, b ?? {}, tok) });
const authView = (r) => ({ status: r.status, userId: r.json?.user?.id ?? null, role: r.json?.user?.role ?? null, companyId: r.json?.user?.companyId ?? null, hasToken: typeof r.json?.token === "string", error: r.json?.error ?? null, code: r.json?.code ?? null });
const PROVIDER_LEAK = /gemini|google|api[_ -]?key|GEMINI|AI_INTEGRATIONS|retake|could not read the card|secret|token/i;

const fx = { A: {} };
let TA = null;
async function section(name, fn) {
  S = name;
  try { await fn(); } catch (e) {
    results.push({ section: name, name: `section "${name}" aborted by an unexpected error`, ok: false, detail: String(e?.message ?? e).slice(0, 300) });
    failures += 1; console.log(`FAIL [${name}] section aborted — ${String(e?.message ?? e).slice(0, 300)}`);
  }
}
const nameOf = (k) => `B20 SMOKE ${TAG} B22C1-${k}`;

async function main() {
  const t0 = Date.now();
  S = "fixtures";
  const ol = await api(PLATFORM, "POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  check("disposable platform owner logs in on elite (no MFA)", ol.status === 200 && ol.json?.token && !ol.json?.mfaRequired && ol.json?.user?.id === OWNER_USER_ID && ol.json?.user?.role === "platform_owner", authView(ol));
  if (!ol.json?.token) throw new Error("owner login failed; nothing created");
  O.t = ol.json.token;
  const billing = await own("GET", "/platform/billing/status");
  check("billing provider unavailable, checkout disabled (Stripe stays disabled)", billing.json?.available === false && (billing.json?.selfServiceCheckoutEnabled ?? false) === false, pick(billing.json ?? {}, ["provider", "available", "unavailableReason", "selfServiceCheckoutEnabled"]));
  const ex0 = await platformSub(EXISTING);
  check("existing customer baseline active / free / manual / full (never mutated below)", ex0.status === 200 && ex0.json?.status === "active" && ex0.json?.plan === "free" && ex0.json?.billingSource === "manual" && ex0.json?.accessMode === "full", subView(ex0.json));
  const c = await own("POST", "/companies", { name: nameOf("A"), plan: "free", industry: "smoke-test", country: "ZZ" });
  const cid = c.json?.id; if (Number.isInteger(cid)) { state.companyIds.push(cid); saveState(); }
  check("tenant A created via API (company + canonical trial)", c.status === 201 && Number.isInteger(cid) && c.json?.subscription?.status === "trialing", { status: c.status, companyId: cid, subscription: subView(c.json?.subscription) });
  if (!Number.isInteger(cid)) throw new Error("tenant A creation failed");
  const adminEmail = `b20-smoke-${TAG}-a-admin@${DOMAIN}`;
  const a = await own("POST", "/users", { email: adminEmail, name: "B20 SMOKE B22C1-A admin (disposable)", role: "primary_admin", companyId: cid, password: A_ADMIN_PASSWORD });
  const aid = a.json?.id; if (Number.isInteger(aid)) { state.userIds.push(aid); saveState(); }
  check("tenant A primary admin created via API", a.status === 201 && Number.isInteger(aid), { status: a.status, userId: aid });
  if (!Number.isInteger(aid)) throw new Error("tenant A admin creation failed");
  const actd = await act(cid, "activate");
  check("tenant A manually activated (active / full baseline)", actd.status === 200 && actd.json?.status === "active" && actd.json?.accessMode === "full", subView(actd.json));
  fx.A = { cid, adminId: aid, adminEmail };
  const la = await tenantLogin(adminEmail, A_ADMIN_PASSWORD);
  TA = la.json?.token;
  check("tenant A admin logs in on the tenant host", la.status === 200 && !!TA && la.json?.user?.companyId === cid, authView(la));
  if (!TA) throw new Error("tenant admin login failed");
  const A = ten(TA);

  // ── gate: effective provider is gemini AND unconfigured — otherwise no probe ──
  await section("gate", async () => {
    const st = await A.get("/ai/settings");
    check("tenant's effective AI provider is gemini / gemini-2.5-flash (default settings, no stub in production)", st.status === 200 && st.json?.provider === "gemini" && st.json?.model === "gemini-2.5-flash" && st.json?.enabled === true && JSON.stringify(st.json?.availableProviders) === JSON.stringify(["gemini"]), pick(st.json ?? {}, ["provider", "model", "enabled", "availableProviders", "hasCustomSettings"]));
    const hl = await A.get("/ai/health");
    const unconfigured = hl.status === 200 && hl.json?.provider === "gemini" && hl.json?.configured === false && hl.json?.status === "unconfigured";
    check("AI health reports the provider UNCONFIGURED before the probe (a credential that appeared would abort here)", unconfigured, pick(hl.json ?? {}, ["provider", "model", "configured", "status", "last24h"]));
    if (!unconfigured) throw new Error("provider is not unconfigured — the probe is NOT sent");
  });
  if (failures > 0) { note("probe skipped", "the gate did not pass; no POST /scans was sent"); return; }

  // ── the one probe ────────────────────────────────────────────────────────────
  await section("probe", async () => {
    const img = fs.readFileSync(FIXTURE_IMAGE);
    const dataUrl = `data:image/jpeg;base64,${img.toString("base64")}`;
    const scansBefore = listOf((await A.get("/scans?limit=100")).json).length;
    state.probes += 1; saveState();
    const t1 = Date.now();
    const scan = await A.post("/scans", { imageData: dataUrl, appLanguage: "en", captureSource: "camera" });
    const ms = Date.now() - t1;
    check("POST /scans (valid fixture image) → 503 AI_NOT_CONFIGURED", scan.status === 503 && scan.json?.code === "AI_NOT_CONFIGURED", { status: scan.status, code: scan.json?.code ?? null, error: scan.json?.error ?? null, requestId: scan.json?.requestId ?? null, latencyMs: ms, fixtureBytes: img.length });
    check("the message is provider-neutral (no provider / key / 'retake the photo' wording) and carries no extracted data", typeof scan.json?.error === "string" && !PROVIDER_LEAK.test(scan.json.error) && scan.json?.extractedData === undefined && scan.json?.details === undefined && scan.json?.context === undefined, { error: scan.json?.error ?? null, keys: Object.keys(scan.json ?? {}) });
    const rows = listOf((await A.get("/scans?limit=100")).json);
    const failed = rows.filter((r) => r.status === "failed");
    const processing = rows.filter((r) => r.status === "processing");
    const sid = failed[0]?.id ?? null;
    if (Number.isInteger(sid)) { state.scanIds.push(sid); state.objects.push(`scan:${fx.A.cid}:${sid}`); saveState(); }
    check("exactly one scan row exists for the probe and it is FAILED (none processing, none completed)", rows.length === scansBefore + 1 && failed.length === 1 && processing.length === 0 && rows.every((r) => r.status !== "completed"), { total: rows.length, before: scansBefore, failed: failed.length, processing: processing.length, scanId: sid });
    if (Number.isInteger(sid)) {
      const d = await A.get(`/scans/${sid}`);
      check("the failed scan reads back honestly: status failed, no extracted data, no confidence", d.status === 200 && d.json?.status === "failed" && (d.json?.extractedData ?? null) === null && (d.json?.confidence ?? null) === null, pick(d.json ?? {}, ["id", "status", "confidence", "extractedData"]));
      const im = await raw(TENANT, "GET", `/scans/${sid}/image`, TA);
      check("no scan image was stored (GET /scans/:id/image → 404; the route never uploaded)", im.status === 404, { status: im.status, contentType: im.contentType });
    }
    await sleep(1500);
    const usage = await A.get("/ai/usage");
    check("AI ledger has NO card_extraction row for the tenant (usage totals 0, no recent invocation) — no provider request happened", usage.status === 200 && (usage.json?.totals?.requests ?? -1) === 0 && (usage.json?.recent ?? []).length === 0, { totals: usage.json?.totals ?? null, recent: (usage.json?.recent ?? []).length });
    const hl = await A.get("/ai/health");
    check("AI health still reports unconfigured after the probe (last24h requests 0)", hl.json?.configured === false && hl.json?.status === "unconfigured" && (hl.json?.last24h?.requests ?? -1) === 0, pick(hl.json ?? {}, ["provider", "model", "configured", "status", "last24h"]));
  });

  S = "preservation";
  const ex1 = await platformSub(EXISTING);
  check("existing customer unchanged after the smoke (active / free / manual / full, same timestamps)", ex1.status === 200 && ["plan", "status", "billingSource", "accessMode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "statusChangedAt"].every((k) => ex1.json?.[k] === ex0.json?.[k]) && JSON.stringify(ex1.json?.limitOverrides ?? {}) === "{}", { before: subView(ex0.json), after: subView(ex1.json) });
  const fa = await platformSub(fx.A.cid);
  check("the disposable tenant ends active / full", fa.json?.status === "active" && fa.json?.accessMode === "full", subView(fa.json));
  note("elapsed", { ms: Date.now() - t0, probes: state.probes });
}

async function finish(exitCode) {
  saveState();
  const sections = {};
  for (const r of results) { const s = (sections[r.section] ??= { passed: 0, failed: 0, findings: 0, notes: 0 }); if (r.ok === true) s.passed++; else if (r.ok === false && r.kind === "finding") s.findings++; else if (r.ok === false) s.failed++; else s.notes++; }
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify({ tag: TAG, fixtures: fx, state, failures, findings, sections, results }, null, 2));
  console.log(`\nB22C1 SUMMARY: ${results.filter((r) => r.ok === true).length} passed, ${failures} failed, ${findings} findings, ${results.filter((r) => r.ok === null).length} notes; probes=${state.probes}; sections=${JSON.stringify(sections)}; state=${JSON.stringify(state)}`);
  process.exit(exitCode);
}

main()
  .then(async () => { await finish(failures > 0 ? 1 : 0); })
  .catch(async (e) => {
    console.error(`SMOKE ERROR [${S}]: ${e?.message ?? e}`);
    results.push({ section: S, name: "unexpected error", ok: false, detail: String(e?.message ?? e).slice(0, 300) }); failures += 1;
    await finish(1);
  });
