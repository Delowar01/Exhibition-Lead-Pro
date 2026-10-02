// =============================================================================
// TEMPORARY — B21 Platform Owner admin panel hosted smoke (GitHub runner, real
// Chromium). Public hosts only: PLATFORM_HOST (elite) and TENANT_HOST (admin).
// Disposable fixtures only: tenants "B20 SMOKE <tag> B21-A / B21-B / B21-C" (the
// "B20 SMOKE" prefix is the cleanup marker), their administrators / employee, ONE
// disposable platform owner inserted by `smoke-setup`, one disposable RBAC role.
// Real platform-owner login through the form, real panel flows (list, search and
// filters, tenant detail, administrator creation + login, subscription management
// under the server's allowedActions, suspension / reactivation, tenant
// boundaries, audit attribution of platform-owner user actions with a bounded
// wait for the asynchronous audit write, users directory, deletion of a
// disposable tenant). Every created id goes to STATE_FILE immediately so the
// always-run `cleanup` phase removes exactly those rows. The existing customer
// (company EXISTING_COMPANY_ID) is only READ. No Stripe, e-mail, Gemini, GCS,
// OCR or APK activity. Never prints passwords, tokens or hashes.
// =============================================================================
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const env = (k, d) => { const v = process.env[k]; if (v == null || v === "") { if (d !== undefined) return d; throw new Error(`missing env ${k}`); } return v; };
const PLATFORM = env("PLATFORM_HOST", "https://elite.kaptnow.com");
const TENANT = env("TENANT_HOST", "https://admin.kaptnow.com");
const OWNER_EMAIL = env("OWNER_EMAIL"), OWNER_PASSWORD = env("OWNER_PASSWORD"), OWNER_USER_ID = Number(env("OWNER_USER_ID"));
const PW = { aAdmin: env("A_ADMIN_PASSWORD"), bAdmin: env("B_ADMIN_PASSWORD"), emp: env("A_EMPLOYEE_PASSWORD"), admin2: env("A_ADMIN2_PASSWORD") };
const TAG = env("TAG"), DOMAIN = env("SMOKE_DOMAIN", "b20smoke.invalid");
const OUT_DIR = env("OUT_DIR"), STATE_FILE = env("STATE_FILE");
const EXISTING = Number(env("EXISTING_COMPANY_ID", "1"));
const AUDIT_WAIT_MS = Number(env("AUDIT_WAIT_MS", "15000"));
fs.mkdirSync(OUT_DIR, { recursive: true });

const state = { tag: TAG, companyIds: [], userIds: [OWNER_USER_ID], roleIds: [] };
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
  const res = await fetch(`${host}/api${p}`, { method, headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text: json ? null : text.slice(0, 160) };
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
const authView = (r) => ({ status: r.status, userId: r.json?.user?.id ?? null, role: r.json?.user?.role ?? null, companyId: r.json?.user?.companyId ?? null, hasToken: typeof r.json?.token === "string", error: r.json?.error ?? null, code: r.json?.code ?? null });
const errView = (r) => ({ status: r.status, code: r.json?.code ?? null, error: r.json?.error ?? null });
const trail = async (cid) => (await own("GET", `/companies/${cid}/audit`)).json;
const teamRows = (a, entityId) => (a?.items ?? []).filter((r) => r.entityType === "team" && r.entityId === String(entityId));
const rowView = (r) => pick(r ?? {}, ["action", "entityType", "entityId", "userName", "metadata"]);

let shotIndex = 0;
async function shot(page, name) { shotIndex += 1; const file = path.join(OUT_DIR, `${String(shotIndex).padStart(2, "0")}-${name}.png`); await page.screenshot({ path: file, fullPage: true }).catch((e) => note(`screenshot ${name}`, `failed: ${e.message}`)); return path.basename(file); }
async function uiLogin(page, host, email, password) { await page.goto(`${host}/login`, { waitUntil: "domcontentloaded" }); await page.locator("#email").fill(email); await page.locator("#password").fill(password); await page.locator('form button[type="submit"]').first().click(); }
async function ownerSignIn(page) { await uiLogin(page, PLATFORM, OWNER_EMAIL, OWNER_PASSWORD); await page.waitForURL((u) => u.pathname.startsWith("/platform"), { timeout: 20000 }); await page.waitForTimeout(800); }
const bodyText = async (page) => (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
const txt = async (page, id) => (await page.getByTestId(id).innerText().catch(() => null))?.replace(/\s+/g, " ").trim() ?? null;
// The plan badge is rendered with CSS `capitalize`, which innerText applies ("Free"); compare case-insensitively.
const planTxt = async (page) => ((await txt(page, "detail-plan")) ?? "").toLowerCase();
const closeManager = (page) => page.getByTestId("sub-detail").getByRole("button", { name: "Close" }).click();
const auditHas = async (page, label) => (await page.getByTestId("detail-audit").getByText(label, { exact: true }).count()) > 0;

// ── browser + console capture ────────────────────────────────────────────────
const consoleLog = []; const pageErrors = [];
let browser; let ctxLabel = "";
async function newCtx() {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, colorScheme: "light" });
  ctx.on("page", (page) => {
    page.on("console", (m) => { if (m.type() === "error") consoleLog.push({ ctx: ctxLabel, url: page.url(), text: m.text().slice(0, 240) }); });
    page.on("pageerror", (e) => pageErrors.push({ ctx: ctxLabel, url: page.url(), message: String(e?.message ?? e).slice(0, 240) }));
  });
  return ctx;
}
async function withPage(label, fn) { const ctx = await newCtx(); ctxLabel = label; const page = await ctx.newPage(); page.setDefaultTimeout(20000); try { return await fn(page, ctx); } finally { await ctx.close().catch(() => {}); } }
async function ensureActive(cid) {
  const d = await platformSub(cid);
  if (!d.json || d.json.status === "active") return d.json;
  const r = await act(cid, d.json.status === "suspended" ? "reactivate" : "activate");
  note(`restore company ${cid}`, { status: r.status, after: r.json?.status });
  return (await platformSub(cid)).json;
}

// ─────────────────────────────────────────────────────────────────────────────
const fx = { A: {}, B: {}, C: {} };
let TA = null, TB = null;
async function section(name, fn) {
  S = name;
  try { await fn(); } catch (e) {
    results.push({ section: name, name: `section "${name}" aborted by an unexpected error`, ok: false, detail: String(e?.message ?? e).slice(0, 300) });
    failures += 1; console.log(`FAIL [${name}] section aborted — ${String(e?.message ?? e).slice(0, 300)}`);
  }
}
const nameOf = (k) => `B20 SMOKE ${TAG} B21-${k}`;

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
    const c = await own("POST", "/companies", { name: nameOf(key), plan: "free", industry: "smoke-test", country: "ZZ", primaryContactName: `B21 ${key} contact`, primaryContactEmail: `b20-smoke-${TAG}-${key.toLowerCase()}-contact@${DOMAIN}` });
    const cid = c.json?.id; if (Number.isInteger(cid)) { state.companyIds.push(cid); saveState(); }
    check(`tenant ${key} created via API with the extended profile (company + canonical trial)`, c.status === 201 && Number.isInteger(cid) && c.json?.subscription?.status === "trialing" && c.json?.primaryContactName === `B21 ${key} contact`, { status: c.status, companyId: cid, subscription: subView(c.json?.subscription), primaryContactName: c.json?.primaryContactName });
    if (!Number.isInteger(cid)) throw new Error(`tenant ${key} creation failed`);
    const adminEmail = `b20-smoke-${TAG}-${key.toLowerCase()}-admin@${DOMAIN}`;
    const a = await own("POST", "/users", { email: adminEmail, name: `B20 SMOKE B21-${key} admin (disposable)`, role: "primary_admin", companyId: cid, password: pw });
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
  const emp = await A.post("/users", { email: empEmail, name: "B20 SMOKE B21-A employee (disposable)", role: "employee", companyId: fx.A.cid, password: PW.emp });
  fx.A.empId = emp.json?.id; if (Number.isInteger(fx.A.empId)) { state.userIds.push(fx.A.empId); saveState(); }
  check("tenant A employee created by its own admin", emp.status === 201 && Number.isInteger(fx.A.empId), { status: emp.status, userId: fx.A.empId });
  const role = await A.post("/rbac/roles", { name: `B20 SMOKE ${TAG} B21 viewer`, description: "disposable view-only role", permissions: [{ module: "contacts", action: "view" }] });
  fx.A.roleId = role.json?.id; if (Number.isInteger(fx.A.roleId)) { state.roleIds.push(fx.A.roleId); saveState(); }
  check("tenant A RBAC role created by its own admin", role.status === 201 && Number.isInteger(fx.A.roleId), { status: role.status, roleId: fx.A.roleId });
  if (!Number.isInteger(fx.A.empId) || !Number.isInteger(fx.A.roleId)) throw new Error("tenant A fixtures failed");

  browser = await chromium.launch();

  // ── 1. tenant list: search and filters ──────────────────────────────────────
  await section("list", async () => {
    const total = totalOf((await own("GET", "/companies?limit=1")).json);
    await withPage("owner-list", async (p) => {
      await ownerSignIn(p);
      await p.goto(`${PLATFORM}/platform/companies`, { waitUntil: "domcontentloaded" });
      await p.getByTestId("platform-companies").waitFor({ state: "visible" });
      await p.getByTestId("company-total").waitFor({ state: "visible" });
      await waitFor(async () => /\d/.test((await txt(p, "company-total")) ?? ""), 15000);
      const shownTotal = await txt(p, "company-total");
      check("companies list shows the real server total", shownTotal === `${total.toLocaleString()} compan${total === 1 ? "y" : "ies"}`, { shownTotal, apiTotal: total });
      await shot(p, "list-all");
      await p.getByTestId("company-search").fill(nameOf("A"));
      await p.getByTestId(`company-row-${fx.A.cid}`).waitFor({ state: "visible" });
      await waitFor(async () => (await txt(p, "company-total")) === "1 company", 15000);
      check("search narrows to the disposable tenant A (row + total)", (await txt(p, "company-total")) === "1 company" && (await p.getByTestId(`company-row-${fx.B.cid}`).count()) === 0, { total: await txt(p, "company-total") });
      const rowText = await p.getByTestId(`company-row-${fx.A.cid}`).innerText();
      check("row mirrors the canonical subscription (Active / Full access / free)", /Active/.test(rowText) && /Full access/.test(rowText) && /free/i.test(rowText), rowText.replace(/\s+/g, " ").slice(0, 200));
      await p.getByTestId("company-status-filter").click();
      await p.getByRole("option", { name: "Suspended" }).click();
      await p.getByTestId("companies-empty").waitFor({ state: "visible" });
      check("status filter 'Suspended' (with the search) shows the empty state", true);
      await shot(p, "list-filter-empty");
      await p.getByTestId("company-status-filter").click();
      await p.getByRole("option", { name: "Active" }).click();
      await p.getByTestId(`company-row-${fx.A.cid}`).waitFor({ state: "visible" });
      await p.getByTestId("company-plan-filter").click();
      await p.getByRole("option", { name: "professional" }).click();
      await p.getByTestId("companies-empty").waitFor({ state: "visible" });
      await p.getByTestId("company-plan-filter").click();
      await p.getByRole("option", { name: "free" }).click();
      await p.getByTestId(`company-row-${fx.A.cid}`).waitFor({ state: "visible" });
      check("status 'Active' + plan filters resolve against the canonical subscription", true);
      await shot(p, "list-filtered");
      await p.getByTestId(`company-actions-${fx.A.cid}`).click();
      await p.getByTestId(`company-manage-${fx.A.cid}`).click();
      await p.getByTestId("sub-detail").waitFor({ state: "visible" });
      await p.getByTestId("detail-actions").waitFor({ state: "visible" });
      check("'Manage subscription' from the list opens the shared manager for tenant A", (await p.getByTestId("sub-detail").getByText(nameOf("A")).count()) > 0);
      await closeManager(p);
      await p.getByTestId("sub-detail").waitFor({ state: "hidden" }).catch(() => {});
      await p.getByTestId(`company-link-${fx.A.cid}`).click();
      await p.waitForURL((u) => u.pathname === `/platform/companies/${fx.A.cid}`);
      await p.getByTestId("company-detail").waitFor({ state: "visible" });
      check("row link opens the tenant page", true, { url: pathOf(p.url()) });
    });
  });

  // ── 2. tenant detail + profile edit + administrator creation ────────────────
  const admin2Email = `b20-smoke-${TAG}-a-admin2@${DOMAIN}`;
  await section("detail", async () => {
    await withPage("owner-detail", async (p) => {
      await ownerSignIn(p);
      await p.goto(`${PLATFORM}/platform/companies/${fx.A.cid}`, { waitUntil: "domcontentloaded" });
      await p.getByTestId("company-detail").waitFor({ state: "visible" });
      await p.getByTestId("detail-usage").waitFor({ state: "visible" });
      const v = { status: await txt(p, "detail-status"), access: await txt(p, "detail-access"), plan: await planTxt(p), contact: await txt(p, "profile-primaryContactName"), users: await txt(p, "count-users"), usageEvents: (await p.getByTestId("detail-usage-events").count()) > 0, allowed: await txt(p, "detail-allowed-actions") };
      check("tenant page renders the canonical state, profile, footprint and usage", v.status === "Active" && v.access === "Full access" && v.plan === "free" && v.contact === "B21 A contact" && v.users === "2" && v.usageEvents, v);
      const memberRows = await p.getByTestId("detail-users").getByRole("row").count();
      check("administrators and members card lists the tenant's accounts (admin + employee)", (await p.getByTestId("detail-users").getByText(fx.A.adminEmail).count()) === 1 && (await p.getByTestId("detail-users").getByText(empEmail).count()) === 1, { rows: memberRows });
      check("administrative trail shows the canonical creation", await auditHas(p, "Subscription created"));
      await shot(p, "detail-a");
      // Edit profile.
      await p.getByTestId("detail-edit").click();
      await p.getByTestId("edit-dialog").waitFor({ state: "visible" });
      await p.getByTestId("edit-legalName").fill(`${nameOf("A")} FZ-LLC`);
      await p.getByTestId("edit-timezone").fill("Asia/Dubai");
      await p.getByTestId("edit-submit").click();
      await p.getByTestId("edit-dialog").waitFor({ state: "hidden" });
      await waitFor(async () => (await txt(p, "profile-legalName")) === `${nameOf("A")} FZ-LLC`, 15000);
      const apiC = (await own("GET", `/companies/${fx.A.cid}`)).json;
      check("profile edit persists (page + API) and the subscription is untouched", (await txt(p, "profile-legalName")) === `${nameOf("A")} FZ-LLC` && apiC?.legalName === `${nameOf("A")} FZ-LLC` && apiC?.timezone === "Asia/Dubai" && apiC?.subscription?.plan === "free" && apiC?.subscription?.status === "active", { legalName: apiC?.legalName, timezone: apiC?.timezone, subscription: subView(apiC?.subscription) });
      await waitFor(async () => auditHas(p, "Company profile updated"), AUDIT_WAIT_MS, 1000);
      check("profile update appears on the tenant's administrative trail (bounded wait for the async audit write)", await auditHas(p, "Company profile updated"));
      // Add primary admin (shown-once password; the test types its own value).
      await p.getByTestId("detail-add-admin").click();
      await p.getByTestId("add-admin-dialog").waitFor({ state: "visible" });
      await p.getByTestId("add-admin-name").fill("B20 SMOKE B21-A admin2 (disposable)");
      await p.getByTestId("add-admin-email").fill(admin2Email);
      await p.getByTestId("add-admin-generate").click();
      const generated = await p.getByTestId("add-admin-password").inputValue();
      await p.getByTestId("add-admin-password").fill(PW.admin2);
      await p.getByTestId("add-admin-submit").click();
      await p.getByTestId("add-admin-created").waitFor({ state: "visible" });
      const shownOnce = await txt(p, "add-admin-created-password");
      await p.getByTestId("add-admin-done").click();
      const l2 = await tenantLogin(admin2Email, PW.admin2);
      fx.A.admin2Id = l2.json?.user?.id; if (Number.isInteger(fx.A.admin2Id)) { state.userIds.push(fx.A.admin2Id); saveState(); }
      check("primary administrator created from the panel (generated ≥ 12 chars, shown once) and signs in as primary_admin of tenant A", generated.length >= 12 && shownOnce === PW.admin2 && l2.status === 200 && l2.json?.user?.companyId === fx.A.cid && l2.json?.user?.role === "primary_admin", { generatedLength: generated.length, login: authView(l2) });
      await waitFor(async () => (await p.getByTestId("detail-users").getByText(admin2Email).count()) > 0 && (await auditHas(p, "Administrator account created")), AUDIT_WAIT_MS, 1000);
      check("the new administrator is listed and attributed on the tenant's trail", (await p.getByTestId("detail-users").getByText(admin2Email).count()) === 1 && (await auditHas(p, "Administrator account created")) && (await txt(p, "count-users")) === "3");
      await shot(p, "detail-a-admin-created");
    });
  });

  // ── 3. subscription management under allowedActions ─────────────────────────
  await section("subscription", async () => {
    await withPage("owner-subscription", async (p) => {
      await ownerSignIn(p);
      await p.goto(`${PLATFORM}/platform/companies/${fx.A.cid}`, { waitUntil: "domcontentloaded" });
      await p.getByTestId("company-detail").waitFor({ state: "visible" });
      await p.getByTestId("detail-manage-subscription").click();
      await p.getByTestId("sub-detail").waitFor({ state: "visible" });
      await p.getByTestId("detail-actions").waitFor({ state: "visible" });
      const allowed = (await platformSub(fx.A.cid)).json?.allowedActions ?? [];
      const shown = [];
      for (const a of allowed) if ((await p.getByTestId(`action-${a}`).count()) > 0) shown.push(a);
      const extra = (await p.getByTestId("detail-actions").locator("button").allInnerTexts()).length;
      check("manager offers exactly the server's allowedActions for tenant A", shown.length === allowed.length && extra === allowed.length, { allowed, shown, buttons: extra });
      // set_plan → professional (confirmed).
      await p.getByTestId("action-set_plan").click();
      await p.getByTestId("lifecycle-dialog").waitFor({ state: "visible" });
      await p.getByTestId("plan-select").click();
      await p.getByRole("option", { name: "professional" }).click();
      await p.getByTestId("lifecycle-confirm").click();
      await p.getByTestId("lifecycle-dialog").waitFor({ state: "hidden" });
      const afterPlan = await waitFor(async () => { const r = await platformSub(fx.A.cid); return r.json?.plan === "professional" ? r.json : null; }, 15000);
      check("plan change through the manager (confirmed) is applied canonically", afterPlan?.plan === "professional" && afterPlan?.status === "active", subView(afterPlan));
      // set_limits → events 5, then cleared.
      await p.getByTestId("action-set_limits").click();
      await p.getByTestId("lifecycle-dialog").waitFor({ state: "visible" });
      await p.getByTestId("limit-events").fill("5");
      await p.getByTestId("lifecycle-confirm").click();
      await p.getByTestId("lifecycle-dialog").waitFor({ state: "hidden" });
      const withLimit = await waitFor(async () => { const r = await platformSub(fx.A.cid); return r.json?.limitOverrides?.events === 5 ? r.json : null; }, 15000);
      const usageEvents = withLimit?.usage?.resources?.find((r) => r.resource === "events");
      check("limit override through the manager (confirmed) is applied and enforced in the usage report", withLimit?.limitOverrides?.events === 5 && usageEvents?.limit === 5 && usageEvents?.source === "override", { overrides: withLimit?.limitOverrides, events: usageEvents });
      await p.getByTestId("action-set_limits").click();
      await p.getByTestId("lifecycle-dialog").waitFor({ state: "visible" });
      await p.getByTestId("limit-events").fill("");
      await p.getByTestId("lifecycle-confirm").click();
      await p.getByTestId("lifecycle-dialog").waitFor({ state: "hidden" });
      const cleared = await waitFor(async () => { const r = await platformSub(fx.A.cid); return JSON.stringify(r.json?.limitOverrides ?? {}) === "{}" ? r.json : null; }, 15000);
      check("clearing the override restores the plan default", JSON.stringify(cleared?.limitOverrides ?? {}) === "{}", { overrides: cleared?.limitOverrides });
      await shot(p, "manager-after-actions");
      await closeManager(p);
      await p.getByTestId("sub-detail").waitFor({ state: "hidden" });
      await waitFor(async () => (await planTxt(p)) === "professional" && (await auditHas(p, "Plan changed")) && (await auditHas(p, "Limit overrides changed")), AUDIT_WAIT_MS, 1000);
      check("tenant page reflects the plan and lists both lifecycle actions on the trail", (await planTxt(p)) === "professional" && (await auditHas(p, "Plan changed")) && (await auditHas(p, "Limit overrides changed")), { plan: await planTxt(p), planChanged: await auditHas(p, "Plan changed"), limitsChanged: await auditHas(p, "Limit overrides changed") });
      // Suspend (confirmed) → blocked; reactivate (confirmed) → restored.
      await p.getByTestId("detail-toggle-status").click();
      await p.getByTestId("company-confirm-dialog").waitFor({ state: "visible" });
      await p.getByTestId("company-confirm").click();
      await waitFor(async () => (await txt(p, "detail-status")) === "Suspended", 15000);
      const refused = await tenantLogin(fx.A.adminEmail, PW.aAdmin);
      const blockedRead = await A.get("/subscriptions/current");
      check("suspend from the tenant page (confirmed): status Suspended / Blocked, tenant login refused (403), existing session 403 SUBSCRIPTION_SUSPENDED", (await txt(p, "detail-status")) === "Suspended" && (await txt(p, "detail-access")) === "Blocked" && refused.status === 403 && blockedRead.status === 403 && blockedRead.json?.code === "SUBSCRIPTION_SUSPENDED", { status: await txt(p, "detail-status"), access: await txt(p, "detail-access"), login: authView(refused), read: errView(blockedRead) });
      await shot(p, "detail-a-suspended");
      await p.getByTestId("detail-toggle-status").click();
      await p.getByTestId("company-confirm-dialog").waitFor({ state: "visible" });
      await p.getByTestId("company-confirm").click();
      await waitFor(async () => (await txt(p, "detail-status")) === "Active", 15000);
      const restored = await tenantLogin(fx.A.adminEmail, PW.aAdmin);
      TA = restored.json?.token ?? TA;
      check("reactivate (confirmed): previous state restored (Active / Full access / professional), tenant login works again", (await txt(p, "detail-status")) === "Active" && (await txt(p, "detail-access")) === "Full access" && (await planTxt(p)) === "professional" && restored.status === 200, { status: await txt(p, "detail-status"), access: await txt(p, "detail-access"), plan: await planTxt(p), login: authView(restored) });
      await waitFor(async () => (await auditHas(p, "Suspended")) && (await auditHas(p, "Suspension lifted")), AUDIT_WAIT_MS, 1000);
      check("suspension and its lifting are on the tenant's trail", (await auditHas(p, "Suspended")) && (await auditHas(p, "Suspension lifted")));
      await shot(p, "detail-a-reactivated");
    });
  });

  // ── 4. attribution of platform-owner user actions (Correction 1) ────────────
  await section("attribution", async () => {
    const A2 = ten(TA);
    const set = await own("PUT", `/users/${fx.A.empId}/roles`, { roleIds: [fx.A.roleId] });
    check("platform owner assigns tenant A's role to tenant A's employee (200)", set.status === 200, errView(set));
    const rolesRow = await waitFor(async () => { const rows = teamRows(await trail(fx.A.cid), fx.A.empId).filter((r) => r.action === "team.put" && /\/roles$/.test(String(r.metadata?.path ?? ""))); return rows.length ? rows : null; }, AUDIT_WAIT_MS, 1000);
    check("the role change appears exactly once on tenant A's administrative trail, attributed to the platform owner (bounded wait)", rolesRow?.length === 1 && rolesRow[0].userName === OWNER_EMAIL && rolesRow[0].entityId === String(fx.A.empId) && JSON.stringify(Object.keys(rolesRow[0].metadata ?? {}).sort()) === JSON.stringify(["method", "path"]), rolesRow?.map(rowView));
    const dis = await own("POST", `/users/${fx.A.empId}/disable`);
    const refused = await tenantLogin(empEmail, PW.emp);
    const en = await own("POST", `/users/${fx.A.empId}/enable`);
    const back = await tenantLogin(empEmail, PW.emp);
    check("disable (login refused) and enable (login works) by the platform owner", dis.status === 200 && [401, 403].includes(refused.status) && en.status === 200 && back.status === 200, { disable: dis.status, refused: authView(refused), enable: en.status, back: authView(back) });
    const stateRows = await waitFor(async () => { const rows = teamRows(await trail(fx.A.cid), fx.A.empId); const d = rows.filter((r) => /\/disable$/.test(String(r.metadata?.path ?? ""))); const e = rows.filter((r) => /\/enable$/.test(String(r.metadata?.path ?? ""))); return d.length && e.length ? { d, e } : null; }, AUDIT_WAIT_MS, 1000);
    check("disable and enable appear exactly once each on tenant A's trail, attributed to the platform owner", stateRows?.d.length === 1 && stateRows?.e.length === 1 && stateRows.d[0].userName === OWNER_EMAIL && stateRows.e[0].userName === OWNER_EMAIL, { disable: stateRows?.d.map(rowView), enable: stateRows?.e.map(rowView) });
    const bTrail = await trail(fx.B.cid);
    const bLeak = (bTrail?.items ?? []).filter((r) => r.entityId === String(fx.A.empId) || String(r.metadata?.path ?? "").includes(`/users/${fx.A.empId}`));
    check("tenant B's trail never carries these actions (its only team row is its own administrator's creation)", teamRows(bTrail, fx.A.empId).length === 0 && bLeak.length === 0, { bTeamRowsForEmp: teamRows(bTrail, fx.A.empId).length, bLeak: bLeak.length, bTotal: bTrail?.total, bActions: (bTrail?.items ?? []).map((r) => r.action) });
    const secA = await A2.get(`/security/audit?entityType=team&entityId=${fx.A.empId}`);
    const secB = await B.get(`/security/audit?entityType=team&entityId=${fx.A.empId}`);
    const secARows = listOf(secA.json).filter((r) => r.userName === OWNER_EMAIL);
    check("tenant A's Security Center lists the owner's actions on its employee (roles, disable, enable — once each); tenant B's does not", secA.status === 200 && secARows.filter((r) => r.action === "team.put").length === 1 && secARows.filter((r) => r.action === "team.post").length === 2 && secB.status === 200 && listOf(secB.json).length === 0, { aOwnerRows: secARows.map((r) => ({ action: r.action, path: r.metadata?.path })), bRows: listOf(secB.json).length });
    const allA = teamRows(await trail(fx.A.cid), fx.A.empId);
    check("tenant projection of these rows is sanitized (allow-listed keys, {path, method} metadata, no IP / password / e-mail)", allA.length >= 3 && allA.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(["action", "createdAt", "entityId", "entityType", "id", "metadata", "userName"]) && JSON.stringify(Object.keys(r.metadata ?? {}).sort()) === JSON.stringify(["method", "path"])) && !JSON.stringify(allA).match(/password|ipAddress|employee@/), { rows: allA.length });
    await withPage("owner-attribution", async (p) => {
      await ownerSignIn(p);
      await p.goto(`${PLATFORM}/platform/companies/${fx.A.cid}`, { waitUntil: "domcontentloaded" });
      await p.getByTestId("detail-audit").waitFor({ state: "visible" });
      await waitFor(async () => (await auditHas(p, "Team roles changed")) && (await auditHas(p, "Account disabled")) && (await auditHas(p, "Account enabled")), AUDIT_WAIT_MS, 1000);
      const labels = { roles: await p.getByTestId("detail-audit").getByText("Team roles changed", { exact: true }).count(), disabled: await p.getByTestId("detail-audit").getByText("Account disabled", { exact: true }).count(), enabled: await p.getByTestId("detail-audit").getByText("Account enabled", { exact: true }).count(), account: await p.getByTestId("detail-audit").getByText(`account #${fx.A.empId}`).count() };
      check("tenant A's page shows each attributed action once with the account reference", labels.roles === 1 && labels.disabled === 1 && labels.enabled === 1 && labels.account >= 3, labels);
      await shot(p, "detail-a-attribution");
      await p.goto(`${PLATFORM}/platform/companies/${fx.B.cid}`, { waitUntil: "domcontentloaded" });
      await p.getByTestId("detail-audit").waitFor({ state: "visible" });
      await p.waitForTimeout(1500);
      check("tenant B's page shows none of them", !(await auditHas(p, "Team roles changed")) && !(await auditHas(p, "Account disabled")) && !(await auditHas(p, "Account enabled")) && (await p.getByTestId("detail-audit").getByText(`account #${fx.A.empId}`).count()) === 0);
      await shot(p, "detail-b-attribution");
    });
  });

  // ── 5. tenant boundaries ────────────────────────────────────────────────────
  await section("isolation", async () => {
    const A2 = ten(TA);
    const crossB = { userById: (await B.get(`/users/${fx.A.empId}`)).status, setRoles: (await B.put(`/users/${fx.A.empId}/roles`, { roleIds: [] })).status, disable: (await B.post(`/users/${fx.A.empId}/disable`)).status, roleById: (await B.get(`/rbac/roles/${fx.A.roleId}`)).status };
    check("tenant B cannot read or change tenant A's user / role by id (404, not 403)", Object.values(crossB).every((s) => s === 404), crossB);
    check("… and the attempts left nothing on either trail", teamRows(await trail(fx.B.cid), fx.A.empId).length === 0 && teamRows(await trail(fx.A.cid), fx.A.empId).filter((r) => r.userName === fx.B.adminEmail).length === 0);
    const tenantPanel = { list: (await A2.get("/companies")).status, detail: (await A2.get(`/companies/${fx.A.cid}`)).status, audit: (await A2.get(`/companies/${fx.A.cid}/audit`)).status, patch: (await A2.patch(`/companies/${fx.A.cid}`, { name: "HACKED" })).status, suspend: (await A2.post(`/companies/${fx.B.cid}/suspend`)).status, platformSubs: (await A2.get("/platform/subscriptions")).status };
    check("tenant admin gets 403 on every panel read / mutation", Object.values(tenantPanel).every((s) => s === 403), tenantPanel);
    const ownerCrm = { contacts: (await own("GET", "/contacts")).status, leads: (await own("GET", "/leads")).status, events: (await own("GET", "/events")).status, subscriptionsCurrent: (await own("GET", "/subscriptions/current")).status };
    check("platform owner remains fenced from customer CRM and tenant billing (403)", Object.values(ownerCrm).every((s) => s === 403), ownerCrm);
    await withPage("tenant-admin-ui", async (p) => {
      await uiLogin(p, TENANT, fx.A.adminEmail, PW.aAdmin);
      await p.waitForURL((u) => u.pathname.startsWith("/admin"), { timeout: 20000 });
      await p.goto(`${TENANT}/platform/companies/${fx.A.cid}`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await p.waitForTimeout(3000);
      check("a tenant admin never reaches the panel in the browser (host / role routing)", !(pathOf(p.url()).startsWith("/platform") && (await p.getByTestId("company-detail").isVisible().catch(() => false))), { finalUrl: p.url(), detailVisible: await p.getByTestId("company-detail").isVisible().catch(() => false) });
      await shot(p, "tenant-admin-no-panel");
    });
  });

  // ── 6. users directory ──────────────────────────────────────────────────────
  await section("users", async () => {
    await withPage("owner-users", async (p) => {
      await ownerSignIn(p);
      await p.goto(`${PLATFORM}/platform/users?companyId=${fx.A.cid}`, { waitUntil: "domcontentloaded" });
      await p.getByTestId("platform-users").waitFor({ state: "visible" });
      await p.getByTestId("users-company-chip").waitFor({ state: "visible" });
      await waitFor(async () => /^Showing/.test((await txt(p, "users-total")) ?? ""), 15000);
      const chip = await txt(p, "users-company-chip");
      const rows = await p.locator('[data-testid^="user-row-"]').count();
      check("users directory filtered by tenant A shows its three accounts with the company chip", chip?.includes(nameOf("A")) && rows === 3 && (await txt(p, "users-total")) === "Showing 1–3 of 3 users", { chip, rows, total: await txt(p, "users-total") });
      await p.getByTestId("users-search").fill(admin2Email);
      await waitFor(async () => (await txt(p, "users-total")) === "Showing 1–1 of 1 user", 15000);
      check("search by e-mail narrows to the panel-created administrator", (await txt(p, "users-total")) === "Showing 1–1 of 1 user" && (await p.getByText(admin2Email).count()) === 1, { total: await txt(p, "users-total") });
      await shot(p, "users-directory");
    });
  });

  // ── 7. deletion of a disposable tenant through the panel ────────────────────
  await section("deletion", async () => {
    await withPage("owner-delete", async (p) => {
      await ownerSignIn(p);
      await p.goto(`${PLATFORM}/platform/companies`, { waitUntil: "domcontentloaded" });
      await p.getByTestId("company-new").click();
      await p.getByTestId("new-company-dialog").waitFor({ state: "visible" });
      await p.getByTestId("new-company-name").fill(nameOf("C"));
      await p.getByTestId("new-company-industry").fill("smoke-test");
      await p.getByTestId("new-company-submit").click();
      await p.waitForURL((u) => /\/platform\/companies\/\d+$/.test(u.pathname), { timeout: 20000 });
      fx.C.cid = Number(pathOf(p.url()).match(/\/platform\/companies\/(\d+)$/)?.[1]);
      if (Number.isInteger(fx.C.cid)) { state.companyIds.push(fx.C.cid); saveState(); }
      await p.getByTestId("company-detail").waitFor({ state: "visible" });
      check("a disposable tenant C is onboarded from the panel (manual trial) and opens on its page", Number.isInteger(fx.C.cid) && (await txt(p, "detail-status")) === "Trialing" && (await txt(p, "detail-access")) === "Full access", { companyId: fx.C.cid, status: await txt(p, "detail-status") });
      await shot(p, "detail-c-created");
      await p.getByTestId("detail-delete").click();
      await p.getByTestId("delete-dialog").waitFor({ state: "visible" });
      const disabledBefore = await p.getByTestId("delete-confirm").isDisabled();
      await p.getByTestId("delete-confirm-name").fill("wrong name");
      const disabledWrong = await p.getByTestId("delete-confirm").isDisabled();
      await p.getByTestId("delete-confirm-name").fill(nameOf("C"));
      await p.getByTestId("delete-confirm").waitFor({ state: "visible" });
      const enabledRight = await p.getByTestId("delete-confirm").isEnabled();
      await shot(p, "delete-dialog");
      await p.getByTestId("delete-confirm").click();
      await p.waitForURL((u) => u.pathname === "/platform/companies", { timeout: 20000 });
      const gone = await own("GET", `/companies/${fx.C.cid}`);
      const goneSub = await platformSub(fx.C.cid);
      check("delete requires the typed name and removes only tenant C (404 afterwards; A and B intact)", disabledBefore && disabledWrong && enabledRight && gone.status === 404 && goneSub.status === 404 && (await own("GET", `/companies/${fx.A.cid}`)).status === 200 && (await own("GET", `/companies/${fx.B.cid}`)).status === 200, { disabledBefore, disabledWrong, enabledRight, gone: gone.status, goneSub: goneSub.status });
      await p.goto(`${PLATFORM}/platform/companies/${fx.C.cid}`, { waitUntil: "domcontentloaded" });
      await p.getByTestId("company-detail-error").waitFor({ state: "visible" });
      check("the deleted tenant's page shows the not-found state", (await p.getByText("Company not found").count()) > 0);
      await shot(p, "detail-c-not-found");
    });
  });

  // ── console / page errors ───────────────────────────────────────────────────
  S = "console";
  const expectedNet = /Failed to load resource: the server responded with a status of (401|403|404|409|503)/;
  const unexpected = consoleLog.filter((c) => !expectedNet.test(c.text));
  const expectedNetwork = consoleLog.filter((c) => expectedNet.test(c.text));
  check("no uncaught page errors in any browser context", pageErrors.length === 0, pageErrors.slice(0, 5));
  check("no unexpected console errors (expected 4xx/5xx resource logs are listed separately)", unexpected.length === 0, unexpected.slice(0, 8));
  note("expected network error console lines (by context)", Object.entries(expectedNetwork.reduce((m, c) => { m[c.ctx] = (m[c.ctx] ?? 0) + 1; return m; }, {})));

  // ── preservation ────────────────────────────────────────────────────────────
  S = "preservation";
  const ex1 = await platformSub(EXISTING);
  check("existing customer unchanged after the smoke (active / free / manual / full, same timestamps)", ex1.status === 200 && ["plan", "status", "billingSource", "accessMode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "statusChangedAt"].every((k) => ex1.json?.[k] === ex0.json?.[k]) && JSON.stringify(ex1.json?.limitOverrides ?? {}) === "{}", { before: subView(ex0.json), after: subView(ex1.json) });
  const fa = await platformSub(fx.A.cid), fb = await platformSub(fx.B.cid);
  check("both remaining disposable tenants end active / full", fa.json?.status === "active" && fa.json?.accessMode === "full" && fb.json?.status === "active" && fb.json?.accessMode === "full", { a: subView(fa.json), b: subView(fb.json) });
  note("elapsed", { ms: Date.now() - t0 });
}

async function finish(exitCode) {
  saveState();
  const sections = {};
  for (const r of results) { const s = (sections[r.section] ??= { passed: 0, failed: 0, findings: 0, notes: 0 }); if (r.ok === true) s.passed++; else if (r.ok === false && r.kind === "finding") s.findings++; else if (r.ok === false) s.failed++; else s.notes++; }
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify({ tag: TAG, fixtures: fx, state, failures, findings, sections, results, consoleErrors: consoleLog, pageErrors }, null, 2));
  console.log(`\nB21 SUMMARY: ${results.filter((r) => r.ok === true).length} passed, ${failures} failed, ${findings} findings, ${results.filter((r) => r.ok === null).length} notes; sections=${JSON.stringify(sections)}; state=${JSON.stringify(state)}`);
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
