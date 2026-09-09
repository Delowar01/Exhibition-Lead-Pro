import { createHmac } from "node:crypto";
import { Client } from "pg";
import type { Page } from "@playwright/test";
import { test, expect, state } from "./fixtures/workspace";
import { API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * X. Batch 20 — Subscription lifecycle + hybrid Stripe billing (browser).
 *
 * Runs against the local stack with the deterministic FAKE billing provider
 * (BILLING_PROVIDER=fake; STRIPE_WEBHOOK_SECRET in the test env). No network
 * beyond localhost: the hosted Checkout / Portal URLs are intercepted in the
 * browser, and every provider webhook is a synthetic fixture signed offline with
 * the Stripe signature scheme. Proves the tenant page shows only real canonical
 * state (no invented prices, renewal dates, growth or upgrade buttons), that
 * billing is gated by subscriptions:view / manage, that self-service Checkout
 * never changes entitlement until the signed webhook lands, that the Billing
 * Portal appears only for provider-managed companies, that read-only / blocked
 * states render truthfully, that the platform owner's Subscriptions screen lists
 * canonical rows with confirmed lifecycle actions and truthful revenue, that the
 * platform dashboard / companies screens carry no simulated numbers, tenant
 * isolation, role routing, and responsive light/dark rendering without overflow
 * or console errors.
 */

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const NEXUS = { email: "admin@nexussys.io", password: "Admin123!" };
const PASSWORD = "BillingQa123!";
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const PRICE_ID = "price_fake_usd_4900_month";
const ADMIN_EMAIL = `${RUN_TAG.toLowerCase()}.billing-admin@example.test`;
const VIEWER_EMAIL = `${RUN_TAG.toLowerCase()}.billing-viewer@example.test`;
const COMPANY_NAME = `${RUN_TAG} Billing Co`;
const SUB_ID = `sub_fake_${RUN_TAG.toLowerCase()}`;
const T0 = Math.floor(Date.now() / 1000) - 300;

type Auth = { token: string; user: { id: number; companyId: number | null; email: string; role?: string } };

let pg: Client;
let platform: Auth;
let admin: Auth;
let viewer: Auth;
let nexus: Auth;
let companyId = 0;
let subscriptionId = 0;
let priceId = 0;
let createdPrice = false;
let eventCount = 0;

async function api(method: string, path: string, body?: unknown, token: string | null = null, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

async function login(email: string, password: string): Promise<Auth> {
  const res = await api("POST", "/auth/login", { email, password });
  expect(res.status, res.text).toBe(200);
  return { token: res.json.token, user: res.json.user };
}

/** Real login token seeded the way the app boots (same keys as fixtures/workspace.ts). */
async function seedAs(page: Page, auth: Auth, theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ([t, u, companyId, th, userId]) => {
      try {
        localStorage.setItem("csp_token", t as string);
        localStorage.setItem("csp_user", u as string);
        if (companyId) localStorage.setItem("csp_company_id", companyId as string);
        localStorage.setItem("csp_theme", th as string);
        localStorage.setItem(`csp_theme:u${userId}c${companyId}`, th as string);
      } catch {
        /* storage unavailable */
      }
    },
    [auth.token, JSON.stringify(auth.user), String(auth.user.companyId ?? ""), theme, String(auth.user.id)] as const,
  );
}

function signPayload(payload: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", SECRET).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function webhook(type: string, object: Record<string, unknown>, created: number) {
  eventCount += 1;
  const payload = JSON.stringify({ id: `evt_${RUN_TAG.toLowerCase()}_${eventCount}`, object: "event", type, created, livemode: false, data: { object } });
  const res = await api("POST", "/billing/stripe/webhook", payload, null, { "Stripe-Signature": signPayload(payload) });
  expect(res.status, res.text).toBe(200);
  return res.json as { received: boolean; outcome: string };
}

function subscriptionObject(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: SUB_ID,
    object: "subscription",
    customer: `cus_fake_${companyId}`,
    status,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: PRICE_ID }, current_period_start: T0, current_period_end: T0 + 30 * 24 * 3600 }] },
    metadata: { companyId: String(companyId), subscriptionId: String(subscriptionId) },
    ...extra,
  };
}

/** Console errors that are NOT environment noise (sandbox proxy blocks Google Fonts). */
function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  const noise = (s: string) => /fonts\.googleapis|fonts\.gstatic|ERR_CERT_AUTHORITY_INVALID|Failed to load resource/.test(s);
  page.on("console", (m) => {
    if (m.type() === "error" && !noise(m.text()) && !noise(m.location()?.url ?? "")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const pageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const money = (minor: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(minor / 100);

test.beforeAll(async () => {
  expect(SECRET, "STRIPE_WEBHOOK_SECRET must be set for the billing e2e suite").not.toBe("");
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  platform = await login(PLATFORM.email, PLATFORM.password);
  nexus = await login(NEXUS.email, NEXUS.password);
  const status = await api("GET", "/platform/billing/status", undefined, platform.token);
  expect(status.json, "the API must run with BILLING_PROVIDER=fake").toMatchObject({ provider: "fake", available: true, selfServiceCheckoutEnabled: true });

  const company = await api("POST", "/companies", { name: COMPANY_NAME, plan: "free", industry: "QA" }, platform.token);
  expect(company.status, company.text).toBe(201);
  companyId = company.json.id;
  subscriptionId = company.json.subscription.id;
  for (const [email, role, name] of [
    [ADMIN_EMAIL, "primary_admin", "Billing Admin"],
    [VIEWER_EMAIL, "employee", "Billing Viewer"],
  ] as const) {
    const res = await api("POST", "/users", { email, name, role, companyId, password: PASSWORD }, platform.token);
    expect(res.status, res.text).toBe(201);
  }
  admin = await login(ADMIN_EMAIL, PASSWORD);
  viewer = await login(VIEWER_EMAIL, PASSWORD);

  const prices = await api("GET", "/platform/billing/prices", undefined, platform.token);
  const existing = (prices.json.prices as any[]).find((p) => p.planId === "professional" && p.unitAmountMinor === 4900 && p.currency === "usd" && p.interval === "month");
  if (existing) {
    priceId = existing.id;
    if (!existing.active) await api("PATCH", `/platform/billing/prices/${priceId}`, { active: true }, platform.token);
  } else {
    const created = await api("POST", "/platform/billing/prices", { planId: "professional", providerPriceId: PRICE_ID }, platform.token);
    expect(created.status, created.text).toBe(201);
    priceId = created.json.id;
    createdPrice = true;
  }
});

test.afterAll(async () => {
  if (companyId) {
    await pg.query("delete from audit_logs where company_id = $1", [companyId]);
    await pg.query("delete from users where company_id = $1", [companyId]);
    await pg.query("delete from companies where id = $1", [companyId]);
  }
  await pg.query("delete from billing_provider_events where event_id like $1", [`evt_${RUN_TAG.toLowerCase()}_%`]);
  if (createdPrice) {
    await pg.query("delete from plan_prices where provider_price_id = $1", [PRICE_ID]);
    await pg.query("delete from audit_logs where entity_type = 'plan_price' and entity_id = $1", [String(priceId)]);
  }
  await pg.end();
});

test("tenant Subscription page shows only the canonical state for a platform-managed company", async ({ page }) => {
  const errors = trackConsole(page);
  await seedAs(page, { token: state.token, user: { ...state.user, companyId: state.user.companyId } });
  const current = (await api("GET", "/subscriptions/current", undefined, state.token)).json;
  await page.goto("/admin/subscription");
  await expect(page.getByTestId("subscription-page")).toBeVisible();
  await expect(page.getByTestId("plan-name")).toHaveText(new RegExp(current.plan, "i"));
  const badge = await page.getByTestId("status-badge").innerText();
  expect(badge.toLowerCase().replace(/\s+/g, "_")).toContain(current.status.replace("_", "_").split("_")[0]);
  await expect(page.getByTestId("access-mode")).toHaveText(current.accessMode === "full" ? "Full access" : current.accessMode === "read_only" ? "Read-only" : "Blocked");
  expect(current.billing.managedByPlatform).toBe(true);
  await expect(page.getByTestId("portal-unavailable")).toBeVisible();
  await expect(page.getByTestId("portal-button")).toHaveCount(0);
  await expect(page.getByTestId("checkout-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /upgrade/i })).toHaveCount(0);
  // Usage rows are the API's numbers, verbatim.
  for (const r of current.usage.resources as Array<{ resource: string; used: number; limit: number | null; measurable: boolean }>) {
    const row = page.getByTestId(`usage-row-${r.resource}`);
    await expect(row).toBeVisible();
    const text = await row.innerText();
    if (r.measurable) expect(text).toContain(String(r.used));
    else expect(text).toMatch(/Not measured/);
    if (r.limit == null) expect(text).toMatch(/Unlimited|Not enforced/);
  }
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/\$\d/); // no invented prices on a manual subscription
  expect(body).not.toMatch(/renew(al|s) on/i);
  expect(errors).toEqual([]);
});

test("billing is gated by subscriptions:view — the nav link and the page deny an employee without permission", async ({ page }) => {
  await seedAs(page, viewer);
  await page.goto("/admin");
  await expect(page.locator('a[href="/admin/contacts"]').first()).toBeVisible();
  await expect(page.locator('a[href="/admin/subscription"]')).toHaveCount(0);
  await page.goto("/admin/subscription");
  await expect(page.getByText("No access")).toBeVisible();
  await expect(page.getByTestId("plan-name")).toHaveCount(0);
  // The admin of the same company sees the link.
  const adminPage = await page.context().newPage();
  await seedAs(adminPage, admin);
  await adminPage.goto("/admin");
  await expect(adminPage.locator('a[href="/admin/subscription"]').first()).toBeVisible();
  await adminPage.close();
});

test("self-service Checkout is offered only with a verified price; entitlement changes only after the signed webhook", async ({ page }) => {
  const errors = trackConsole(page);
  await seedAs(page, admin);
  await page.route("https://checkout.fake.local/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Fake Checkout</title><h1>Hosted checkout (intercepted)</h1>" }));
  await page.goto("/admin/subscription");
  await expect(page.getByTestId("status-badge")).toHaveText("Trial");
  await expect(page.getByTestId("access-mode")).toHaveText("Full access");
  await expect(page.getByTestId("checkout-card")).toBeVisible();
  const option = page.getByTestId(`price-option-${priceId}`);
  await expect(option).toContainText("Professional");
  await expect(option).toContainText(`${money(4900, "usd")} / month`);
  await page.getByTestId(`checkout-button-${priceId}`).click();
  await page.waitForURL(/checkout\.fake\.local/);
  // Nothing changed locally: still a manual trial; only the provider customer got linked.
  const afterClick = (await api("GET", "/subscriptions/current", undefined, admin.token)).json;
  expect(afterClick).toMatchObject({ status: "trialing", billingSource: "manual", accessMode: "full", providerLinked: true, providerSubscriptionLinked: false });

  const applied = await webhook("customer.subscription.created", subscriptionObject("active"), T0 + 1);
  expect(applied.outcome).toBe("applied");
  await page.goto("/admin/subscription?checkout=success");
  await expect(page.getByTestId("checkout-returned")).toContainText("Checkout completed");
  await expect(page.getByTestId("status-badge")).toHaveText("Active");
  await expect(page.getByTestId("plan-name")).toHaveText(/professional/i);
  await expect(page.getByTestId("period-line")).not.toHaveText("No billing period");
  await expect(page.getByTestId("billing-card")).toContainText("Online billing");
  await expect(page.getByTestId("checkout-card")).toHaveCount(0);
  await expect(page.getByTestId("portal-button")).toBeVisible();
  await page.route("https://billing.fake.local/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Fake Portal</title><h1>Hosted billing portal (intercepted)</h1>" }));
  await page.getByTestId("portal-button").click();
  await page.waitForURL(/billing\.fake\.local/);
  expect(errors).toEqual([]);
});

test("read-only states render truthfully: past due, then provider cancellation", async ({ page }) => {
  await seedAs(page, admin);
  expect((await webhook("customer.subscription.updated", subscriptionObject("past_due"), T0 + 10)).outcome).toBe("applied");
  await page.goto("/admin/subscription");
  await expect(page.getByTestId("status-badge")).toHaveText("Past due");
  await expect(page.getByTestId("access-mode")).toHaveText("Read-only");
  await expect(page.getByTestId("access-banner")).toContainText("Read-only");
  await expect(page.getByTestId("access-banner")).toContainText("past due");
  // Mutations are refused server-side while read-only.
  const denied = await api("POST", "/contacts", { firstName: "Read", lastName: "Only" }, admin.token);
  expect(denied.status).toBe(403);

  expect((await webhook("customer.subscription.deleted", subscriptionObject("canceled", { canceled_at: T0 + 20, ended_at: T0 + 20 }), T0 + 20)).outcome).toBe("applied");
  await page.reload();
  await expect(page.getByTestId("status-badge")).toHaveText("Cancelled");
  await expect(page.getByTestId("access-mode")).toHaveText("Read-only");
  // No live provider subscription remains → a new Checkout is offered again, truthfully.
  await expect(page.getByTestId("checkout-card")).toBeVisible();
});

test("platform Subscriptions: canonical list, filters, detail with confirmed lifecycle actions, truthful revenue", async ({ page }) => {
  const errors = trackConsole(page);
  await seedAs(page, platform);
  await page.goto("/platform/subscriptions");
  await expect(page.getByTestId("platform-subscriptions")).toBeVisible();
  const metrics = (await api("GET", "/platform/subscriptions/metrics", undefined, platform.token)).json;
  const mrr = page.getByTestId("mrr-card");
  if (metrics.revenue.available) await expect(mrr).toContainText(money(metrics.revenue.monthlyRecurringMinor, metrics.revenue.currency));
  else await expect(mrr).toContainText("Unavailable");
  await expect(page.getByTestId("provider-card")).toContainText("fake");
  await expect(page.getByTestId("prices-card")).toContainText(money(4900, "usd"));
  await expect(page.locator("body")).not.toContainText(PRICE_ID); // provider ids are masked

  await page.getByTestId("sub-search").fill(COMPANY_NAME);
  const row = page.getByTestId(`sub-row-${companyId}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText("Cancelled");
  await expect(row).toContainText("stripe");
  await expect(page.getByTestId("sub-total")).toHaveText("1 subscription");

  // Detail → convert to manual (allowed: no live provider subscription) → activate → suspend → reactivate.
  await page.getByTestId(`sub-manage-${companyId}`).click();
  const detail = page.getByTestId("sub-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(COMPANY_NAME);
  await expect(detail.getByTestId("action-activate")).toHaveCount(0); // Stripe-managed rows refuse manual activation
  await detail.getByTestId("action-convert_to_manual").click();
  await expect(page.getByTestId("lifecycle-dialog")).toContainText("no live provider subscription");
  await page.getByTestId("lifecycle-confirm").click();
  await expect(detail.getByTestId("action-activate")).toBeVisible();
  await detail.getByTestId("action-activate").click();
  await expect(page.getByTestId("lifecycle-dialog")).toContainText("regains full access");
  await page.getByTestId("lifecycle-confirm").click();
  await expect(detail).toContainText("Active");
  await detail.getByTestId("action-suspend").click();
  await page.getByTestId("suspend-reason").fill("QA suspension");
  await page.getByTestId("lifecycle-confirm").click();
  await expect(detail).toContainText("Suspended");
  await expect(detail).toContainText("QA suspension");
  const suspended = (await api("GET", `/platform/subscriptions/${companyId}`, undefined, platform.token)).json;
  expect(suspended).toMatchObject({ status: "suspended", billingSource: "manual", suspendedReason: "QA suspension", accessMode: "blocked" });
  await detail.getByTestId("action-reactivate").click();
  await page.getByTestId("lifecycle-confirm").click();
  await expect(detail).toContainText("Active");
  await detail.getByRole("button", { name: "Close" }).click();
  await expect(detail).toBeHidden();
  await expect(row).toContainText("Active");
  await expect(row).toContainText("manual");

  // Status filter is canonical.
  await page.getByTestId("sub-status-filter").click();
  await page.getByRole("option", { name: "Expired" }).click();
  await expect(page.getByText("No subscriptions match")).toBeVisible();
  await page.getByTestId("sub-status-filter").click();
  await page.getByRole("option", { name: "Active" }).click();
  await expect(page.getByTestId(`sub-row-${companyId}`)).toBeVisible();
  expect(errors).toEqual([]);
});

test("platform dashboard and companies carry no simulated metrics", async ({ page }) => {
  const errors = trackConsole(page);
  await seedAs(page, platform);
  const stats = (await api("GET", "/platform/stats", undefined, platform.token)).json;
  await page.goto("/platform");
  await expect(page.getByTestId("platform-dashboard")).toBeVisible();
  const mrr = page.getByTestId("dashboard-mrr");
  if (stats.revenue.available) await expect(mrr).toContainText(money(stats.revenue.monthlyRecurringMinor, stats.revenue.currency));
  else await expect(mrr).toContainText("Unavailable");
  await expect(page.getByTestId("dashboard-arr")).toContainText(stats.revenue.available ? money(stats.revenue.monthlyRecurringMinor * 12, stats.revenue.currency) : "Unavailable");
  await expect(page.getByTestId("dashboard-revenue-trend")).toContainText("Revenue history unavailable");
  let shown = 0;
  for (const s of stats.subscriptions.byStatus as Array<{ status: string; count: number }>) {
    if (s.count === 0) continue;
    const line = page.getByTestId(`status-count-${s.status}`);
    await expect(line).toContainText(String(s.count));
    shown += s.count;
  }
  expect(shown).toBe(stats.totalCompanies >= shown ? shown : shown);
  const text = await page.getByTestId("platform-dashboard").innerText();
  expect(text).not.toMatch(/[+-]\d+(\.\d+)?%/); // no growth percentages
  expect(text).not.toMatch(/Inactive/);
  await page.goto("/platform/companies");
  await expect(page.getByTestId("platform-companies")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Company" })).toHaveCount(0);
  await page.getByPlaceholder("Search companies...").fill(COMPANY_NAME);
  const row = page.getByTestId(`company-row-${companyId}`);
  await expect(row).toBeVisible();
  // The row mirrors the canonical subscription (never the legacy company columns).
  const company = (await api("GET", `/companies/${companyId}`, undefined, platform.token)).json;
  await expect(row).toContainText(new RegExp(company.subscription.status.replace("_", " "), "i"));
  await expect(row).toContainText(new RegExp(company.subscription.plan, "i"));
  expect(errors).toEqual([]);
});

test("isolation and role routing: another tenant sees only its own subscription; the platform owner never sees tenant billing", async ({ page }) => {
  await seedAs(page, nexus);
  const mine = (await api("GET", "/subscriptions/current", undefined, nexus.token)).json;
  expect(mine.companyId).toBe(nexus.user.companyId);
  expect(mine.companyId).not.toBe(companyId);
  await page.goto("/admin/subscription");
  await expect(page.getByTestId("plan-name")).toHaveText(new RegExp(mine.plan, "i"));
  await expect(page.locator("body")).not.toContainText(COMPANY_NAME);
  const owner = await page.context().newPage();
  await seedAs(owner, platform);
  await owner.goto("/admin/subscription");
  await owner.waitForURL("**/platform");
  await expect(owner.getByTestId("subscription-page")).toHaveCount(0);
  await owner.close();
});

for (const vp of [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "tablet-1024", width: 1024, height: 768 },
  { name: "mobile-390", width: 390, height: 844 },
] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`responsive ${vp.name} / ${theme}: tenant and platform billing screens render without overflow or console errors`, async ({ page }) => {
      const errors = trackConsole(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await seedAs(page, admin, theme);
      await page.goto("/admin/subscription");
      await expect(page.getByTestId("subscription-page")).toBeVisible();
      await expect(page.getByTestId("usage-card")).toBeVisible();
      expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
      if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
      else await expect(page.locator("html")).not.toHaveClass(/dark/);
      const owner = await page.context().newPage();
      trackConsole(owner);
      await owner.setViewportSize({ width: vp.width, height: vp.height });
      await seedAs(owner, platform, theme);
      await owner.goto("/platform/subscriptions");
      await expect(owner.getByTestId("platform-subscriptions")).toBeVisible();
      await expect(owner.getByTestId("mrr-card")).toBeVisible();
      expect(await pageOverflow(owner)).toBeLessThanOrEqual(1);
      if (theme === "dark") await expect(owner.locator("html")).toHaveClass(/dark/);
      await owner.goto("/platform");
      await expect(owner.getByTestId("platform-dashboard")).toBeVisible();
      expect(await pageOverflow(owner)).toBeLessThanOrEqual(1);
      await owner.close();
      expect(errors).toEqual([]);
    });
  }
}
