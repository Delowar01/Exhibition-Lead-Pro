// =============================================================================
// TEMPORARY — B19/B20 SUPPLEMENTAL hosted smoke (GitHub runner, real Chromium).
// Public hosts only: PLATFORM_HOST (elite) and TENANT_HOST (admin). Disposable
// fixtures only: two "B20 SMOKE <tag> …" tenants (A: primary admin + restricted
// employee, B: primary admin) and ONE disposable platform owner inserted by the
// `smoke-setup` phase. Every created id goes to STATE_FILE immediately so the
// always-run `cleanup` phase removes exactly those rows. The existing customer
// (company EXISTING_COMPANY_ID) is only READ. No Stripe, e-mail, Gemini, GCS,
// OCR, logo upload or APK activity. Never prints passwords, tokens or hashes.
// Sections (S): fixtures · host · employee · isolation · limits · workflow ·
// cancelled · blocked-run · expired · branding · automations · responsive ·
// console · preservation.
// =============================================================================
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const env = (k, d) => { const v = process.env[k]; if (v == null || v === "") { if (d !== undefined) return d; throw new Error(`missing env ${k}`); } return v; };
const PLATFORM = env("PLATFORM_HOST", "https://elite.kaptnow.com");
const TENANT = env("TENANT_HOST", "https://admin.kaptnow.com");
const OWNER_EMAIL = env("OWNER_EMAIL"), OWNER_PASSWORD = env("OWNER_PASSWORD"), OWNER_USER_ID = Number(env("OWNER_USER_ID"));
const PW_A_ADMIN = env("A_ADMIN_PASSWORD"), PW_A_EMP = env("A_EMPLOYEE_PASSWORD"), PW_B_ADMIN = env("B_ADMIN_PASSWORD");
const TAG = env("TAG"), DOMAIN = env("SMOKE_DOMAIN", "b20smoke.invalid");
const OUT_DIR = env("OUT_DIR"), STATE_FILE = env("STATE_FILE");
const EXISTING = Number(env("EXISTING_COMPANY_ID", "1"));
const DEPLOY_PATH = env("VPS_DEPLOY_PATH");
const RECOVERY_WAIT_MS = Number(env("RECOVERY_WAIT_MS", String(7 * 60 * 1000)));
fs.mkdirSync(OUT_DIR, { recursive: true });

const state = { tag: TAG, companyIds: [], userIds: [OWNER_USER_ID], runIds: [], definitionIds: [] };
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));
saveState();

let S = "init";
const results = [];
let failures = 0;
const trunc = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 900 ? s.slice(0, 900) + "…" : s; };
function check(name, ok, detail) { results.push({ section: S, name, ok: !!ok, detail: detail ?? null }); if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"} [${S}] ${name}${detail != null ? ` — ${trunc(detail)}` : ""}`); }
function note(name, detail) { results.push({ section: S, name, ok: null, detail: detail ?? null }); console.log(`NOTE [${S}] ${name} — ${trunc(detail ?? "")}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 20000, every = 500) { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(every); } return last; }
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return String(u); } };
const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u); } };

async function api(host, method, p, body, token) {
  const t0 = Date.now();
  const res = await fetch(`${host}/api${p}`, { method, headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text: json ? null : text.slice(0, 160), ms: Date.now() - t0, t0 };
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));
const subView = (s) => pick(s ?? {}, ["companyId", "plan", "status", "billingSource", "accessMode", "reasonCode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "allowedActions", "statusBeforeSuspension", "limitOverrides", "statusChangedAt"]);
const listOf = (j) => Array.isArray(j) ? j : (j && typeof j === "object" ? (Object.values(j).find((v) => Array.isArray(v)) ?? []) : []);
const totalOf = (j) => (j && typeof j.total === "number") ? j.total : listOf(j).length;
const O = { t: null };
const own = (m, p, b) => api(PLATFORM, m, p, b, O.t);
const platformSub = (cid) => own("GET", `/platform/subscriptions/${cid}`);
const act = (cid, verb, body) => own("POST", `/platform/subscriptions/${cid}/${verb}`, body ?? {});
const tenantLogin = (email, password) => api(TENANT, "POST", "/auth/login", { email, password });
const ten = (tok) => ({ get: (p) => api(TENANT, "GET", p, undefined, tok), post: (p, b) => api(TENANT, "POST", p, b ?? {}, tok), patch: (p, b) => api(TENANT, "PATCH", p, b ?? {}, tok), put: (p, b) => api(TENANT, "PUT", p, b ?? {}, tok), del: (p) => api(TENANT, "DELETE", p, undefined, tok) });

let shotIndex = 0;
async function shot(page, name) { shotIndex += 1; const file = path.join(OUT_DIR, `${String(shotIndex).padStart(2, "0")}-${name}.png`); await page.screenshot({ path: file, fullPage: true }).catch((e) => note(`screenshot ${name}`, `failed: ${e.message}`)); return path.basename(file); }
async function uiLogin(page, host, email, password) { await page.goto(`${host}/login`, { waitUntil: "domcontentloaded" }); await page.locator("#email").fill(email); await page.locator("#password").fill(password); await page.locator('form button[type="submit"]').first().click(); }
const bodyText = async (page) => (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");

// ── browser + console capture ────────────────────────────────────────────────
const consoleLog = []; const pageErrors = [];
let browser;
let ctxLabel = "";
async function newCtx(opts = {}) {
  const mobile = !!opts.mobile;
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, colorScheme: opts.theme === "dark" ? "dark" : "light" });
  if (opts.theme) {
    const scope = opts.userId != null ? `u${opts.userId}c${opts.companyId ?? ""}` : null;
    await ctx.addInitScript(([theme, sc]) => { try { localStorage.setItem("csp_theme", theme); if (sc) localStorage.setItem(`csp_theme:${sc}`, theme); } catch {} }, [opts.theme, scope]);
  }
  ctx.on("page", (page) => {
    page.on("console", (m) => { if (m.type() === "error") consoleLog.push({ ctx: ctxLabel, url: page.url(), text: m.text().slice(0, 240) }); });
    page.on("pageerror", (e) => pageErrors.push({ ctx: ctxLabel, url: page.url(), message: String(e?.message ?? e).slice(0, 240) }));
  });
  return ctx;
}
async function withPage(opts, fn) { const ctx = await newCtx(opts); ctxLabel = opts.label ?? ""; const page = await ctx.newPage(); page.setDefaultTimeout(20000); try { return await fn(page, ctx); } finally { await ctx.close().catch(() => {}); } }

// Lifecycle through the REAL platform dialog; API assertion behind it.
async function lifecycleUI(pp, cid, verb, expectStatus, reason) {
  await pp.goto(`${PLATFORM}/platform/subscriptions`, { waitUntil: "domcontentloaded" });
  await pp.getByTestId(`sub-manage-${cid}`).click();
  await pp.getByTestId("sub-detail").waitFor({ state: "visible" });
  await pp.getByTestId(`action-${verb}`).click();
  await pp.getByTestId("lifecycle-dialog").waitFor({ state: "visible" });
  if (reason) await pp.getByTestId("suspend-reason").fill(reason);
  const dialogText = (await pp.getByTestId("lifecycle-dialog").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
  await shot(pp, `elite-dialog-${verb}-c${cid}`);
  await pp.getByTestId("lifecycle-confirm").click();
  const after = await waitFor(async () => { const r = await platformSub(cid); return r.json?.status === expectStatus ? r.json : null; }, 20000);
  check(`platform dialog "${verb}" on company ${cid} → ${expectStatus}`, after?.status === expectStatus, { dialog: dialogText, after: subView(after ?? {}) });
  await pp.waitForTimeout(600);
  await shot(pp, `elite-after-${verb}-c${cid}`);
  return after;
}
async function ensureActive(cid) {
  const d = await platformSub(cid);
  if (!d.json || d.json.status === "active") return d.json;
  const verb = d.json.status === "suspended" ? "reactivate" : "activate";
  const r = await act(cid, verb);
  note(`restore company ${cid} via API ${verb}`, { status: r.status, after: r.json?.status });
  return (await platformSub(cid)).json;
}

// Responsive/theme QA of one page: overflow, essential controls inside the viewport, theme applied, screenshot.
async function qaPage(page, label, url, waitId, essentials, opts = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByTestId(waitId).first().waitFor({ state: "visible" });
  await page.waitForTimeout(700);
  if (opts.before) await opts.before(page);
  const vp = page.viewportSize();
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, iw: window.innerWidth, dark: document.documentElement.classList.contains("dark") }));
  const clipped = [];
  for (const id of essentials) {
    const loc = page.getByTestId(id).first();
    const visible = await loc.isVisible().catch(() => false);
    if (visible) await loc.scrollIntoViewIfNeeded().catch(() => {}); // a control inside a scrollable table/dialog is reachable, not clipped
    const box = visible ? await loc.boundingBox().catch(() => null) : null;
    if (!visible || !box || box.x < -1 || box.x + box.width > vp.width + 1 || box.width < 4) clipped.push({ id, visible, box: box ? { x: Math.round(box.x), w: Math.round(box.width) } : null });
  }
  const ok = m.sw <= m.cw + 1 && clipped.length === 0 && (opts.theme ? m.dark === (opts.theme === "dark") : true);
  check(`${label}: no horizontal overflow, essential controls inside the viewport, theme applied`, ok, { viewport: vp, scrollWidth: m.sw, clientWidth: m.cw, dark: m.dark, clipped });
  const file = await shot(page, label.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
  return { m, clipped, file };
}

function sshPhase(phase, a1, a2, a3) {
  const cmd = `DEPLOY_PATH='${DEPLOY_PATH}' PHASE='${phase}' ARG1='${a1}' ARG2='${a2}' ARG3='${a3}' bash "$HOME/b20-act.sh"`;
  return execFileSync("ssh", ["vps", cmd], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 120000 });
}

// ─────────────────────────────────────────────────────────────────────────────
const fx = { A: {}, B: {} };
let TA = null, TB = null, TE = null; // tenant tokens (A admin, B admin, A employee)
// A section that throws records ONE failure and the smoke continues with the next
// section (cleanup always runs from the workflow; tenants are restored in finally).
async function section(name, fn) {
  S = name;
  try { await fn(); } catch (e) {
    results.push({ section: name, name: `section "${name}" aborted by an unexpected error`, ok: false, detail: String(e?.message ?? e).slice(0, 300) });
    failures += 1; console.log(`FAIL [${name}] section aborted — ${String(e?.message ?? e).slice(0, 300)}`);
  }
}

async function main() {
  const t0 = Date.now();
  // ── fixtures ────────────────────────────────────────────────────────────────
  S = "fixtures";
  const ol = await api(PLATFORM, "POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  check("disposable platform owner logs in on elite (no MFA)", ol.status === 200 && ol.json?.token && !ol.json?.mfaRequired && ol.json?.user?.id === OWNER_USER_ID && ol.json?.user?.role === "platform_owner" && ol.json?.user?.companyId == null, { status: ol.status, userId: ol.json?.user?.id, role: ol.json?.user?.role, companyId: ol.json?.user?.companyId ?? null });
  if (!ol.json?.token) throw new Error("owner login failed; nothing created");
  O.t = ol.json.token;
  const billing = await own("GET", "/platform/billing/status");
  const prices = await own("GET", "/platform/billing/prices");
  check("billing provider unavailable, checkout disabled, zero provider prices", billing.json?.available === false && (billing.json?.selfServiceCheckout ?? false) === false && listOf(prices.json).length === 0, { ...pick(billing.json ?? {}, ["provider", "available", "unavailableReason", "selfServiceCheckout", "returnUrlConfigured"]), prices: listOf(prices.json).length });
  const ex0 = await platformSub(EXISTING);
  const exEv0 = totalOf((await own("GET", `/platform/subscriptions/${EXISTING}/events`)).json);
  check("existing customer baseline active / free / manual / full (never mutated below)", ex0.status === 200 && ex0.json?.status === "active" && ex0.json?.plan === "free" && ex0.json?.billingSource === "manual" && ex0.json?.accessMode === "full" && JSON.stringify(ex0.json?.limitOverrides ?? {}) === "{}", { ...subView(ex0.json), providerEvents: exEv0 });

  async function mkTenant(key, suffix) {
    const c = await own("POST", "/companies", { name: `B20 SMOKE ${TAG} ${suffix}`, plan: "free", industry: "smoke-test", country: "ZZ" });
    const cid = c.json?.id; if (Number.isInteger(cid)) { state.companyIds.push(cid); saveState(); }
    check(`tenant ${key} created via API (company + canonical trialing subscription)`, c.status === 201 && Number.isInteger(cid) && c.json?.subscription?.status === "trialing", { status: c.status, companyId: cid, subscription: subView(c.json?.subscription) });
    if (!Number.isInteger(cid)) throw new Error(`tenant ${key} creation failed`);
    const adminEmail = `b20-smoke-${TAG}-${key.toLowerCase()}-admin@${DOMAIN}`;
    const a = await own("POST", "/users", { email: adminEmail, name: `B20 SMOKE ${key} admin (disposable)`, role: "primary_admin", companyId: cid, password: key === "A" ? PW_A_ADMIN : PW_B_ADMIN });
    const aid = a.json?.id; if (Number.isInteger(aid)) { state.userIds.push(aid); saveState(); }
    check(`tenant ${key} primary admin created via API`, a.status === 201 && Number.isInteger(aid), { status: a.status, userId: aid, companyId: a.json?.companyId });
    if (!Number.isInteger(aid)) throw new Error(`tenant ${key} admin creation failed`);
    const actd = await act(cid, "activate");
    check(`tenant ${key} manually activated (active / full baseline for the checks below)`, actd.status === 200 && actd.json?.status === "active", subView(actd.json));
    fx[key] = { cid, adminId: aid, adminEmail };
  }
  await mkTenant("A", "A");
  await mkTenant("B", "B");
  const empEmail = `b20-smoke-${TAG}-a-employee@${DOMAIN}`;
  const emp = await own("POST", "/users", { email: empEmail, name: "B20 SMOKE A employee (disposable)", role: "employee", companyId: fx.A.cid, password: PW_A_EMP });
  const empId = emp.json?.id; if (Number.isInteger(empId)) { state.userIds.push(empId); saveState(); }
  check("tenant A employee created via API", emp.status === 201 && Number.isInteger(empId), { status: emp.status, userId: empId, role: emp.json?.role });
  fx.A.empId = empId; fx.A.empEmail = empEmail;

  const la = await tenantLogin(fx.A.adminEmail, PW_A_ADMIN); const lb = await tenantLogin(fx.B.adminEmail, PW_B_ADMIN); const le = await tenantLogin(empEmail, PW_A_EMP);
  check("tenant admins A/B and employee A log in on the tenant host", la.status === 200 && lb.status === 200 && le.status === 200 && la.json?.user?.companyId === fx.A.cid && lb.json?.user?.companyId === fx.B.cid && le.json?.user?.companyId === fx.A.cid, { a: la.status, b: lb.status, employee: le.status });
  TA = la.json?.token; TB = lb.json?.token; TE = le.json?.token;
  if (!TA || !TB || !TE) throw new Error("tenant logins failed");
  const A = ten(TA), B = ten(TB), E = ten(TE);
  // Restricted permissions are granted through the tenant's own RBAC role (the
  // accepted mechanism; the user-update API deliberately ignores `permissions`).
  const EMP_GRANTS = [{ module: "subscriptions", action: "view" }, { module: "leads", action: "view" }, { module: "contacts", action: "view" }, { module: "events", action: "view" }];
  const role = await A.post("/rbac/roles", { name: `B20 SMOKE ${TAG} viewer`, description: "disposable view-only role", permissions: EMP_GRANTS });
  const assign = Number.isInteger(role.json?.id) ? await A.put(`/users/${empId}/roles`, { roleIds: [role.json.id] }) : { status: 0 };
  const me = await E.get("/users/me").catch(() => ({ status: 0 }));
  check("employee restricted to a view-only RBAC role (subscriptions/leads/contacts/events view; no create/edit/manage, no workflows/organization)", role.status === 201 && assign.status === 200, { role: role.status, roleId: role.json?.id, assign: assign.status, assignedRoles: assign.json?.roles ?? assign.json?.roleIds ?? null, me: me.status });

  browser = await chromium.launch();

  // ── host routing (assertions) ───────────────────────────────────────────────
  await section("host", async () => {
  await withPage({ label: "host" }, async (p) => {
    await p.goto(`${PLATFORM}/admin`, { waitUntil: "domcontentloaded" }).catch(() => {}); await p.waitForTimeout(2000);
    check("elite host never renders the tenant portal (/admin redirects to the tenant host)", hostOf(p.url()) === hostOf(TENANT) && !(await p.getByTestId("subscription-page").isVisible().catch(() => false)), { finalUrl: p.url() });
    await p.goto(`${TENANT}/platform`, { waitUntil: "domcontentloaded" }).catch(() => {}); await p.waitForTimeout(2000);
    check("tenant host never renders the platform portal (/platform redirects to the platform host)", hostOf(p.url()) === hostOf(PLATFORM) && !(await p.getByTestId("platform-dashboard").isVisible().catch(() => false)), { finalUrl: p.url() });
  });
  await withPage({ label: "host-tenant-on-elite" }, async (p) => {
    await uiLogin(p, PLATFORM, fx.A.adminEmail, PW_A_ADMIN); await p.waitForTimeout(4000);
    const dash = await p.getByTestId("platform-dashboard").isVisible().catch(() => false);
    check("tenant admin signing in on the platform host is not shown the platform portal", !dash && !(hostOf(p.url()) === hostOf(PLATFORM) && pathOf(p.url()).startsWith("/platform")), { finalUrl: p.url(), platformDashboardVisible: dash, adminShellOnElite: hostOf(p.url()) === hostOf(PLATFORM) && pathOf(p.url()).startsWith("/admin") });
    await shot(p, "host-tenant-login-on-elite");
  });
  await withPage({ label: "host-owner-on-admin" }, async (p) => {
    await uiLogin(p, TENANT, OWNER_EMAIL, OWNER_PASSWORD); await p.waitForTimeout(4000);
    const dashOnAdmin = hostOf(p.url()) === hostOf(TENANT) && (await p.getByTestId("platform-dashboard").isVisible().catch(() => false));
    check("platform owner signing in on the tenant host is not shown the platform portal there", !dashOnAdmin, { finalUrl: p.url(), platformDashboardOnTenantHost: dashOnAdmin });
    await shot(p, "host-owner-login-on-admin");
  });
  });

  // ── employee permissions ────────────────────────────────────────────────────
  await section("employee", async () => {
  const eCur = await E.get("/subscriptions/current"), eUse = await E.get("/subscriptions/usage");
  check("employee (subscriptions:view) reads /subscriptions/current and /usage", eCur.status === 200 && eCur.json?.companyId === fx.A.cid && eUse.status === 200, { current: eCur.status, usage: eUse.status, accessMode: eCur.json?.accessMode });
  const ePortal = await E.post("/subscriptions/portal"), eCheckout = await E.post("/subscriptions/checkout", { planPriceId: 1 });
  check("employee billing management denied (portal/checkout need subscriptions:manage → 403)", ePortal.status === 403 && eCheckout.status === 403, { portal: ePortal.status, portalError: ePortal.json?.error, checkout: eCheckout.status });
  const ePlat = await E.get("/platform/subscriptions"), ePlatAct = await api(TENANT, "POST", `/platform/subscriptions/${fx.A.cid}/activate`, {}, TE);
  check("employee cannot read or drive platform subscription management (403)", ePlat.status === 403 && ePlatAct.status === 403, { list: ePlat.status, activate: ePlatAct.status });
  const eEv = await E.post("/events", { name: "B20 SMOKE employee event" }), eLead = await E.post("/leads", { title: "B20 SMOKE employee lead" }), eBr = await E.put("/organization/branding", { primaryColor: "#1d4ed8" }), eWf = await E.get("/workflows");
  check("employee create/edit denied by the permission matrix (events.create, leads.create, organization.edit, workflows.view → 403)", eEv.status === 403 && eLead.status === 403 && eBr.status === 403 && eWf.status === 403, { events: eEv.status, leads: eLead.status, branding: eBr.status, workflows: eWf.status });
  await withPage({ label: "employee-ui", userId: fx.A.empId, companyId: fx.A.cid, theme: "light" }, async (p) => {
    await uiLogin(p, TENANT, empEmail, PW_A_EMP); await p.waitForURL((u) => u.pathname.startsWith("/admin"));
    await p.goto(`${TENANT}/admin/subscription`, { waitUntil: "domcontentloaded" }); await p.getByTestId("subscription-page").waitFor({ state: "visible" });
    const noMgmt = (await p.getByTestId("portal-button").count()) === 0 && (await p.getByTestId("checkout-card").count()) === 0 && (await p.getByRole("button", { name: /upgrade|manage billing|checkout/i }).count()) === 0;
    check("employee UI: subscription page readable, no billing-management controls", noMgmt, { statusBadge: await p.getByTestId("status-badge").innerText().catch(() => null), accessMode: await p.getByTestId("access-mode").innerText().catch(() => null) });
    await shot(p, "employee-subscription");
    await p.goto(`${TENANT}/admin/automations`, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1500);
    const forb = await p.getByTestId("automations-forbidden").isVisible().catch(() => false);
    check("employee UI: automations management not offered (forbidden view, no create/publish controls)", forb && (await p.getByTestId("button-new-automation").count()) === 0, { forbidden: forb, navAutomationsLinks: await p.getByRole("link", { name: /^automations$/i }).count() });
    await shot(p, "employee-automations");
    await p.goto(`${TENANT}/admin/organization`, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1500);
    const ro = await p.getByTestId("branding-readonly").isVisible().catch(() => false);
    const saveBtn = p.getByTestId("branding-save");
    const saveUsable = (await saveBtn.count()) > 0 && (await saveBtn.isEnabled().catch(() => false));
    check("employee UI: branding is read-only (no usable save/reset/upload controls)", ro && !saveUsable && !(await p.getByTestId("branding-reset").isEnabled().catch(() => false)) && !(await p.getByTestId("branding-logo-upload").isEnabled().catch(() => false)), { readonlyBanner: ro, saveUsable });
    await shot(p, "employee-organization");
  });
  });

  // ── tenant isolation ────────────────────────────────────────────────────────
  let isoLead, isoEv, isoTask;
  await section("isolation", async () => {
  const aLeadIso = await A.post("/leads", { title: `B20 SMOKE ${TAG} iso lead` }); const aEvIso = await A.post("/events", { name: `B20 SMOKE ${TAG} iso event` }); const aTaskIso = await A.post("/tasks", { title: `B20 SMOKE ${TAG} iso task` });
  isoLead = aLeadIso.json?.id; isoEv = aEvIso.json?.id; isoTask = aTaskIso.json?.id;
  check("tenant A fixtures for isolation created", aLeadIso.status === 201 && aEvIso.status === 201 && aTaskIso.status === 201, { lead: isoLead, event: isoEv, task: isoTask });
  const crossReads = { lead: (await B.get(`/leads/${isoLead}`)).status, event: (await B.get(`/events/${isoEv}`)).status, taskInList: listOf((await B.get("/tasks?scope=all")).json).some((t) => t.id === isoTask) ? "visible" : "absent" };
  const crossWrites = { patchLead: (await B.patch(`/leads/${isoLead}`, { title: "HACKED" })).status, patchEvent: (await B.patch(`/events/${isoEv}`, { name: "HACKED" })).status, attachTag: (await B.post(`/leads/${isoLead}/tags`, { tagId: 1 })).status, patchTask: (await B.patch(`/tasks/${isoTask}`, { title: "HACKED" })).status, deleteTask: (await B.del(`/tasks/${isoTask}`)).status };
  check("tenant B cannot read tenant A records by id (404, not 403) and never lists them", crossReads.lead === 404 && crossReads.event === 404 && crossReads.taskInList === "absent", crossReads);
  check("tenant B cannot mutate tenant A records by id (404) …", Object.values(crossWrites).every((s) => s === 404), crossWrites);
  const aLeadAfter = await A.get(`/leads/${isoLead}`), aEvAfter = await A.get(`/events/${isoEv}`), aTaskStill = listOf((await A.get("/tasks?scope=all")).json).some((t) => t.id === isoTask);
  check("… and tenant A's records are unchanged", aLeadAfter.json?.title === `B20 SMOKE ${TAG} iso lead` && aEvAfter.json?.name === `B20 SMOKE ${TAG} iso event` && aTaskStill, { lead: aLeadAfter.json?.title, event: aEvAfter.json?.name, taskStillPresent: aTaskStill });
  const bEvents = listOf((await B.get("/events")).json).map((e) => e.id), aEvents = listOf((await A.get("/events")).json).map((e) => e.id);
  const bCur = await B.get("/subscriptions/current"), bUse = await B.get("/subscriptions/usage"), aUse = await A.get("/subscriptions/usage");
  const evUsed = (u) => listOf(u.json?.resources)?.find((r) => r.resource === "events")?.used;
  check("A and B each see only their own lists, subscription and usage", !bEvents.includes(isoEv) && aEvents.includes(isoEv) && bCur.json?.companyId === fx.B.cid && evUsed(bUse) === 0 && evUsed(aUse) === 1, { bEventsHasA: bEvents.includes(isoEv), bCompany: bCur.json?.companyId, eventsUsed: { a: evUsed(aUse), b: evUsed(bUse) } });
  const tenantPlat = { list: (await A.get("/platform/subscriptions")).status, detail: (await A.get(`/platform/subscriptions/${fx.A.cid}`)).status, limits: (await A.put(`/platform/subscriptions/${fx.A.cid}/limits`, { limits: { events: 99 } })).status, companies: (await A.get("/companies")).status };
  check("tenant users cannot access platform subscription management (403)", Object.values(tenantPlat).every((s) => s === 403), tenantPlat);
  const ownerCrm = { contacts: (await own("GET", "/contacts")).status, leads: (await own("GET", "/leads")).status, events: (await own("GET", "/events")).status, tasks: (await own("GET", "/tasks")).status, workflows: (await own("GET", "/workflows")).status, leadById: (await own("GET", `/leads/${isoLead}`)).status };
  check("platform owner cannot access customer CRM data (403 firewall on every tenant module)", Object.values(ownerCrm).every((s) => s === 403), ownerCrm);
  });

  // ── real usage-limit enforcement (events) ───────────────────────────────────
  const usage = async () => { const u = await A.get("/subscriptions/usage"); return listOf(u.json?.resources).find((r) => r.resource === "events") ?? null; };
  const evCount = async () => totalOf((await A.get("/events")).json);
  let base = 0;
  await section("limits", async () => {
  base = await evCount();
  const set2 = await own("PUT", `/platform/subscriptions/${fx.A.cid}/limits`, { limits: { events: base + 2 } });
  const u2 = await usage();
  check("override applied through the platform limits operation: reported limit/usage/source/enforced match", set2.status === 200 && JSON.stringify(set2.json?.limitOverrides) === JSON.stringify({ events: base + 2 }) && u2?.limit === base + 2 && u2?.used === base && u2?.source === "override" && u2?.enforced === true, { overrides: set2.json?.limitOverrides, usage: u2 });
  const e1 = await A.post("/events", { name: `B20 SMOKE ${TAG} event 1` }), e2 = await A.post("/events", { name: `B20 SMOKE ${TAG} event 2` });
  check("creation up to capacity succeeds", e1.status === 201 && e2.status === 201, { e1: e1.status, e2: e2.status });
  const e3 = await A.post("/events", { name: `B20 SMOKE ${TAG} event 3 (over)` });
  const u3 = await usage(); const c3 = await evCount();
  check("over-capacity request returns 409 LIMIT_EXCEEDED with details and creates nothing", e3.status === 409 && e3.json?.code === "LIMIT_EXCEEDED" && e3.json?.details?.resource === "events" && e3.json?.details?.limit === base + 2 && e3.json?.details?.used === base + 2 && c3 === base + 2 && u3?.remaining === 0, { status: e3.status, code: e3.json?.code, details: e3.json?.details, count: c3, usage: u3 });
  const set3 = await own("PUT", `/platform/subscriptions/${fx.A.cid}/limits`, { limits: { events: base + 3 } });
  const u3b = await usage();
  check("one remaining slot prepared for the concurrency test", set3.status === 200 && u3b?.remaining === 1, { usage: u3b });
  const [r1, r2] = await Promise.all([A.post("/events", { name: `B20 SMOKE ${TAG} race 1` }), A.post("/events", { name: `B20 SMOKE ${TAG} race 2` })]);
  const statuses = [r1.status, r2.status].sort();
  const overlap = Math.max(r1.t0, r2.t0) < Math.min(r1.t0 + r1.ms, r2.t0 + r2.ms);
  const cRace = await evCount(); const uRace = await usage();
  check("two concurrent requests for the last slot: exactly one 201 and one 409, count = limit", statuses[0] === 201 && statuses[1] === 409 && cRace === base + 3 && uRace?.remaining === 0, { statuses: [r1.status, r2.status], codes: [r1.json?.code, r2.json?.code], inFlightOverlap: overlap, durationsMs: [r1.ms, r2.ms], count: cRace });
  const clr = await own("PUT", `/platform/subscriptions/${fx.A.cid}/limits`, { limits: {} });
  const uClr = await usage(); const e4 = await A.post("/events", { name: `B20 SMOKE ${TAG} event after clear` });
  check("clearing the override restores the plan default (unlimited) and creation works again", clr.status === 200 && JSON.stringify(clr.json?.limitOverrides ?? {}) === "{}" && uClr?.limit === null && uClr?.source === "unlimited" && uClr?.enforced === false && e4.status === 201, { overrides: clr.json?.limitOverrides, usage: uClr, e4: e4.status, count: await evCount() });
  const plansA = listOf((await A.get("/subscriptions/plans")).json); const freePlan = plansA.find((p) => (p.id ?? p.plan) === "free");
  const exL = await platformSub(EXISTING);
  check("shared plan limits and the existing customer untouched by the override", JSON.stringify(exL.json?.limitOverrides ?? {}) === "{}" && freePlan != null && Object.entries(freePlan).filter(([k]) => /limit/i.test(k)).every(([, v]) => v == null || (typeof v === "object" && Object.values(v).every((x) => x == null))), { existingOverrides: exL.json?.limitOverrides, freePlan: pick(freePlan ?? {}, Object.keys(freePlan ?? {}).filter((k) => /limit|id|name/i.test(k))) });
  }); // limits
  // Whatever happened above, make sure no override lingers on the disposable tenant.
  await own("PUT", `/platform/subscriptions/${fx.A.cid}/limits`, { limits: {} });

  // ── workflow: exactly-once execution on a writable tenant ───────────────────
  let tagId, C1, C2, L1, L2, D, run1 = null;
  await section("workflow", async () => {
  const tag = await A.post("/tags", { name: `B20 SMOKE ${TAG} tag`, color: "#2563eb" });
  const c1 = await A.post("/contacts", { firstName: "B20", lastName: `Smoke ${TAG} one` }), c2 = await A.post("/contacts", { firstName: "B20", lastName: `Smoke ${TAG} two` });
  tagId = tag.json?.id; C1 = c1.json?.id; C2 = c2.json?.id;
  check("workflow fixtures (tag, two contacts) created", tag.status === 201 && c1.status === 201 && c2.status === 201, { tagId, C1, C2 });
  const l2 = await A.post("/leads", { contactId: C2, title: `B20 SMOKE ${TAG} lead two (no automation yet)` }); L2 = l2.json?.id;
  const def = await A.post("/workflows", { name: `B20 SMOKE ${TAG} automation`, description: "lead.created → task.create → lead.add_tag", trigger: { type: "lead.created" }, actions: [{ type: "task.create", config: { title: `B20 SMOKE ${TAG} task`, type: "custom", assignee: { kind: "actor" } } }, { type: "lead.add_tag", config: { tagId } }] });
  D = def.json?.id; if (Number.isInteger(D)) { state.definitionIds.push(D); saveState(); }
  const pub = Number.isInteger(D) ? await A.post(`/workflows/${D}/publish`) : { status: 0 };
  check("automation created and published (lead.created → task.create → lead.add_tag)", def.status === 201 && pub.status === 200 && pub.json?.status === "published", { definitionId: D, created: def.status, published: pub.json?.status, revision: pub.json?.revision, validation: def.json?.validation ?? pub.json?.validation ?? null });
  if (!Number.isInteger(D)) throw new Error("automation creation failed");
  const l1 = await A.post("/leads", { contactId: C1, title: `B20 SMOKE ${TAG} lead one` }); L1 = l1.json?.id;
  check("real CRM mutation (POST /leads) triggers the automation", l1.status === 201 && Number.isInteger(L1), { leadId: L1 });
  run1 = await waitFor(async () => { const r = await A.get(`/workflows/runs?definitionId=${D}&entityId=${L1}`); const it = listOf(r.json)[0]; return it && (it.status === "completed" || it.status === "failed") ? it : null; }, 90000, 1500);
  if (run1?.id) { state.runIds.push(run1.id); saveState(); }
  const r1d = run1?.id ? await A.get(`/workflows/runs/${run1.id}`) : { json: null };
  const acts1 = listOf(r1d.json?.actions);
  check("durable queue executed the run: completed, both actions completed once", run1?.status === "completed" && acts1.length === 2 && acts1.every((a) => a.status === "completed" && a.attempts === 1) && acts1[0]?.actionType === "task.create" && Number.isInteger(acts1[0]?.result?.taskId) && acts1[1]?.actionType === "lead.add_tag" && acts1[1]?.result?.tagId === tagId && r1d.json?.enqueueGeneration === 1, { run: pick(r1d.json ?? {}, ["id", "status", "enqueueGeneration", "actionSummary", "queuedAt", "startedAt", "completedAt"]), actions: acts1.map((a) => pick(a, ["actionIndex", "actionType", "status", "attempts", "result"])) });
  const tasks1 = listOf((await A.get(`/tasks?scope=all&contactId=${C1}`)).json).filter((t) => t.title === `B20 SMOKE ${TAG} task`);
  const lead1 = await A.get(`/leads/${L1}`); const tags1 = listOf(lead1.json?.tags);
  const runsForD = totalOf((await A.get(`/workflows/runs?definitionId=${D}`)).json);
  const runsForL2 = totalOf((await A.get(`/workflows/runs?entityId=${L2}`)).json);
  check("exactly one task, one tag association and one completed run (no duplicates)", tasks1.length === 1 && tasks1[0].id === acts1[0]?.result?.taskId && tags1.length === 1 && tags1[0].id === tagId && runsForD === 1 && runsForL2 === 0, { tasks: tasks1.map((t) => pick(t, ["id", "title", "contactId", "assignedToId"])), leadTags: tags1.map((t) => t.id), runsForDefinition: runsForD, runsForLeadTwo: runsForL2 });
  }); // workflow

  // ── cancelled (read-only) — real dialog, then the auth/access contract ──────
  await section("cancelled", async () => {
  const notifBefore = totalOf((await A.get("/notifications")).json);
  await withPage({ label: "elite-lifecycle", userId: OWNER_USER_ID, companyId: null, theme: "light" }, async (pp) => {
  try {
    await uiLogin(pp, PLATFORM, OWNER_EMAIL, OWNER_PASSWORD); await pp.waitForURL((u) => u.pathname.startsWith("/platform"));
    const canc = await lifecycleUI(pp, fx.A.cid, "cancel", "cancelled");
    const cancelledAt = canc?.statusChangedAt ?? new Date().toISOString(); // the orphan run is only persisted after this instant
    check("cancelled: canonical status/access = cancelled / read_only / SUBSCRIPTION_CANCELLED", canc?.status === "cancelled" && canc?.accessMode === "read_only" && canc?.reasonCode === "SUBSCRIPTION_CANCELLED" && Array.isArray(canc?.allowedActions) && canc.allowedActions.includes("activate"), subView(canc ?? {}));
    const lc = await tenantLogin(fx.A.adminEmail, PW_A_ADMIN);
    check("cancelled: login allowed (read-only is not a login block) and the existing token keeps working", lc.status === 200 && !!lc.json?.token, { login: lc.status });
    const cur = await A.get("/subscriptions/current");
    check("cancelled: /subscriptions/current explains read-only with the contract message", cur.status === 200 && cur.json?.status === "cancelled" && cur.json?.accessMode === "read_only" && cur.json?.reasonCode === "SUBSCRIPTION_CANCELLED" && /read-only/i.test(cur.json?.accessMessage ?? ""), pick(cur.json ?? {}, ["status", "accessMode", "reasonCode", "accessMessage"]));
    const reads = { leads: (await A.get("/leads")).status, leadById: (await A.get(`/leads/${L1}`)).status, events: (await A.get("/events")).status, tasks: (await A.get("/tasks")).status, usage: (await A.get("/subscriptions/usage")).status, runs: (await A.get("/workflows/runs")).status, branding: (await A.get("/organization/branding")).status };
    check("cancelled: representative CRM reads succeed (200)", Object.values(reads).every((s) => s === 200), reads);
    const writes = { postLead: await A.post("/leads", { title: "B20 SMOKE blocked write" }), patchLead: await A.patch(`/leads/${L1}`, { title: "HACKED" }), postEvent: await A.post("/events", { name: "B20 SMOKE blocked event" }), postTask: await A.post("/tasks", { title: "B20 SMOKE blocked task" }), postTag: await A.post("/tags", { name: "B20 SMOKE blocked tag" }), putBranding: await A.put("/organization/branding", { primaryColor: "#1d4ed8" }), postWorkflow: await A.post("/workflows", { name: "B20 SMOKE blocked wf", trigger: { type: "lead.created" }, actions: [] }), attachTag: await A.post(`/leads/${L1}/tags`, { tagId }) };
    const wStat = Object.fromEntries(Object.entries(writes).map(([k, v]) => [k, v.status]));
    check("cancelled: every representative CRM/config write is refused (403 read-only)", Object.values(writes).every((r) => r.status === 403 && /read-only/i.test(r.json?.error ?? "")), { statuses: wStat, message: writes.postLead.json?.error });
    const evAfter = await evCount(); const leadStill = await A.get(`/leads/${L1}`);
    check("cancelled: nothing was mutated by the refused writes", evAfter === base + 4 && leadStill.json?.title === `B20 SMOKE ${TAG} lead one`, { events: evAfter, leadTitle: leadStill.json?.title });
    await withPage({ label: "tenant-cancelled-ui", userId: fx.A.adminId, companyId: fx.A.cid, theme: "light" }, async (tp) => {
      await uiLogin(tp, TENANT, fx.A.adminEmail, PW_A_ADMIN); await tp.waitForURL((u) => u.pathname.startsWith("/admin"));
      await tp.goto(`${TENANT}/admin/subscription`, { waitUntil: "domcontentloaded" }); await tp.getByTestId("subscription-page").waitFor({ state: "visible" });
      const banner = await tp.getByTestId("access-banner").innerText().catch(() => ""); const badge = await tp.getByTestId("status-badge").innerText().catch(() => ""); const mode = await tp.getByTestId("access-mode").innerText().catch(() => "");
      check("cancelled: tenant Subscription UI shows Cancelled / Read-only with the explanation banner and usage", /cancel/i.test(badge) && mode === "Read-only" && /Read-only/.test(banner) && /read-only/i.test(banner) && (await tp.getByTestId("usage-card").isVisible()) && (await tp.getByTestId("portal-unavailable").isVisible()), { badge, mode, banner: banner.replace(/\s+/g, " ").slice(0, 200) });
      await shot(tp, "tenant-subscription-cancelled");
    });

    // ── blocked run: persisted run, tenant non-writable BEFORE execution ─────
    S = "blocked-run";
    let orphanId = null;
    try {
      const out = sshPhase("orphan-run", String(fx.A.cid), String(D), `${L2},${fx.A.adminId},${TAG}`);
      orphanId = Number((out.match(/^orphan_run_id=(\d+)/m) ?? [])[1]);
      note("orphan-run phase output", out.split("\n").filter((l) => /^(run |action |definition:|tenant access|action_rows=|orphan_run_id=)/.test(l)).join(" | "));
    } catch (e) { check("orphan-run phase executed", false, String(e?.stderr ?? e?.message ?? e).slice(0, 300)); }
    if (Number.isInteger(orphanId)) {
      state.runIds.push(orphanId); saveState();
      const before = await A.get(`/workflows/runs/${orphanId}`);
      check("queued run persisted for the cancelled tenant (status queued, generation 1, actions pending)", before.status === 200 && before.json?.status === "queued" && before.json?.enqueueGeneration === 1 && listOf(before.json?.actions).every((a) => a.status === "pending"), pick(before.json ?? {}, ["id", "status", "enqueueGeneration", "queuedAt", "eventKey"]));
      const tw = Date.now();
      const done = await waitFor(async () => { const r = await A.get(`/workflows/runs/${orphanId}`); return r.json && r.json.status !== "queued" && r.json.status !== "running" ? r.json : null; }, RECOVERY_WAIT_MS, 10000);
      note("waited for the orphan-recovery sweep to re-enqueue and the worker to execute", { waitedMs: Date.now() - tw, status: done?.status ?? "(still queued)" });
      const acts = listOf(done?.actions);
      check("blocked run: documented non-writable failure (run failed, SUBSCRIPTION_NOT_WRITABLE / read_only / SUBSCRIPTION_CANCELLED), re-enqueued by recovery (generation 2)", done?.status === "failed" && done?.error?.code === "SUBSCRIPTION_NOT_WRITABLE" && done?.error?.accessMode === "read_only" && done?.error?.reasonCode === "SUBSCRIPTION_CANCELLED" && done?.enqueueGeneration === 2, { run: pick(done ?? {}, ["id", "status", "enqueueGeneration", "error", "queuedAt", "startedAt", "completedAt"]) });
      check("blocked run: first action failed with SUBSCRIPTION_NOT_WRITABLE, second action never started (no continuation)", acts.length === 2 && acts[0]?.status === "failed" && acts[0]?.error?.code === "SUBSCRIPTION_NOT_WRITABLE" && acts[1]?.status === "pending" && (acts[1]?.attempts ?? 0) === 0, { actions: acts.map((a) => pick(a, ["actionIndex", "actionType", "status", "attempts", "error"])) });
      check("blocked run: executed strictly after the cancellation (startedAt > subscription statusChangedAt)", !!done?.startedAt && !!cancelledAt && new Date(done.startedAt).getTime() > new Date(cancelledAt).getTime(), { cancelledAt, startedAt: done?.startedAt });
      const tasks2 = listOf((await A.get(`/tasks?scope=all&contactId=${C2}`)).json); const lead2 = await A.get(`/leads/${L2}`); const notifAfter = totalOf((await A.get("/notifications")).json);
      check("blocked run: no task, tag, notification or e-mail side effect (SMTP unset; no email action in the definition)", tasks2.length === 0 && listOf(lead2.json?.tags).length === 0 && notifAfter === notifBefore, { tasksForLeadTwoContact: tasks2.length, leadTwoTags: listOf(lead2.json?.tags).length, notifications: { before: notifBefore, after: notifAfter } });
      const r1again = await A.get(`/workflows/runs/${run1?.id}`);
      check("idempotency intact: the earlier completed run is untouched (still completed, attempts 1, generation 1)", r1again.json?.status === "completed" && r1again.json?.enqueueGeneration === 1 && listOf(r1again.json?.actions).every((a) => a.attempts === 1), pick(r1again.json ?? {}, ["id", "status", "enqueueGeneration", "actionSummary"]));
    }

    // ── restore from cancelled through the real dialog ────────────────────────
    S = "cancelled";
    const restored = await lifecycleUI(pp, fx.A.cid, "activate", "active");
    const wOk = await A.post("/tags", { name: `B20 SMOKE ${TAG} restored tag` });
    check("restore (activate) returns full writable access", restored?.accessMode === "full" && wOk.status === 201, { accessMode: restored?.accessMode, write: wOk.status });
    if (Number.isInteger(orphanId)) {
      await sleep(15000);
      const later = await A.get(`/workflows/runs/${orphanId}`); const tasks2b = listOf((await A.get(`/tasks?scope=all&contactId=${C2}`)).json); const lead2b = await A.get(`/leads/${L2}`);
      check("blocked run stays failed after reactivation: no retry, no replay, still no side effects", later.json?.status === "failed" && later.json?.enqueueGeneration === 2 && tasks2b.length === 0 && listOf(lead2b.json?.tags).length === 0, { status: later.json?.status, generation: later.json?.enqueueGeneration, tasks: tasks2b.length, tags: listOf(lead2b.json?.tags).length });
    }

    // ── expired (blocked) — real dialog, then the auth contract ──────────────
    S = "expired";
    const exp = await lifecycleUI(pp, fx.A.cid, "expire", "expired");
    check("expired: canonical status/access = expired / blocked / SUBSCRIPTION_EXPIRED", exp?.status === "expired" && exp?.accessMode === "blocked" && exp?.reasonCode === "SUBSCRIPTION_EXPIRED" && exp?.allowedActions?.includes("activate"), subView(exp ?? {}));
    const le2 = await tenantLogin(fx.A.adminEmail, PW_A_ADMIN); const tok403 = await A.get("/subscriptions/current"); const read403 = await A.get("/leads"); const write403 = await A.post("/tags", { name: "x" }); const empLogin = await tenantLogin(empEmail, PW_A_EMP);
    check("expired: login refused (403, expired message) for admin and employee; existing tokens refused with SUBSCRIPTION_EXPIRED on reads and writes", le2.status === 403 && /expired/i.test(le2.json?.error ?? "") && empLogin.status === 403 && tok403.status === 403 && tok403.json?.code === "SUBSCRIPTION_EXPIRED" && read403.status === 403 && read403.json?.code === "SUBSCRIPTION_EXPIRED" && write403.status === 403, { login: le2.status, loginMessage: le2.json?.error, employeeLogin: empLogin.status, tokenRead: [tok403.status, tok403.json?.code], leads: [read403.status, read403.json?.code], write: write403.status });
    await withPage({ label: "tenant-expired-ui" }, async (tp) => {
      await uiLogin(tp, TENANT, fx.A.adminEmail, PW_A_ADMIN); await tp.waitForTimeout(3000);
      const txt = await bodyText(tp);
      check("expired: tenant UI login stays on /login and explains the expired subscription", pathOf(tp.url()) === "/login" && /expired/i.test(txt), { path: pathOf(tp.url()), excerpt: (txt.match(/.{0,80}expired.{0,80}/i) ?? [txt.slice(0, 160)])[0] });
      await shot(tp, "tenant-login-expired");
    });
    const back = await lifecycleUI(pp, fx.A.cid, "activate", "active");
    const le3 = await tenantLogin(fx.A.adminEmail, PW_A_ADMIN); TA = le3.json?.token ?? TA; Object.assign(A, ten(TA));
    const wOk2 = await A.post("/tags", { name: `B20 SMOKE ${TAG} restored tag 2` });
    check("restore from expired (activate): login works and writes succeed again", back?.accessMode === "full" && le3.status === 200 && wOk2.status === 201, { accessMode: back?.accessMode, login: le3.status, write: wOk2.status });
  } finally {
    // Whatever happened, the disposable tenant must be writable again before the UI sections.
    const fin = await ensureActive(fx.A.cid);
    if (fin?.status === "active") { const rl = await tenantLogin(fx.A.adminEmail, PW_A_ADMIN); if (rl.json?.token) { TA = rl.json.token; Object.assign(A, ten(TA)); } }
  }
  });
  }); // cancelled / blocked-run / expired

  // ── branding (defaults, temporary save, persistence, reset; no logo) ────────
  await section("branding", async () => {
  const br0 = await A.get("/organization/branding");
  note("branding defaults before the test", pick(br0.json ?? {}, ["primaryColor", "sidebarColor", "defaultTheme", "isCustomized", "logoUrl"]));
  await withPage({ label: "branding", userId: fx.A.adminId, companyId: fx.A.cid, theme: "light" }, async (p) => {
    await uiLogin(p, TENANT, fx.A.adminEmail, PW_A_ADMIN); await p.waitForURL((u) => u.pathname.startsWith("/admin"));
    await p.goto(`${TENANT}/admin/organization`, { waitUntil: "domcontentloaded" }); await p.getByTestId("branding-section").waitFor({ state: "visible" });
    check("branding section renders the platform defaults (not customized)", br0.status === 200 && br0.json?.isCustomized === false && (await p.getByTestId("branding-customized").count()) === 0, { isCustomized: br0.json?.isCustomized });
    await shot(p, "branding-defaults");
    const hex = p.getByTestId("branding-primaryColor-hex");
    await hex.fill(""); await hex.fill("#1D4ED8");
    await p.getByTestId("branding-theme-dark").check({ force: true });
    await p.getByTestId("branding-dirty").waitFor({ state: "visible" });
    await p.getByTestId("branding-save").click();
    await waitFor(async () => (await A.get("/organization/branding")).json?.isCustomized === true, 15000);
    const br1 = await A.get("/organization/branding");
    check("temporary colour + theme saved through the UI", br1.json?.isCustomized === true && (br1.json?.primaryColor ?? "").toLowerCase() === "#1d4ed8" && br1.json?.defaultTheme === "dark", pick(br1.json ?? {}, ["primaryColor", "defaultTheme", "isCustomized", "logoUrl"]));
    await p.reload({ waitUntil: "domcontentloaded" }); await p.getByTestId("branding-section").waitFor({ state: "visible" }); await p.waitForTimeout(800);
    const v = (await hex.inputValue().catch(() => "")).toLowerCase(); const darkChecked = await p.getByTestId("branding-theme-dark").isChecked().catch(async () => (await p.getByTestId("branding-theme-dark").getAttribute("aria-checked")) === "true" || (await p.getByTestId("branding-theme-dark").getAttribute("data-state")) === "checked");
    check("branding persists after reload (hex input, dark theme selected, customized marker)", v === "#1d4ed8" && darkChecked && (await p.getByTestId("branding-customized").isVisible()), { hex: v, darkChecked });
    await shot(p, "branding-saved");
    await p.getByTestId("branding-reset").click(); await p.getByTestId("branding-confirm-dialog").waitFor({ state: "visible" }); await p.getByTestId("branding-confirm-reset").click();
    await waitFor(async () => (await A.get("/organization/branding")).json?.isCustomized === false, 15000);
    const br2 = await A.get("/organization/branding");
    check("branding reset restores the defaults; no logo was uploaded or removed (no GCS mutation)", br2.json?.isCustomized === false && br2.json?.logoUrl == null && br0.json?.logoUrl == null, pick(br2.json ?? {}, ["primaryColor", "defaultTheme", "isCustomized", "logoUrl"]));
    await shot(p, "branding-reset");
  });
  }); // branding

  // ── automations UI: list, run history/detail, editor, dirty-editor guard ────
  const R1 = run1?.id, R2 = state.runIds.find((id) => id !== R1) ?? null;
  await section("automations", async () => {
  await withPage({ label: "automations", userId: fx.A.adminId, companyId: fx.A.cid, theme: "light" }, async (p) => {
    await uiLogin(p, TENANT, fx.A.adminEmail, PW_A_ADMIN); await p.waitForURL((u) => u.pathname.startsWith("/admin"));
    await p.goto(`${TENANT}/admin/automations`, { waitUntil: "domcontentloaded" }); await p.getByTestId("automation-list").waitFor({ state: "visible" });
    check("automations list shows the published automation", await p.getByTestId(`automation-row-${D}`).isVisible().catch(() => false), { rowText: (await p.getByTestId(`automation-row-${D}`).innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 120) });
    await shot(p, "automations-list");
    await p.getByTestId("tab-runs").click(); await p.getByTestId("run-history").waitFor({ state: "visible" });
    const rowOk = await p.getByTestId(`run-row-${R1}`).isVisible().catch(() => false); const rowBlocked = R2 ? await p.getByTestId(`run-row-${R2}`).isVisible().catch(() => false) : null;
    check("run history lists the completed run and the blocked run with their outcomes", rowOk && (R2 == null || rowBlocked) && /completed/i.test(await p.getByTestId(`run-row-${R1}`).innerText()) && (R2 == null || /failed/i.test(await p.getByTestId(`run-row-${R2}`).innerText())), { completedRow: rowOk, blockedRow: rowBlocked });
    await shot(p, "automations-run-history");
    await p.goto(`${TENANT}/admin/automations/runs/${R1}`, { waitUntil: "domcontentloaded" }); await p.getByTestId("run-detail").waitFor({ state: "visible" }); await p.waitForTimeout(500);
    const st1 = await p.getByTestId("run-detail-status").innerText().catch(() => ""); const a0 = await p.getByTestId("run-action-0").innerText().catch(() => ""); const a1 = await p.getByTestId("run-action-1").innerText().catch(() => "");
    check("run detail (completed) displays both actions as completed with their outcomes", /completed/i.test(st1) && /completed/i.test(a0) && /completed/i.test(a1) && /task/i.test(a0) && /tag/i.test(a1), { status: st1.replace(/\s+/g, " "), action0: a0.replace(/\s+/g, " ").slice(0, 120), action1: a1.replace(/\s+/g, " ").slice(0, 120) });
    await shot(p, "automations-run-completed");
    if (R2) {
      await p.goto(`${TENANT}/admin/automations/runs/${R2}`, { waitUntil: "domcontentloaded" }); await p.getByTestId("run-detail").waitFor({ state: "visible" }); await p.waitForTimeout(500);
      const st2 = await p.getByTestId("run-detail-status").innerText().catch(() => ""); const err2 = await p.getByTestId("run-error").innerText().catch(() => ""); const b0 = await p.getByTestId("run-action-0").innerText().catch(() => ""); const b1 = await p.getByTestId("run-action-1").innerText().catch(() => "");
      check("run detail (blocked) displays the failed status, SUBSCRIPTION_NOT_WRITABLE and the untouched second action", /failed/i.test(st2) && /SUBSCRIPTION_NOT_WRITABLE/.test(err2 + b0) && /pending/i.test(b1), { status: st2.replace(/\s+/g, " "), error: err2.replace(/\s+/g, " ").slice(0, 160), action1: b1.replace(/\s+/g, " ").slice(0, 100) });
      await shot(p, "automations-run-blocked");
    }
    await p.goto(`${TENANT}/admin/automations/${D}`, { waitUntil: "domcontentloaded" }); await p.getByTestId("automation-editor").waitFor({ state: "visible" });
    const nameBefore = await p.getByTestId("automation-name").inputValue();
    await p.getByTestId("automation-name").fill(`${nameBefore} EDITED`); await p.getByTestId("unsaved-indicator").waitFor({ state: "visible" });
    await p.getByTestId("button-back").click(); await p.getByTestId("unsaved-dialog").waitFor({ state: "visible" });
    await shot(p, "automations-unsaved-dialog");
    await p.getByTestId("unsaved-stay").click(); await p.waitForTimeout(600);
    const stayed = (await p.getByTestId("automation-editor").isVisible().catch(() => false)) && pathOf(p.url()) === `/admin/automations/${D}` && (await p.getByTestId("automation-name").inputValue()) === `${nameBefore} EDITED`;
    await p.getByTestId("button-back").click(); await p.getByTestId("unsaved-dialog").waitFor({ state: "visible" }); await p.getByTestId("unsaved-discard").click();
    await p.waitForURL((u) => u.pathname === "/admin/automations", { timeout: 10000 }).catch(() => {});
    const defAfter = await A.get(`/workflows/${D}`);
    check("dirty editor Back → Stay keeps the edit on the editor; Back → Discard leaves without saving (definition unchanged)", stayed && pathOf(p.url()) === "/admin/automations" && defAfter.json?.name === nameBefore, { stayed, finalPath: pathOf(p.url()), nameAfter: defAfter.json?.name });
  });
  }); // automations

  // ── responsive + theme QA (desktop / ~390px mobile × light / dark) ──────────
  await section("responsive", async () => {
  for (const mobile of [false, true]) for (const theme of ["light", "dark"]) {
    const lab = `${mobile ? "mobile" : "desktop"}-${theme}`;
    await withPage({ label: `qa-tenant-${lab}`, userId: fx.A.adminId, companyId: fx.A.cid, theme, mobile }, async (p) => {
      await uiLogin(p, TENANT, fx.A.adminEmail, PW_A_ADMIN); await p.waitForURL((u) => u.pathname.startsWith("/admin"));
      await qaPage(p, `tenant subscription ${lab}`, `${TENANT}/admin/subscription`, "subscription-page", ["status-badge", "access-mode", "plan-name", "usage-card"], { theme });
      await qaPage(p, `tenant branding ${lab}`, `${TENANT}/admin/organization`, "branding-section", ["branding-primaryColor-hex", "branding-theme", "branding-save", "branding-reset"], { theme });
      await qaPage(p, `tenant automations ${lab}`, `${TENANT}/admin/automations`, "automation-list", ["button-new-automation", "tab-runs", `automation-row-${D}`], { theme });
      await qaPage(p, `tenant automation editor ${lab}`, `${TENANT}/admin/automations/${D}`, "automation-editor", ["automation-name", "button-save", "button-back"], { theme });
      await qaPage(p, `tenant run detail ${lab}`, `${TENANT}/admin/automations/runs/${R1}`, "run-detail", ["run-detail-status", "run-action-0", "run-action-1"], { theme });
    });
    await withPage({ label: `qa-platform-${lab}`, userId: OWNER_USER_ID, companyId: null, theme, mobile }, async (p) => {
      await uiLogin(p, PLATFORM, OWNER_EMAIL, OWNER_PASSWORD); await p.waitForURL((u) => u.pathname.startsWith("/platform"));
      await qaPage(p, `platform subscriptions ${lab}`, `${PLATFORM}/platform/subscriptions`, "platform-subscriptions", ["sub-search", "sub-total", `sub-manage-${fx.A.cid}`], { theme });
      await p.getByTestId(`sub-manage-${fx.A.cid}`).click(); await p.getByTestId("sub-detail").waitFor({ state: "visible" }); await p.waitForTimeout(500);
      const vp = p.viewportSize(); const box = await p.getByTestId("sub-detail").boundingBox();
      const actionsVisible = await p.getByTestId("detail-actions").isVisible().catch(() => false);
      const readable = !!box && box.x >= -1 && box.x + box.width <= vp.width + 1 && box.width >= Math.min(300, vp.width * 0.8) && actionsVisible;
      check(`platform subscription detail dialog ${lab}: fits the viewport and its controls are readable`, readable, { viewport: vp, dialog: box ? { x: Math.round(box.x), w: Math.round(box.width), h: Math.round(box.height) } : null, actionsVisible });
      await shot(p, `platform-sub-detail-${lab}`);
    });
  }
  }); // responsive

  // ── console / page errors ───────────────────────────────────────────────────
  S = "console";
  const expectedNet = /Failed to load resource: the server responded with a status of (401|403|404|409|503)/;
  const unexpected = consoleLog.filter((c) => !expectedNet.test(c.text));
  const expectedNetwork = consoleLog.filter((c) => expectedNet.test(c.text));
  check("no uncaught page errors in any browser context", pageErrors.length === 0, pageErrors.slice(0, 5));
  check("no unexpected console errors (expected 4xx/5xx resource logs from negative-state pages are listed separately)", unexpected.length === 0, unexpected.slice(0, 8));
  note("expected network error console lines (by context)", Object.entries(expectedNetwork.reduce((m, c) => { m[c.ctx] = (m[c.ctx] ?? 0) + 1; return m; }, {})));

  // ── preservation ────────────────────────────────────────────────────────────
  S = "preservation";
  const ex1 = await platformSub(EXISTING); const exEv1 = totalOf((await own("GET", `/platform/subscriptions/${EXISTING}/events`)).json);
  check("existing customer unchanged after the smoke (active / free / manual / full, same overrides, same provider-event count)", ex1.status === 200 && ["plan", "status", "billingSource", "accessMode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "statusChangedAt"].every((k) => ex1.json?.[k] === ex0.json?.[k]) && JSON.stringify(ex1.json?.limitOverrides ?? {}) === "{}" && exEv1 === exEv0, { before: subView(ex0.json), after: subView(ex1.json), providerEvents: [exEv0, exEv1] });
  const fa = await platformSub(fx.A.cid), fb = await platformSub(fx.B.cid);
  check("both disposable tenants end active / full (restored through the platform lifecycle)", fa.json?.status === "active" && fa.json?.accessMode === "full" && fb.json?.status === "active" && fb.json?.accessMode === "full", { a: subView(fa.json), b: subView(fb.json) });
  note("elapsed", { ms: Date.now() - t0 });
}

async function finish(exitCode) {
  saveState();
  const sections = {};
  for (const r of results) { const s = (sections[r.section] ??= { passed: 0, failed: 0, notes: 0 }); if (r.ok === true) s.passed++; else if (r.ok === false) s.failed++; else s.notes++; }
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify({ tag: TAG, fixtures: { A: fx.A, B: fx.B, ownerUserId: OWNER_USER_ID }, state, failures, sections, results, consoleErrors: consoleLog, pageErrors }, null, 2));
  console.log(`\nSUPPLEMENTAL SUMMARY: ${results.filter((r) => r.ok === true).length} passed, ${failures} failed, ${results.filter((r) => r.ok === null).length} notes; sections=${JSON.stringify(sections)}; state=${JSON.stringify(state)}`);
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
