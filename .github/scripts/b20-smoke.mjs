// =============================================================================
// TEMPORARY — B19/B20 hosted smoke (runs on the GitHub runner, real Chromium).
// Targets the deployed dev stack over the public hosts only:
//   PLATFORM_HOST  https://elite.kaptnow.com  (Platform Owner portal)
//   TENANT_HOST    https://admin.kaptnow.com  (tenant portal)
// Uses ONE disposable platform-owner login (inserted by the `smoke-setup` phase)
// and creates ONE disposable tenant ("B20 SMOKE <tag>") with ONE disposable
// primary admin through the real API. Every created id is written to STATE_FILE
// immediately so the always-run `cleanup` phase removes exactly those rows.
// The existing customer (company 1) is only READ, never mutated.
// Never prints passwords, tokens, hashes, or names/e-mails of existing users.
// No Stripe, e-mail, Gemini, GCS, OCR or APK activity: billing stays disabled and
// the smoke asserts that checkout/portal are UNAVAILABLE.
// =============================================================================
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const env = (k, d) => {
  const v = process.env[k];
  if (v == null || v === "") {
    if (d !== undefined) return d;
    throw new Error(`missing env ${k}`);
  }
  return v;
};
const PLATFORM = env("PLATFORM_HOST", "https://elite.kaptnow.com");
const TENANT = env("TENANT_HOST", "https://admin.kaptnow.com");
const OWNER_EMAIL = env("OWNER_EMAIL");
const OWNER_PASSWORD = env("OWNER_PASSWORD");
const OWNER_USER_ID = Number(env("OWNER_USER_ID"));
const ADMIN_PASSWORD = env("ADMIN_PASSWORD");
const TAG = env("TAG");
const DOMAIN = env("SMOKE_DOMAIN", "b20smoke.invalid");
const OUT_DIR = env("OUT_DIR");
const STATE_FILE = env("STATE_FILE");
const EXISTING_COMPANY_ID = Number(env("EXISTING_COMPANY_ID", "1"));
fs.mkdirSync(OUT_DIR, { recursive: true });

const state = { companyIds: [], userIds: [OWNER_USER_ID] };
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));
saveState();

const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail ?? null });
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail != null ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}
function note(name, detail) {
  results.push({ name, ok: null, detail });
  console.log(`NOTE ${name} — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

async function api(host, method, p, body, token) {
  const res = await fetch(`${host}/api${p}`, {
    method,
    headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text: json ? null : text.slice(0, 160) };
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));
const subView = (s) => pick(s ?? {}, ["companyId", "plan", "status", "billingSource", "accessMode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked", "cancelAtPeriodEnd", "reasonCode", "allowedActions", "statusBeforeSuspension", "suspendedReason"]);
async function waitFor(fn, timeoutMs = 20000, every = 500) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, every));
  }
  return last;
}
async function shot(page, name) {
  const file = path.join(OUT_DIR, `${String(results.length).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch((e) => note(`screenshot ${name}`, `failed: ${e.message}`));
}
async function uiLogin(page, host, email, password) {
  await page.goto(`${host}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('form button[type="submit"]').first().click();
}

const platformSub = async (token, id) => (await api(PLATFORM, "GET", `/platform/subscriptions/${id}`, undefined, token));
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return String(u); } };

async function main() {
  // ── 1. Platform Owner API (disposable owner) ────────────────────────────────
  const ownerLogin = await api(PLATFORM, "POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  check("owner api login (elite host)", ownerLogin.status === 200 && ownerLogin.json?.token && !ownerLogin.json?.mfaRequired, { status: ownerLogin.status, role: ownerLogin.json?.user?.role, userId: ownerLogin.json?.user?.id });
  if (!ownerLogin.json?.token) throw new Error("owner login failed; aborting before any creation");
  const OT = ownerLogin.json.token;
  check("owner is the disposable platform_owner row", ownerLogin.json.user?.id === OWNER_USER_ID && ownerLogin.json.user?.role === "platform_owner", { id: ownerLogin.json.user?.id });

  const billing = await api(PLATFORM, "GET", "/platform/billing/status", undefined, OT);
  check("billing provider unavailable on the hosted stack", billing.status === 200 && billing.json?.available === false, pick(billing.json ?? {}, ["provider", "available", "unavailableReason", "mode", "returnUrlConfigured", "selfServiceCheckout"]));
  const prices = await api(PLATFORM, "GET", "/platform/billing/prices", undefined, OT);
  const priceCount = Array.isArray(prices.json) ? prices.json.length : Array.isArray(prices.json?.prices) ? prices.json.prices.length : null;
  check("no provider prices registered", prices.status === 200 && priceCount === 0, { status: prices.status, prices: priceCount });

  const list0 = await api(PLATFORM, "GET", "/platform/subscriptions?limit=100", undefined, OT);
  const existing0 = list0.json?.subscriptions?.find((s) => s.companyId === EXISTING_COMPANY_ID);
  check("existing customer listed active/free/manual/full (before)", list0.status === 200 && existing0 && existing0.status === "active" && existing0.plan === "free" && existing0.billingSource === "manual" && existing0.accessMode === "full", { total: list0.json?.total, existing: subView(existing0) });
  const det0 = await platformSub(OT, EXISTING_COMPANY_ID);
  check("existing customer detail active (before)", det0.status === 200 && det0.json?.status === "active", subView(det0.json));
  const ev0 = await api(PLATFORM, "GET", `/platform/subscriptions/${EXISTING_COMPANY_ID}/events`, undefined, OT);
  const evCount0 = Array.isArray(ev0.json) ? ev0.json.length : Array.isArray(ev0.json?.events) ? ev0.json.events.length : null;
  note("existing customer subscription events (before)", { status: ev0.status, count: evCount0 });
  const metrics = await api(PLATFORM, "GET", "/platform/subscriptions/metrics", undefined, OT);
  check("platform subscription metrics readable", metrics.status === 200, metrics.json);

  const fw = await api(PLATFORM, "GET", "/contacts", undefined, OT);
  check("platform-owner firewall: /contacts is 403 for the owner", fw.status === 403, { status: fw.status });

  // ── 2. Disposable tenant + admin through the real API ───────────────────────
  const companyName = `B20 SMOKE ${TAG}`;
  const created = await api(PLATFORM, "POST", "/companies", { name: companyName, plan: "free", industry: "smoke-test", country: "ZZ" }, OT);
  const cid = created.json?.id;
  if (Number.isInteger(cid)) { state.companyIds.push(cid); saveState(); }
  check("disposable company created via API (canonical subscription in the same transaction)", created.status === 201 && Number.isInteger(cid), { status: created.status, companyId: cid, subscription: subView(created.json?.subscription), status_mirror: created.json?.status, plan_mirror: created.json?.plan });
  if (!Number.isInteger(cid)) throw new Error("company creation failed");

  const adminEmail = `b20-smoke-${TAG}-admin@${DOMAIN}`;
  const admin = await api(PLATFORM, "POST", "/users", { email: adminEmail, name: "B20 SMOKE admin (disposable)", role: "primary_admin", companyId: cid, password: ADMIN_PASSWORD }, OT);
  const aid = admin.json?.id;
  if (Number.isInteger(aid)) { state.userIds.push(aid); saveState(); }
  check("disposable tenant primary_admin created via API", admin.status === 201 && Number.isInteger(aid), { status: admin.status, userId: aid, role: admin.json?.role, companyId: admin.json?.companyId });
  if (!Number.isInteger(aid)) throw new Error("tenant admin creation failed");

  const d1 = await platformSub(OT, cid);
  check("new tenant starts trialing / manual / full", d1.status === 200 && d1.json?.status === "trialing" && d1.json?.billingSource === "manual" && d1.json?.accessMode === "full" && Array.isArray(d1.json?.allowedActions) && d1.json.allowedActions.includes("activate"), subView(d1.json));

  // ── 3. Tenant API (disposable admin) ────────────────────────────────────────
  const tLogin = await api(TENANT, "POST", "/auth/login", { email: adminEmail, password: ADMIN_PASSWORD });
  check("tenant admin api login (admin host)", tLogin.status === 200 && tLogin.json?.token && !tLogin.json?.mfaRequired, { status: tLogin.status, companyId: tLogin.json?.user?.companyId, role: tLogin.json?.user?.role });
  let TT = tLogin.json?.token;
  if (!TT) throw new Error("tenant login failed");
  const cur1 = await api(TENANT, "GET", "/subscriptions/current", undefined, TT);
  check("tenant /subscriptions/current: trialing, full, managed by platform", cur1.status === 200 && cur1.json?.status === "trialing" && cur1.json?.accessMode === "full" && cur1.json?.billing?.managedByPlatform === true, { ...subView(cur1.json), billing: cur1.json?.billing });
  const usage = await api(TENANT, "GET", "/subscriptions/usage", undefined, TT);
  check("tenant /subscriptions/usage readable", usage.status === 200, usage.json);
  const plans = await api(TENANT, "GET", "/subscriptions/plans", undefined, TT);
  const planList = Array.isArray(plans.json) ? plans.json : Array.isArray(plans.json?.plans) ? plans.json.plans : [];
  check("tenant /subscriptions/plans lists the 5 seeded plans", plans.status === 200 && planList.length === 5, { ids: planList.map((p) => p.id ?? p.plan ?? p.name) });
  const co = await api(TENANT, "POST", "/subscriptions/checkout", { planPriceId: 1 }, TT);
  check("tenant checkout refused: provider unavailable (503 PROVIDER_UNAVAILABLE)", co.status === 503 && co.json?.code === "PROVIDER_UNAVAILABLE", { status: co.status, code: co.json?.code });
  const po = await api(TENANT, "POST", "/subscriptions/portal", undefined, TT);
  check("tenant portal refused: provider unavailable (503 PROVIDER_UNAVAILABLE)", po.status === 503 && po.json?.code === "PROVIDER_UNAVAILABLE", { status: po.status, code: po.json?.code });
  const tfw = await api(TENANT, "GET", "/platform/subscriptions", undefined, TT);
  check("tenant admin cannot read platform subscriptions (403)", tfw.status === 403, { status: tfw.status });

  // ── 4. Browser: Platform Owner portal on elite (real login form) ────────────
  const browser = await chromium.launch();
  const pctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, ignoreHTTPSErrors: false });
  const pp = await pctx.newPage();
  pp.setDefaultTimeout(20000);
  try {
    await uiLogin(pp, PLATFORM, OWNER_EMAIL, OWNER_PASSWORD);
    await pp.waitForURL((u) => u.pathname.startsWith("/platform"), { timeout: 20000 });
    const dash = pp.getByTestId("platform-dashboard");
    await dash.waitFor({ state: "visible" });
    const mrr = await pp.getByTestId("dashboard-mrr").innerText().catch(() => "(missing)");
    const trend = await pp.getByTestId("dashboard-revenue-trend").innerText().catch(() => "(missing)");
    check("elite UI: owner login lands on the platform dashboard", pathOf(pp.url()).startsWith("/platform"), { path: pathOf(pp.url()), mrr: mrr.replace(/\s+/g, " ").slice(0, 80), revenueTrend: trend.replace(/\s+/g, " ").slice(0, 120) });
    await shot(pp, "elite-dashboard");

    await pp.goto(`${PLATFORM}/platform/subscriptions`, { waitUntil: "domcontentloaded" });
    await pp.getByTestId("platform-subscriptions").waitFor({ state: "visible" });
    await pp.getByTestId(`sub-row-${cid}`).waitFor({ state: "visible" });
    // The existing customer's row is only checked for presence and status words — its name is never printed.
    const rowExisting = await pp.getByTestId(`sub-row-${EXISTING_COMPANY_ID}`).innerText().catch(() => "");
    const rowNew = await pp.getByTestId(`sub-row-${cid}`).innerText();
    const total = await pp.getByTestId("sub-total").innerText().catch(() => "(missing)");
    const providerCard = await pp.getByTestId("provider-card").innerText().catch(() => "(missing)");
    check("elite UI: subscriptions list shows the existing customer (active) and the smoke tenant (trialing)", rowExisting !== "" && /active/i.test(rowExisting) && /trial/i.test(rowNew), { total: total.replace(/\s+/g, " "), existingRowVisible: rowExisting !== "", existingRowSaysActive: /active/i.test(rowExisting), newRow: rowNew.replace(/\s+/g, " ").slice(0, 120), providerCard: providerCard.replace(/\s+/g, " ").slice(0, 160) });
    await shot(pp, "elite-subscriptions");

    // lifecycle through the real dialogs: activate → suspend → reactivate
    async function lifecycle(verb, expectStatus, fillReason) {
      await pp.goto(`${PLATFORM}/platform/subscriptions`, { waitUntil: "domcontentloaded" });
      await pp.getByTestId(`sub-manage-${cid}`).click();
      await pp.getByTestId("sub-detail").waitFor({ state: "visible" });
      await pp.getByTestId(`action-${verb}`).click();
      await pp.getByTestId("lifecycle-dialog").waitFor({ state: "visible" });
      if (fillReason) await pp.getByTestId("suspend-reason").fill(fillReason);
      await shot(pp, `elite-dialog-${verb}`);
      await pp.getByTestId("lifecycle-confirm").click();
      const after = await waitFor(async () => { const r = await platformSub(OT, cid); return r.json?.status === expectStatus ? r.json : null; }, 20000);
      check(`elite UI: ${verb} via lifecycle dialog → ${expectStatus}`, after?.status === expectStatus, subView(after ?? {}));
      await pp.waitForTimeout(800);
      await shot(pp, `elite-after-${verb}`);
      return after;
    }
    await lifecycle("activate", "active");
    const cur2 = await api(TENANT, "GET", "/subscriptions/current", undefined, TT);
    check("tenant sees active / full after manual activation", cur2.status === 200 && cur2.json?.status === "active" && cur2.json?.accessMode === "full", subView(cur2.json));

    // ── 5. Browser: tenant portal on admin (real login form) ──────────────────
    const tctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const tp = await tctx.newPage();
    tp.setDefaultTimeout(20000);
    await uiLogin(tp, TENANT, adminEmail, ADMIN_PASSWORD);
    await tp.waitForURL((u) => u.pathname.startsWith("/admin"), { timeout: 20000 });
    check("admin UI: tenant admin login lands on the tenant portal", pathOf(tp.url()).startsWith("/admin"), { path: pathOf(tp.url()) });
    await tp.goto(`${TENANT}/admin/subscription`, { waitUntil: "domcontentloaded" });
    await tp.getByTestId("subscription-page").waitFor({ state: "visible" });
    const badge = await tp.getByTestId("status-badge").innerText();
    const mode = await tp.getByTestId("access-mode").innerText();
    const planName = await tp.getByTestId("plan-name").innerText();
    const usageVisible = await tp.getByTestId("usage-card").isVisible();
    const portalUnavailable = await tp.getByTestId("portal-unavailable").isVisible().catch(() => false);
    const checkoutCards = await tp.getByTestId("checkout-card").count();
    const upgradeButtons = await tp.getByRole("button", { name: /upgrade/i }).count();
    const billingCard = await tp.getByTestId("billing-card").innerText().catch(() => "(missing)");
    check("admin UI: subscription page shows active / full access / free, usage, portal unavailable, no checkout", /active/i.test(badge) && mode === "Full access" && /free/i.test(planName) && usageVisible && portalUnavailable && checkoutCards === 0 && upgradeButtons === 0, { badge, mode, planName, usageVisible, portalUnavailable, checkoutCards, upgradeButtons, billingCard: billingCard.replace(/\s+/g, " ").slice(0, 160) });
    await shot(tp, "admin-subscription-active");

    // ── 6. Suspend: tenant blocked everywhere ─────────────────────────────────
    await lifecycle("suspend", "suspended", "B20 hosted smoke (disposable tenant)");
    const blockedCur = await api(TENANT, "GET", "/subscriptions/current", undefined, TT);
    check("suspended tenant: existing token is refused (403 SUBSCRIPTION_SUSPENDED)", blockedCur.status === 403 && blockedCur.json?.code === "SUBSCRIPTION_SUSPENDED", { status: blockedCur.status, code: blockedCur.json?.code });
    const blockedLogin = await api(TENANT, "POST", "/auth/login", { email: adminEmail, password: ADMIN_PASSWORD });
    check("suspended tenant: login is refused (403)", blockedLogin.status === 403, { status: blockedLogin.status, hasToken: !!blockedLogin.json?.token });
    await tp.goto(`${TENANT}/admin/subscription`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await tp.waitForTimeout(2500);
    note("admin UI while suspended (existing browser session)", { path: pathOf(tp.url()), subscriptionPageVisible: await tp.getByTestId("subscription-page").isVisible().catch(() => false), bodyExcerpt: (await tp.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200) });
    await shot(tp, "admin-while-suspended");
    const tctx2 = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const tp2 = await tctx2.newPage();
    tp2.setDefaultTimeout(20000);
    await uiLogin(tp2, TENANT, adminEmail, ADMIN_PASSWORD);
    await tp2.waitForTimeout(3000);
    const loginBody = (await tp2.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    check("admin UI: suspended tenant cannot sign in (stays on the login page)", pathOf(tp2.url()) === "/login", { path: pathOf(tp2.url()), bodyExcerpt: loginBody.slice(0, 200) });
    await shot(tp2, "admin-login-while-suspended");
    await tctx2.close();

    // ── 7. Reactivate: restored to the pre-suspension state ───────────────────
    const restored = await lifecycle("reactivate", "active");
    check("reactivate restores the pre-suspension status (active)", restored?.status === "active" && restored?.accessMode === "full", subView(restored ?? {}));
    const tLogin2 = await api(TENANT, "POST", "/auth/login", { email: adminEmail, password: ADMIN_PASSWORD });
    check("tenant login works again after reactivation", tLogin2.status === 200 && !!tLogin2.json?.token, { status: tLogin2.status });
    TT = tLogin2.json?.token ?? TT;
    const cur3 = await api(TENANT, "GET", "/subscriptions/current", undefined, TT);
    check("tenant sees active / full after reactivation", cur3.status === 200 && cur3.json?.status === "active" && cur3.json?.accessMode === "full", subView(cur3.json));
    await tp.goto(`${TENANT}/admin/subscription`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await tp.waitForTimeout(1500);
    await shot(tp, "admin-after-reactivate");
    await tctx.close();

    // ── 8. Portal-host rule (record only) ─────────────────────────────────────
    await pp.goto(`${PLATFORM}/admin`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await pp.waitForTimeout(1500);
    note("elite host: /admin never renders the tenant portal", { finalUrl: pp.url(), adminShellVisible: await pp.getByTestId("subscription-page").isVisible().catch(() => false) });
    const tctx3 = await browser.newContext();
    const tp3 = await tctx3.newPage();
    await tp3.goto(`${TENANT}/platform`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await tp3.waitForTimeout(1500);
    note("admin host: /platform never renders the platform portal", { finalUrl: tp3.url(), platformDashboardVisible: await tp3.getByTestId("platform-dashboard").isVisible().catch(() => false) });
    await shot(tp3, "admin-host-platform-path");
    await tctx3.close();
  } finally {
    await browser.close().catch(() => {});
  }

  // ── 9. Existing customer unchanged; audit trail of the smoke tenant ─────────
  const det1 = await platformSub(OT, EXISTING_COMPANY_ID);
  const same = det1.status === 200 && ["plan", "status", "billingSource", "accessMode", "trialExpiresAt", "currentPeriodEndsAt", "providerLinked"].every((k) => det1.json?.[k] === det0.json?.[k]);
  check("existing customer unchanged after the smoke (active / free / manual / full)", same, { before: subView(det0.json), after: subView(det1.json) });
  const ev1 = await api(PLATFORM, "GET", `/platform/subscriptions/${EXISTING_COMPANY_ID}/events`, undefined, OT);
  const evCount1 = Array.isArray(ev1.json) ? ev1.json.length : Array.isArray(ev1.json?.events) ? ev1.json.events.length : null;
  check("existing customer subscription events count unchanged", evCount0 === evCount1, { before: evCount0, after: evCount1 });
  const evNew = await api(PLATFORM, "GET", `/platform/subscriptions/${cid}/events`, undefined, OT);
  const evList = Array.isArray(evNew.json) ? evNew.json : Array.isArray(evNew.json?.events) ? evNew.json.events : [];
  note("smoke tenant subscription events (audit)", { status: evNew.status, count: evList.length, actions: evList.map((e) => e.action ?? e.type ?? e.eventType).slice(0, 12) });

  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify({ tag: TAG, companyId: cid, ownerUserId: OWNER_USER_ID, adminUserId: aid, failures, results }, null, 2));
  console.log(`\nSMOKE SUMMARY: ${results.filter((r) => r.ok === true).length} passed, ${failures} failed, ${results.filter((r) => r.ok === null).length} notes; state=${JSON.stringify(state)}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  saveState();
  console.error(`SMOKE ERROR: ${e?.message ?? e}`);
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify({ tag: TAG, error: String(e?.message ?? e), failures: failures + 1, results }, null, 2));
  process.exit(1);
});
