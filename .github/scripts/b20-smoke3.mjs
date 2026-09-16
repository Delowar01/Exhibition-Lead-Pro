// =============================================================================
// TEMPORARY — B20 Correction 4 hosted regression smoke (GitHub runner, real Chromium).
// Verifies on the hosted dev stack that the auth user projection (login, MFA login,
// /auth/me) carries the EFFECTIVE permission matrix (legacy column ∪ assigned RBAC
// roles) and that the tenant Subscription UI follows it.
// Public hosts only: PLATFORM_HOST (elite) and TENANT_HOST (admin). Disposable
// fixtures only: two "B20 SMOKE <tag> C4-…" tenants (A: primary admin + five
// employees, B: primary admin) and ONE disposable platform owner inserted by the
// `smoke-setup` phase. Real login forms, real RBAC role API — no seeded csp_user,
// no localStorage patching, no mocked auth response. The single direct DB write
// (`c4-legacy-grant`) sets the RAW legacy column of ONE disposable employee and is
// recorded in the state file. Every created id goes to STATE_FILE immediately so
// the always-run `cleanup` phase removes exactly those rows. The existing customer
// (company EXISTING_COMPANY_ID) is only READ. No Stripe, e-mail, Gemini, GCS, OCR
// or APK activity. Never prints passwords, tokens, MFA secrets or hashes.
// Sections: fixtures · viewer · manager · none · legacy · revocation · mfa ·
// isolation · console · preservation.
// =============================================================================
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const env = (k, d) => { const v = process.env[k]; if (v == null || v === "") { if (d !== undefined) return d; throw new Error(`missing env ${k}`); } return v; };
const PLATFORM = env("PLATFORM_HOST", "https://elite.kaptnow.com");
const TENANT = env("TENANT_HOST", "https://admin.kaptnow.com");
const OWNER_EMAIL = env("OWNER_EMAIL"), OWNER_PASSWORD = env("OWNER_PASSWORD"), OWNER_USER_ID = Number(env("OWNER_USER_ID"));
const PW = { aAdmin: env("A_ADMIN_PASSWORD"), bAdmin: env("B_ADMIN_PASSWORD"), viewer: env("EMP_VIEWER_PASSWORD"), manager: env("EMP_MANAGER_PASSWORD"), none: env("EMP_NONE_PASSWORD"), legacy: env("EMP_LEGACY_PASSWORD"), mfa: env("EMP_MFA_PASSWORD") };
const TAG = env("TAG"), DOMAIN = env("SMOKE_DOMAIN", "b20smoke.invalid");
const OUT_DIR = env("OUT_DIR"), STATE_FILE = env("STATE_FILE");
const EXISTING = Number(env("EXISTING_COMPANY_ID", "1"));
const DEPLOY_PATH = env("VPS_DEPLOY_PATH");
fs.mkdirSync(OUT_DIR, { recursive: true });

const state = { tag: TAG, companyIds: [], userIds: [OWNER_USER_ID], roleIds: [], directWrites: [] };
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
async function waitFor(fn, timeoutMs = 20000, every = 500) { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(every); } return last; }
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return String(u); } };

async function api(host, method, p, body, token) {
  const t0 = Date.now();
  const res = await fetch(`${host}/api${p}`, { method, headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text: json ? null : text.slice(0, 160), ms: Date.now() - t0 };
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));
const subView = (s) => pick(s ?? {}, ["companyId", "plan", "status", "billingSource", "accessMode", "reasonCode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "limitOverrides", "statusChangedAt"]);
const listOf = (j) => Array.isArray(j) ? j : (j && typeof j === "object" ? (Object.values(j).find((v) => Array.isArray(v)) ?? []) : []);
const totalOf = (j) => (j && typeof j.total === "number") ? j.total : listOf(j).length;
const O = { t: null };
const own = (m, p, b) => api(PLATFORM, m, p, b, O.t);
const platformSub = (cid) => own("GET", `/platform/subscriptions/${cid}`);
const act = (cid, verb, body) => own("POST", `/platform/subscriptions/${cid}/${verb}`, body ?? {});
const tenantLogin = (email, password) => api(TENANT, "POST", "/auth/login", { email, password });
const ten = (tok) => ({ get: (p) => api(TENANT, "GET", p, undefined, tok), post: (p, b) => api(TENANT, "POST", p, b ?? {}, tok), patch: (p, b) => api(TENANT, "PATCH", p, b ?? {}, tok), put: (p, b) => api(TENANT, "PUT", p, b ?? {}, tok), del: (p) => api(TENANT, "DELETE", p, undefined, tok) });

// ── permission helpers (never echo tokens / secrets) ─────────────────────────
const sortedPerms = (p) => { const out = {}; for (const k of Object.keys(p ?? {}).sort()) out[k] = [...(p[k] ?? [])].sort(); return out; };
const permsEqual = (a, b) => JSON.stringify(sortedPerms(a)) === JSON.stringify(sortedPerms(b));
const has = (p, m, a) => Array.isArray(p?.[m]) && p[m].includes(a);
const authView = (r) => ({ status: r.status, userId: r.json?.user?.id ?? null, role: r.json?.user?.role ?? null, companyId: r.json?.user?.companyId ?? null, permissions: r.json?.user?.permissions ?? null, mfaRequired: r.json?.mfaRequired ?? false, hasUserObject: r.json?.user != null, hasToken: typeof r.json?.token === "string", error: r.json?.error ?? null });
const meView = (r) => ({ status: r.status, role: r.json?.role ?? null, companyId: r.json?.companyId ?? null, permissions: r.json?.permissions ?? null });
const isPermDenial = (r) => r.status === 403 && /Missing permission/.test(r.json?.error ?? "");
const errView = (r) => ({ status: r.status, code: r.json?.code ?? null, error: r.json?.error ?? null });

let shotIndex = 0;
async function shot(page, name) { shotIndex += 1; const file = path.join(OUT_DIR, `${String(shotIndex).padStart(2, "0")}-${name}.png`); await page.screenshot({ path: file, fullPage: true }).catch((e) => note(`screenshot ${name}`, `failed: ${e.message}`)); return path.basename(file); }
async function uiLogin(page, host, email, password) { await page.goto(`${host}/login`, { waitUntil: "domcontentloaded" }); await page.locator("#email").fill(email); await page.locator("#password").fill(password); await page.locator('form button[type="submit"]').first().click(); }
async function signIn(page, email, password) { await uiLogin(page, TENANT, email, password); await page.waitForURL((u) => u.pathname.startsWith("/admin"), { timeout: 20000 }); await page.waitForTimeout(1500); }
const bodyText = async (page) => (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
const subNav = (page) => page.getByRole("link", { name: /^subscription$/i });
async function mgmtControls(page) { return { portalButton: await page.getByTestId("portal-button").count(), checkoutCard: await page.getByTestId("checkout-card").count(), paymentButtons: await page.getByRole("button", { name: /upgrade|checkout|manage billing|pay now|subscribe/i }).count() }; }
const noMgmt = (c) => c.portalButton === 0 && c.checkoutCard === 0 && c.paymentButtons === 0;
async function subscriptionView(page) {
  const txt = async (id) => (await page.getByTestId(id).innerText().catch(() => null))?.replace(/\s+/g, " ").slice(0, 60) ?? null;
  return { pageVisible: await page.getByTestId("subscription-page").isVisible().catch(() => false), noAccess: (await page.getByText("No access", { exact: true }).count()) > 0, couldNotLoad: (await page.getByText("Could not load the subscription", { exact: true }).count()) > 0, statusBadge: await txt("status-badge"), accessMode: await txt("access-mode"), planName: await txt("plan-name"), usageCard: await page.getByTestId("usage-card").isVisible().catch(() => false), usageRowEvents: await page.getByTestId("usage-row-events").isVisible().catch(() => false), usageRowContacts: await page.getByTestId("usage-row-contacts").isVisible().catch(() => false), portalUnavailable: await page.getByTestId("portal-unavailable").count(), controls: await mgmtControls(page) };
}
const rendersReal = (v) => v.pageVisible && !v.noAccess && !v.couldNotLoad && !!v.statusBadge && /free/i.test(v.planName ?? "") && v.usageCard && v.usageRowEvents;

// ── browser + console capture ────────────────────────────────────────────────
const consoleLog = []; const pageErrors = [];
let browser;
let ctxLabel = "";
async function newCtx(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, colorScheme: "light" });
  ctx.on("page", (page) => {
    page.on("console", (m) => { if (m.type() === "error") consoleLog.push({ ctx: ctxLabel, url: page.url(), text: m.text().slice(0, 240) }); });
    page.on("pageerror", (e) => pageErrors.push({ ctx: ctxLabel, url: page.url(), message: String(e?.message ?? e).slice(0, 240) }));
  });
  return ctx;
}
async function withPage(opts, fn) { const ctx = await newCtx(opts); ctxLabel = opts.label ?? ""; const page = await ctx.newPage(); page.setDefaultTimeout(20000); try { return await fn(page, ctx); } finally { await ctx.close().catch(() => {}); } }

function sshPhase(phase, a1, a2, a3) {
  const cmd = `DEPLOY_PATH='${DEPLOY_PATH}' PHASE='${phase}' ARG1='${a1}' ARG2='${a2}' ARG3='${a3}' bash "$HOME/b20-act.sh"`;
  return execFileSync("ssh", ["vps", cmd], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 120000 });
}
// Raw legacy column evidence for disposable users (read-only phase): id → { legacy, mfa, roles }
function permColumns(ids) {
  const out = {};
  for (const line of sshPhase("c4-perm-column", ids.join(","), "", "").split("\n")) {
    const m = line.match(/^user (\d+): role=(\S+) company_id=(\S+) legacy_permissions=(.*) mfa_enabled=(true|false) roles=\[([0-9,]*)\]$/);
    if (m) out[Number(m[1])] = { role: m[2], legacy: m[4], mfa: m[5] === "true", roles: m[6] ? m[6].split(",").map(Number) : [] };
  }
  return out;
}
async function ensureActive(cid) {
  const d = await platformSub(cid);
  if (!d.json || d.json.status === "active") return d.json;
  const r = await act(cid, d.json.status === "suspended" ? "reactivate" : "activate");
  note(`restore company ${cid}`, { status: r.status, after: r.json?.status });
  return (await platformSub(cid)).json;
}

// ─────────────────────────────────────────────────────────────────────────────
const fx = { A: {}, B: {}, emp: {} };
let TA = null, TB = null;
async function section(name, fn) {
  S = name;
  try { await fn(); } catch (e) {
    results.push({ section: name, name: `section "${name}" aborted by an unexpected error`, ok: false, detail: String(e?.message ?? e).slice(0, 300) });
    failures += 1; console.log(`FAIL [${name}] section aborted — ${String(e?.message ?? e).slice(0, 300)}`);
  }
}
const empEmail = (k) => `b20-smoke-${TAG}-a-${k}@${DOMAIN}`;

async function main() {
  const t0 = Date.now();
  // ── fixtures ────────────────────────────────────────────────────────────────
  S = "fixtures";
  const ol = await api(PLATFORM, "POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  check("disposable platform owner logs in on elite (no MFA)", ol.status === 200 && ol.json?.token && !ol.json?.mfaRequired && ol.json?.user?.id === OWNER_USER_ID && ol.json?.user?.role === "platform_owner" && ol.json?.user?.companyId == null, authView(ol));
  if (!ol.json?.token) throw new Error("owner login failed; nothing created");
  O.t = ol.json.token;
  const billing = await own("GET", "/platform/billing/status");
  const prices = await own("GET", "/platform/billing/prices");
  check("billing provider unavailable, checkout disabled, zero provider prices (Stripe stays disabled)", billing.json?.available === false && (billing.json?.selfServiceCheckout ?? false) === false && listOf(prices.json).length === 0, { ...pick(billing.json ?? {}, ["provider", "available", "unavailableReason", "selfServiceCheckout", "returnUrlConfigured"]), prices: listOf(prices.json).length });
  const ex0 = await platformSub(EXISTING);
  const exEv0 = totalOf((await own("GET", `/platform/subscriptions/${EXISTING}/events`)).json);
  check("existing customer baseline active / free / manual / full (never mutated below)", ex0.status === 200 && ex0.json?.status === "active" && ex0.json?.plan === "free" && ex0.json?.billingSource === "manual" && ex0.json?.accessMode === "full" && JSON.stringify(ex0.json?.limitOverrides ?? {}) === "{}", { ...subView(ex0.json), providerEvents: exEv0 });

  async function mkTenant(key) {
    const c = await own("POST", "/companies", { name: `B20 SMOKE ${TAG} C4-${key}`, plan: "free", industry: "smoke-test", country: "ZZ" });
    const cid = c.json?.id; if (Number.isInteger(cid)) { state.companyIds.push(cid); saveState(); }
    check(`tenant ${key} created via API (company + canonical subscription)`, c.status === 201 && Number.isInteger(cid), { status: c.status, companyId: cid, subscription: subView(c.json?.subscription) });
    if (!Number.isInteger(cid)) throw new Error(`tenant ${key} creation failed`);
    const adminEmail = `b20-smoke-${TAG}-${key.toLowerCase()}-admin@${DOMAIN}`;
    const a = await own("POST", "/users", { email: adminEmail, name: `B20 SMOKE C4-${key} admin (disposable)`, role: "primary_admin", companyId: cid, password: key === "A" ? PW.aAdmin : PW.bAdmin });
    const aid = a.json?.id; if (Number.isInteger(aid)) { state.userIds.push(aid); saveState(); }
    check(`tenant ${key} primary admin created via API`, a.status === 201 && Number.isInteger(aid), { status: a.status, userId: aid, companyId: a.json?.companyId });
    if (!Number.isInteger(aid)) throw new Error(`tenant ${key} admin creation failed`);
    const actd = await act(cid, "activate");
    check(`tenant ${key} manually activated (active / full baseline)`, actd.status === 200 && actd.json?.status === "active" && actd.json?.accessMode === "full", subView(actd.json));
    fx[key] = { cid, adminId: aid, adminEmail };
  }
  await mkTenant("A");
  await mkTenant("B");
  const la = await tenantLogin(fx.A.adminEmail, PW.aAdmin), lb = await tenantLogin(fx.B.adminEmail, PW.bAdmin);
  check("tenant admins A and B log in on the tenant host (primary_admin: no matrix in the projection is required)", la.status === 200 && lb.status === 200 && la.json?.user?.companyId === fx.A.cid && lb.json?.user?.companyId === fx.B.cid, { a: authView(la), b: authView(lb) });
  TA = la.json?.token; TB = lb.json?.token;
  if (!TA || !TB) throw new Error("tenant admin logins failed");
  const A = ten(TA), B = ten(TB);
  // Employees are created by the tenant's own primary admin (real user API; no `permissions` field is accepted).
  for (const k of ["viewer", "manager", "none", "legacy", "mfa"]) {
    const r = await A.post("/users", { email: empEmail(k), name: `B20 SMOKE C4 ${k} (disposable)`, role: "employee", companyId: fx.A.cid, password: PW[k] });
    const id = r.json?.id; if (Number.isInteger(id)) { state.userIds.push(id); saveState(); }
    fx.emp[k] = { id, email: empEmail(k) };
    check(`employee "${k}" created by the tenant admin (role employee, no permissions field)`, r.status === 201 && Number.isInteger(id) && r.json?.role === "employee" && r.json?.companyId === fx.A.cid, { status: r.status, userId: id });
    if (!Number.isInteger(id)) throw new Error(`employee ${k} creation failed`);
  }
  // RBAC roles through the real role API (tenant-scoped, catalog-validated).
  const viewerRole = await A.post("/rbac/roles", { name: `B20 SMOKE ${TAG} C4 billing viewer`, description: "disposable: subscriptions.view only", permissions: [{ module: "subscriptions", action: "view" }] });
  const managerRole = await A.post("/rbac/roles", { name: `B20 SMOKE ${TAG} C4 billing manager`, description: "disposable: subscriptions.view + manage", permissions: [{ module: "subscriptions", action: "view" }, { module: "subscriptions", action: "manage" }] });
  for (const r of [viewerRole, managerRole]) if (Number.isInteger(r.json?.id)) { state.roleIds.push(r.json.id); saveState(); }
  fx.viewerRoleId = viewerRole.json?.id; fx.managerRoleId = managerRole.json?.id;
  check("RBAC roles created via the role API (viewer: subscriptions.view; manager: subscriptions.view+manage)", viewerRole.status === 201 && managerRole.status === 201 && Number.isInteger(fx.viewerRoleId) && Number.isInteger(fx.managerRoleId), { viewer: { status: viewerRole.status, id: fx.viewerRoleId }, manager: { status: managerRole.status, id: fx.managerRoleId } });
  if (!Number.isInteger(fx.viewerRoleId) || !Number.isInteger(fx.managerRoleId)) throw new Error("role creation failed");
  const asg = { viewer: await A.put(`/users/${fx.emp.viewer.id}/roles`, { roleIds: [fx.viewerRoleId] }), manager: await A.put(`/users/${fx.emp.manager.id}/roles`, { roleIds: [fx.managerRoleId] }), mfa: await A.put(`/users/${fx.emp.mfa.id}/roles`, { roleIds: [fx.managerRoleId] }) };
  check("roles assigned (viewer → viewer role; manager and mfa → manager role; none and legacy → no role)", Object.values(asg).every((r) => r.status === 200), Object.fromEntries(Object.entries(asg).map(([k, r]) => [k, r.status])));
  // Legacy grant fixture: the ONLY direct write — raw legacy column of one disposable employee.
  const lg = sshPhase("c4-legacy-grant", String(fx.emp.legacy.id), String(fx.A.cid), TAG);
  state.directWrites.push({ phase: "c4-legacy-grant", userId: fx.emp.legacy.id, companyId: fx.A.cid, column: "users.permissions", value: { subscriptions: ["view"] } }); saveState();
  check("legacy-grant fixture: raw users.permissions of the disposable 'legacy' employee set to {subscriptions:[view]} (recorded direct write; removed with the tenant in cleanup)", /^updated=1$/m.test(lg) && /after: user \d+: legacy_permissions=\{"subscriptions": ?\["view"\]\}/.test(lg), lg.split("\n").filter((l) => /^(before|after|updated)/.test(l)).join(" | "));
  const empIds = ["viewer", "manager", "none", "legacy", "mfa"].map((k) => fx.emp[k].id);
  const col0 = permColumns(empIds);
  check("raw legacy column before the checks: {} for viewer/manager/none/mfa, {subscriptions:[view]} for legacy; role assignments as expected", ["viewer", "manager", "none", "mfa"].every((k) => col0[fx.emp[k].id]?.legacy === "{}") && /^\{"subscriptions": ?\["view"\]\}$/.test(col0[fx.emp.legacy.id]?.legacy ?? "") && JSON.stringify(col0[fx.emp.viewer.id]?.roles) === JSON.stringify([fx.viewerRoleId]) && JSON.stringify(col0[fx.emp.manager.id]?.roles) === JSON.stringify([fx.managerRoleId]) && JSON.stringify(col0[fx.emp.none.id]?.roles) === "[]" && JSON.stringify(col0[fx.emp.legacy.id]?.roles) === "[]", col0);

  browser = await chromium.launch();
  const tok = {};

  // ── 1. role-only viewer ─────────────────────────────────────────────────────
  await section("viewer", async () => {
    const lv = await tenantLogin(fx.emp.viewer.email, PW.viewer); tok.viewer = lv.json?.token;
    check("role-only viewer: the login user object carries subscriptions:view granted ONLY by the assigned role (legacy column {})", lv.status === 200 && has(lv.json?.user?.permissions, "subscriptions", "view") && !has(lv.json?.user?.permissions, "subscriptions", "manage"), authView(lv));
    const V = ten(tok.viewer);
    const me = await V.get("/auth/me");
    check("role-only viewer: /auth/me projection equals the login projection", me.status === 200 && permsEqual(me.json?.permissions, lv.json?.user?.permissions), meView(me));
    const cur = await V.get("/subscriptions/current"), use = await V.get("/subscriptions/usage");
    check("role-only viewer: the API permits the subscription and usage reads (200, own company)", cur.status === 200 && cur.json?.companyId === fx.A.cid && use.status === 200, { current: cur.status, usage: use.status, accessMode: cur.json?.accessMode, plan: cur.json?.plan });
    const portal = await V.post("/subscriptions/portal"), checkout = await V.post("/subscriptions/checkout", { planPriceId: 1 });
    check("role-only viewer: billing management stays denied on the API (portal / checkout need subscriptions.manage → 403)", isPermDenial(portal) && isPermDenial(checkout), { portal: errView(portal), checkout: errView(checkout) });
    await withPage({ label: "viewer-ui" }, async (p) => {
      await signIn(p, fx.emp.viewer.email, PW.viewer);
      const navCount = await subNav(p).count();
      check("role-only viewer UI: real form login → the Subscription navigation link appears", navCount > 0, { navCount, url: pathOf(p.url()) });
      await shot(p, "viewer-after-login");
      if (navCount > 0) await subNav(p).first().click(); else await p.goto(`${TENANT}/admin/subscription`, { waitUntil: "domcontentloaded" });
      await p.waitForURL((u) => u.pathname === "/admin/subscription", { timeout: 15000 }).catch(() => {});
      await p.getByTestId("subscription-page").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(1500);
      const v1 = await subscriptionView(p);
      check("role-only viewer UI: the Subscription page renders the real status / plan / usage after login", rendersReal(v1), v1);
      check("role-only viewer UI: billing-management controls are absent (no portal button, checkout card or payment action)", noMgmt(v1.controls), v1.controls);
      await shot(p, "viewer-subscription");
      await p.reload({ waitUntil: "domcontentloaded" });
      await p.getByTestId("subscription-page").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(1500);
      const v2 = await subscriptionView(p);
      check("role-only viewer UI: after a reload the page still renders real status and usage, still without management controls", rendersReal(v2) && v2.usageRowContacts && noMgmt(v2.controls) && (await subNav(p).count()) > 0, v2);
      await shot(p, "viewer-subscription-reload");
    });
  });

  // ── 2. role-based manager ───────────────────────────────────────────────────
  await section("manager", async () => {
    const lm = await tenantLogin(fx.emp.manager.email, PW.manager); tok.manager = lm.json?.token;
    check("role-based manager: login projection carries subscriptions view + manage from the assigned role", lm.status === 200 && has(lm.json?.user?.permissions, "subscriptions", "view") && has(lm.json?.user?.permissions, "subscriptions", "manage"), authView(lm));
    const M = ten(tok.manager);
    const me = await M.get("/auth/me");
    check("role-based manager: /auth/me projection equals the login projection", me.status === 200 && permsEqual(me.json?.permissions, lm.json?.user?.permissions), meView(me));
    const cur = await M.get("/subscriptions/current");
    const caps = pick(cur.json?.billing ?? {}, ["provider", "checkoutAvailable", "portalAvailable", "unavailableReason"]);
    check("role-based manager: subscription read succeeds and the API reports the provider-disabled capabilities", cur.status === 200 && cur.json?.billing && cur.json.billing.checkoutAvailable === false && cur.json.billing.portalAvailable === false, { status: cur.status, billing: caps });
    const portal = await M.post("/subscriptions/portal"), checkout = await M.post("/subscriptions/checkout", { planPriceId: 1 });
    check("role-based manager: manage-gated endpoints are NOT permission denials (provider unavailable is the only reason they fail; nothing is created)", !isPermDenial(portal) && !isPermDenial(checkout) && portal.status !== 200 && checkout.status !== 200, { portal: errView(portal), checkout: errView(checkout) });
    await withPage({ label: "manager-ui" }, async (p) => {
      await signIn(p, fx.emp.manager.email, PW.manager);
      const navCount = await subNav(p).count();
      check("role-based manager UI: the Subscription navigation link appears", navCount > 0, { navCount });
      await p.goto(`${TENANT}/admin/subscription`, { waitUntil: "domcontentloaded" });
      await p.getByTestId("subscription-page").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(1500);
      const v = await subscriptionView(p);
      check("role-based manager UI: the page renders real status / plan / usage", rendersReal(v), v);
      const consistent = (caps.checkoutAvailable ? v.controls.checkoutCard > 0 : v.controls.checkoutCard === 0) && (caps.portalAvailable ? v.controls.portalButton > 0 && v.portalUnavailable === 0 : v.controls.portalButton === 0 && v.portalUnavailable > 0);
      check("role-based manager UI: Checkout / Portal controls follow the API capabilities — provider disabled ⇒ no checkout card, no portal button, 'unavailable' notice, no misleading payment action", consistent && v.controls.paymentButtons === 0, { caps, controls: v.controls, portalUnavailable: v.portalUnavailable });
      await shot(p, "manager-subscription");
    });
  });

  // ── 3. no-grant employee ────────────────────────────────────────────────────
  await section("none", async () => {
    const ln = await tenantLogin(fx.emp.none.email, PW.none); tok.none = ln.json?.token;
    check("no-grant employee: login projection carries no subscription grant (nothing is invented)", ln.status === 200 && JSON.stringify(ln.json?.user?.permissions ?? null) === "{}", authView(ln));
    const N = ten(tok.none);
    const me = await N.get("/auth/me");
    check("no-grant employee: /auth/me projection is {} as well", me.status === 200 && JSON.stringify(me.json?.permissions ?? null) === "{}", meView(me));
    const cur = await N.get("/subscriptions/current"), use = await N.get("/subscriptions/usage"), portal = await N.post("/subscriptions/portal");
    check("no-grant employee: subscription / usage / portal are denied by the API (403 Missing permission)", isPermDenial(cur) && isPermDenial(use) && isPermDenial(portal), { current: errView(cur), usage: errView(use), portal: errView(portal) });
    await withPage({ label: "none-ui" }, async (p) => {
      await signIn(p, fx.emp.none.email, PW.none);
      const navCount = await subNav(p).count();
      await shot(p, "none-after-login");
      await p.goto(`${TENANT}/admin/subscription`, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(2500);
      const v = await subscriptionView(p);
      check("no-grant employee UI: no Subscription navigation link; the direct Subscription route shows 'No access' and renders no subscription data", navCount === 0 && v.noAccess && !v.pageVisible && !v.statusBadge && noMgmt(v.controls), { navCount, ...v });
      await shot(p, "none-subscription-no-access");
    });
  });

  // ── 5. legacy grant (existing per-user JSON keeps the same access) ──────────
  await section("legacy", async () => {
    const ll = await tenantLogin(fx.emp.legacy.email, PW.legacy); tok.legacy = ll.json?.token;
    check("legacy-grant employee: login projection equals the legacy column exactly ({subscriptions:[view]}; no role assigned)", ll.status === 200 && permsEqual(ll.json?.user?.permissions, { subscriptions: ["view"] }), authView(ll));
    const L = ten(tok.legacy);
    const me = await L.get("/auth/me");
    check("legacy-grant employee: /auth/me projection equals the login projection", me.status === 200 && permsEqual(me.json?.permissions, ll.json?.user?.permissions), meView(me));
    const cur = await L.get("/subscriptions/current"), use = await L.get("/subscriptions/usage"), portal = await L.post("/subscriptions/portal");
    check("legacy-grant employee: reads allowed (200), management denied (403) — unchanged behaviour", cur.status === 200 && use.status === 200 && isPermDenial(portal), { current: cur.status, usage: use.status, portal: errView(portal) });
    await withPage({ label: "legacy-ui" }, async (p) => {
      await signIn(p, fx.emp.legacy.email, PW.legacy);
      const navCount = await subNav(p).count();
      await p.goto(`${TENANT}/admin/subscription`, { waitUntil: "domcontentloaded" });
      await p.getByTestId("subscription-page").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(1500);
      const v = await subscriptionView(p);
      check("legacy-grant employee UI: navigation link present, page renders real status / usage, no management controls (same access as before)", navCount > 0 && rendersReal(v) && noMgmt(v.controls), { navCount, ...v });
      await shot(p, "legacy-subscription");
    });
  });

  // ── 4. revocation ───────────────────────────────────────────────────────────
  await section("revocation", async () => {
    // A tab that is already signed in (cached csp_user) stays open across the revocation.
    const openCtx = await newCtx({}); ctxLabel = "viewer-open-tab";
    const openPage = await openCtx.newPage(); openPage.setDefaultTimeout(20000);
    try {
      await signIn(openPage, fx.emp.viewer.email, PW.viewer);
      const navBefore = await subNav(openPage).count();
      const preTokenRead = await ten(tok.viewer).get("/subscriptions/current");
      check("before revocation: the open tab shows the Subscription link and the pre-revocation session still reads the subscription (200)", navBefore > 0 && preTokenRead.status === 200, { navBefore, preTokenRead: preTokenRead.status });
      const rev = await A.put(`/users/${fx.emp.viewer.id}/roles`, { roleIds: [] });
      check("revocation: the viewer's assigned role is removed through the role-assignment API", rev.status === 200, { status: rev.status });
      const oldSessionRead = await ten(tok.viewer).get("/subscriptions/current");
      check("revocation: the EXISTING session (token issued before the revocation) is denied immediately by the server (403 Missing permission)", isPermDenial(oldSessionRead), errView(oldSessionRead));
      const lr = await tenantLogin(fx.emp.viewer.email, PW.viewer); tok.viewerRevoked = lr.json?.token;
      const meR = await ten(tok.viewerRevoked).get("/auth/me"); const curR = await ten(tok.viewerRevoked).get("/subscriptions/current");
      check("revocation: a fresh login and /auth/me no longer carry the grant; the API denies the read", lr.status === 200 && !has(lr.json?.user?.permissions, "subscriptions", "view") && meR.status === 200 && !has(meR.json?.permissions, "subscriptions", "view") && isPermDenial(curR), { login: authView(lr), me: meView(meR), current: errView(curR) });
      // The already-open tab: report what it still shows (cached menu) — server authorization is what must deny.
      await openPage.goto(`${TENANT}/admin`, { waitUntil: "domcontentloaded" }); await openPage.waitForTimeout(1500);
      const navStill = await subNav(openPage).count();
      await openPage.goto(`${TENANT}/admin/subscription`, { waitUntil: "domcontentloaded" }); await openPage.waitForTimeout(3000);
      const vOpen = await subscriptionView(openPage);
      note("revocation (already-open tab, reported separately): cached menu / page state until re-login", { navLinkStillShown: navStill > 0, ...vOpen, excerpt: (await bodyText(openPage)).slice(0, 200) });
      check("revocation (already-open tab): no subscription data is rendered any more — the server denies the read (no status badge, no usage, no management controls)", !vOpen.statusBadge && !vOpen.usageCard && noMgmt(vOpen.controls), vOpen);
      await shot(openPage, "revocation-open-tab");
    } finally { await openCtx.close().catch(() => {}); }
    await withPage({ label: "viewer-revoked-ui" }, async (p) => {
      await signIn(p, fx.emp.viewer.email, PW.viewer);
      const navCount = await subNav(p).count();
      await p.goto(`${TENANT}/admin/subscription`, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(2500);
      const v = await subscriptionView(p);
      check("revocation UI: a fresh browser login no longer presents the navigation link; the direct route shows 'No access'", navCount === 0 && v.noAccess && !v.pageVisible && !v.statusBadge, { navCount, ...v });
      await shot(p, "revocation-fresh-login");
    });
  });

  // ── 7. MFA-completed login ──────────────────────────────────────────────────
  await section("mfa", async () => {
    const otplib = await import(pathToFileURL(path.join(process.cwd(), "artifacts/api-server/node_modules/otplib/dist/index.js")).href);
    const lf = await tenantLogin(fx.emp.mfa.email, PW.mfa);
    check("mfa employee (manager role): plain login projection carries view + manage", lf.status === 200 && has(lf.json?.user?.permissions, "subscriptions", "view") && has(lf.json?.user?.permissions, "subscriptions", "manage"), authView(lf));
    const F = ten(lf.json?.token);
    const setup = await F.post("/auth/mfa/setup", {});
    const secret = setup.json?.secret;
    const enable = secret ? await F.post("/auth/mfa/enable", { code: await otplib.generate({ secret, strategy: "totp" }) }) : { status: 0 };
    check("mfa enrolled on the disposable employee (setup + enable; secret never printed)", setup.status === 200 && typeof secret === "string" && enable.status === 200, { setup: setup.status, enable: enable.status, enableError: enable.json?.error ?? null });
    const challenge = await tenantLogin(fx.emp.mfa.email, PW.mfa);
    check("mfa login returns a challenge without a user object or access token", challenge.status === 200 && challenge.json?.mfaRequired === true && challenge.json?.user == null && typeof challenge.json?.token !== "string", authView(challenge));
    const done = secret ? await api(TENANT, "POST", "/auth/mfa/verify-login", { mfaToken: challenge.json?.mfaToken, code: await otplib.generate({ secret, strategy: "totp" }) }) : { status: 0 };
    const meF = done.json?.token ? await ten(done.json.token).get("/auth/me") : { status: 0 };
    check("MFA-completed login returns the same effective projection as /auth/me (view + manage from the role)", done.status === 200 && has(done.json?.user?.permissions, "subscriptions", "view") && has(done.json?.user?.permissions, "subscriptions", "manage") && meF.status === 200 && permsEqual(meF.json?.permissions, done.json?.user?.permissions), { verify: authView(done), me: meView(meF) });
    const col = permColumns([fx.emp.mfa.id]);
    check("mfa employee: MFA is enabled on the row while the raw legacy column stays {}", col[fx.emp.mfa.id]?.mfa === true && col[fx.emp.mfa.id]?.legacy === "{}", col);
  });

  // ── 6. tenant boundaries ────────────────────────────────────────────────────
  await section("isolation", async () => {
    const crossB = { userById: (await B.get(`/users/${fx.emp.manager.id}`)).status, setRoles: (await B.put(`/users/${fx.emp.manager.id}/roles`, { roleIds: [] })).status, roleById: (await B.get(`/rbac/roles/${fx.managerRoleId}`)).status, patchRole: (await B.patch(`/rbac/roles/${fx.managerRoleId}`, { name: "HACKED" })).status, deleteRole: (await B.del(`/rbac/roles/${fx.managerRoleId}`)).status };
    const bRoles = listOf((await B.get("/rbac/roles")).json).map((r) => r.id);
    const bUsers = listOf((await B.get("/users")).json).map((u) => u.id);
    check("tenant B cannot read or change tenant A's users / roles by id (404, not 403) and never lists them", Object.values(crossB).every((s) => s === 404) && !bRoles.includes(fx.managerRoleId) && !bRoles.includes(fx.viewerRoleId) && !bUsers.some((id) => empIds.includes(id)), { ...crossB, bListsARole: bRoles.includes(fx.managerRoleId), bListsAUser: bUsers.some((id) => empIds.includes(id)) });
    const colA = permColumns([fx.emp.manager.id]);
    const roleStill = await A.get(`/rbac/roles/${fx.managerRoleId}`);
    check("… and tenant A's manager role and assignment are unchanged", roleStill.status === 200 && roleStill.json?.name === `B20 SMOKE ${TAG} C4 billing manager` && JSON.stringify(colA[fx.emp.manager.id]?.roles) === JSON.stringify([fx.managerRoleId]), { role: roleStill.status, name: roleStill.json?.name, column: colA });
    const bCur = await B.get("/subscriptions/current"), mCur = await ten(tok.manager).get("/subscriptions/current");
    check("each tenant reads only its own subscription", bCur.json?.companyId === fx.B.cid && mCur.json?.companyId === fx.A.cid, { b: bCur.json?.companyId, aManager: mCur.json?.companyId });
    const ownerCrm = { contacts: (await own("GET", "/contacts")).status, leads: (await own("GET", "/leads")).status, events: (await own("GET", "/events")).status, subscriptionsCurrent: (await own("GET", "/subscriptions/current")).status, rbacRoles: (await own("GET", "/rbac/roles")).status, aRoleById: (await own("GET", `/rbac/roles/${fx.managerRoleId}`)).status };
    check("platform owner remains fenced from customer CRM and tenant billing (403 on every tenant module)", Object.entries(ownerCrm).filter(([k]) => k !== "rbacRoles" && k !== "aRoleById").every(([, s]) => s === 403), ownerCrm);
    note("platform owner on the tenant RBAC role endpoints (reported, not gated: /rbac is a team-management module, not customer CRM data)", { rbacRoles: ownerCrm.rbacRoles, aRoleById: ownerCrm.aRoleById });
    const ownerMe = await own("GET", "/auth/me");
    const ownerLoginPlatform = await api(PLATFORM, "POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    check("platform owner's own projection carries no tenant matrix (legacy {} — bypass role, no role join) on login and /auth/me", ownerLoginPlatform.status === 200 && JSON.stringify(ownerLoginPlatform.json?.user?.permissions ?? null) === "{}" && ownerMe.status === 200 && JSON.stringify(ownerMe.json?.permissions ?? null) === "{}", { login: authView(ownerLoginPlatform), me: meView(ownerMe) });
    const ownerLoginOnTenant = await api(TENANT, "POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    check("platform owner cannot sign in on the tenant host (403 host routing, no token, no projection)", ownerLoginOnTenant.status === 403 && !ownerLoginOnTenant.json?.token && ownerLoginOnTenant.json?.user == null, authView(ownerLoginOnTenant));
  });

  // ── console / page errors ───────────────────────────────────────────────────
  S = "console";
  const expectedNet = /Failed to load resource: the server responded with a status of (401|403|404|409|503)/;
  const unexpected = consoleLog.filter((c) => !expectedNet.test(c.text));
  const expectedNetwork = consoleLog.filter((c) => expectedNet.test(c.text));
  check("no uncaught page errors in any browser context", pageErrors.length === 0, pageErrors.slice(0, 5));
  check("no unexpected console errors (expected 4xx/5xx resource logs from denied pages are listed separately)", unexpected.length === 0, unexpected.slice(0, 8));
  note("expected network error console lines (by context)", Object.entries(expectedNetwork.reduce((m, c) => { m[c.ctx] = (m[c.ctx] ?? 0) + 1; return m; }, {})));

  // ── preservation ────────────────────────────────────────────────────────────
  S = "preservation";
  const col1 = permColumns(empIds);
  check("raw legacy column unchanged by every login / MFA login / role change: {} for viewer/manager/none/mfa, {subscriptions:[view]} for legacy (the resolver never writes it)", ["viewer", "manager", "none", "mfa"].every((k) => col1[fx.emp[k].id]?.legacy === "{}") && col1[fx.emp.legacy.id]?.legacy === col0[fx.emp.legacy.id]?.legacy && JSON.stringify(col1[fx.emp.viewer.id]?.roles) === "[]", col1);
  const ex1 = await platformSub(EXISTING); const exEv1 = totalOf((await own("GET", `/platform/subscriptions/${EXISTING}/events`)).json);
  check("existing customer unchanged after the smoke (active / free / manual / full, same overrides, same provider-event count)", ex1.status === 200 && ["plan", "status", "billingSource", "accessMode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "statusChangedAt"].every((k) => ex1.json?.[k] === ex0.json?.[k]) && JSON.stringify(ex1.json?.limitOverrides ?? {}) === "{}" && exEv1 === exEv0, { before: subView(ex0.json), after: subView(ex1.json), providerEvents: [exEv0, exEv1] });
  const fa = await platformSub(fx.A.cid), fb = await platformSub(fx.B.cid);
  check("both disposable tenants end active / full", fa.json?.status === "active" && fa.json?.accessMode === "full" && fb.json?.status === "active" && fb.json?.accessMode === "full", { a: subView(fa.json), b: subView(fb.json) });
  note("elapsed", { ms: Date.now() - t0 });
}

async function finish(exitCode) {
  saveState();
  const sections = {};
  for (const r of results) { const s = (sections[r.section] ??= { passed: 0, failed: 0, findings: 0, notes: 0 }); if (r.ok === true) s.passed++; else if (r.ok === false && r.kind === "finding") s.findings++; else if (r.ok === false) s.failed++; else s.notes++; }
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify({ tag: TAG, fixtures: { A: fx.A, B: fx.B, employees: fx.emp, roles: { viewer: fx.viewerRoleId, manager: fx.managerRoleId }, ownerUserId: OWNER_USER_ID }, state, failures, findings, sections, results, consoleErrors: consoleLog, pageErrors }, null, 2));
  console.log(`\nC4 SUMMARY: ${results.filter((r) => r.ok === true).length} passed, ${failures} failed, ${findings} findings, ${results.filter((r) => r.ok === null).length} notes; sections=${JSON.stringify(sections)}; state=${JSON.stringify(state)}`);
  process.exit(exitCode);
}

main()
  .then(async () => { try { for (const k of ["A", "B"]) if (fx[k]?.cid) await ensureActive(fx[k].cid); } catch {} await browser?.close().catch(() => {}); await finish(failures > 0 ? 1 : 0); })
  .catch(async (e) => {
    console.error(`SMOKE ERROR [${S}]: ${e?.message ?? e}`);
    results.push({ section: S, name: "unexpected error", ok: false, detail: String(e?.message ?? e).slice(0, 300) }); failures += 1;
    try { if (O.t) for (const k of ["A", "B"]) if (fx[k]?.cid) await ensureActive(fx[k].cid); } catch {}
    await browser?.close().catch(() => {});
    await finish(1);
  });
