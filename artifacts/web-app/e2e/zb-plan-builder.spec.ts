import type { Page } from "@playwright/test";
import { test, expect, seedAuth } from "./fixtures/workspace";
import { API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * ZB. Batch 39 — Plan Builder foundation (READ-ONLY platform plan catalog).
 *
 * Runs against the local stack. Proves the platform owner's Plans screen shows
 * only real API data (the five fixed plans, their default limits, verified price
 * mappings, trial policy, subscription counts, override counts), that the
 * effective-limit preview mirrors the API's single resolver for a real tenant
 * with an override whose usage already exceeds the lowered limit, that NO edit /
 * publish / delete control exists on the page, that a tenant admin is redirected
 * from /platform/plans without the page ever rendering and is refused by the API
 * (403), and that the page renders without console errors or horizontal
 * overflow at desktop and phone widths in light and dark themes.
 */

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PASSWORD = "PlanQa123!";
const COMPANY_NAME = `${RUN_TAG} Plan Builder Co`;
const ADMIN_EMAIL = `${RUN_TAG.toLowerCase()}.plans-admin@example.test`;
const RESOURCES = ["contacts", "events", "admins", "employees", "scans", "storageMb"] as const;

type Auth = { token: string; user: { id: number; companyId: number | null; email: string; role?: string } };

let platform: Auth;
let admin: Auth;
let companyId = 0;

async function api(method: string, path: string, body?: unknown, token: string | null = null) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
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
    ([t, u, cid, th, userId]) => {
      try {
        localStorage.setItem("csp_token", t as string);
        localStorage.setItem("csp_user", u as string);
        if (cid) localStorage.setItem("csp_company_id", cid as string);
        localStorage.setItem("csp_theme", th as string);
        localStorage.setItem(`csp_theme:u${userId}c${cid}`, th as string);
      } catch {
        /* storage unavailable */
      }
    },
    [auth.token, JSON.stringify(auth.user), String(auth.user.companyId ?? ""), theme, String(auth.user.id)] as const,
  );
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
const limitText = (n: number | null) => (n == null ? "Unlimited" : n.toLocaleString("en-US"));

test.beforeAll(async () => {
  platform = await login(PLATFORM.email, PLATFORM.password);
  const company = await api("POST", "/companies", { name: COMPANY_NAME, plan: "free", industry: "QA" }, platform.token);
  expect(company.status, company.text).toBe(201);
  companyId = company.json.id;
  const user = await api("POST", "/users", { email: ADMIN_EMAIL, name: "Plan Admin", role: "primary_admin", companyId, password: PASSWORD }, platform.token);
  expect(user.status, user.text).toBe(201);
  admin = await login(ADMIN_EMAIL, PASSWORD);
  // Four contacts, then an override BELOW usage: the preview must report the excess, never hide it.
  for (let i = 0; i < 4; i++) {
    const c = await api("POST", "/contacts", { firstName: "Plan", lastName: `Preview${i}`, email: `${RUN_TAG.toLowerCase()}.preview${i}@example.test` }, admin.token);
    expect(c.status, c.text).toBe(201);
  }
  const limits = await api("PUT", `/platform/subscriptions/${companyId}/limits`, { limits: { contacts: 3 } }, platform.token);
  expect(limits.status, limits.text).toBe(200);
});

test("platform owner: the Plans screen shows the catalog, detail, prices, counts and a truthful effective-limit preview — with no edit controls", async ({ page }) => {
  const errors = trackConsole(page);
  await seedAs(page, platform);
  await page.goto("/platform/plans");
  const root = page.getByTestId("platform-plans");
  await expect(root).toBeVisible();
  await expect(page.locator('a[href="/platform/plans"]').first()).toBeVisible();

  // Catalog = the API's five plans, in the API's order, with the API's default limits.
  const catalog = (await api("GET", "/platform/plans", undefined, platform.token)).json;
  expect(catalog.plans.map((p: any) => p.id)).toEqual(["free", "starter", "professional", "business", "enterprise"]);
  await expect(page.locator('[data-testid^="plan-row-"]')).toHaveCount(5);
  for (const p of catalog.plans) {
    const row = page.getByTestId(`plan-row-${p.id}`);
    await expect(row).toContainText(p.name);
    for (const r of RESOURCES) await expect(page.getByTestId(`plan-limit-${p.id}-${r}`)).toHaveText(limitText(p.limits[r]));
    await expect(page.getByTestId(`plan-subs-${p.id}`)).toHaveText(String(p.subscriptions.total));
  }
  await expect(page.getByTestId("plans-readonly-notice")).toContainText("not editable in place");
  await expect(page.getByTestId("trial-policy-card")).toContainText(`${catalog.trialPolicy.defaultTrialDays} days`);

  // No mutation control anywhere on the page.
  await expect(root.getByRole("button", { name: /^(edit|save|publish|delete|archive|create plan|new plan|duplicate)$/i })).toHaveCount(0);
  await expect(root.locator("input:not([data-testid='preview-search'])")).toHaveCount(0);

  // Detail card for the tenant's plan.
  await page.getByTestId("plan-details-free").click();
  const detail = page.getByTestId("plan-detail");
  await expect(detail).toBeVisible();
  const free = (await api("GET", "/platform/plans/free", undefined, platform.token)).json;
  await expect(page.getByTestId("plan-detail-title")).toHaveText(free.name);
  for (const r of RESOURCES) {
    await expect(page.getByTestId(`limit-default-${r}`)).toHaveText(limitText(free.limits[r]));
    await expect(page.getByTestId(`limit-overrides-${r}`)).toHaveText(String(free.overrides.byResource[r]));
  }
  expect(free.overrides.byResource.contacts).toBeGreaterThanOrEqual(1); // our tenant's override is counted
  await expect(page.getByTestId("plan-count-total")).toHaveText(String(free.subscriptions.total));
  if (Object.keys(free.features).length === 0) await expect(page.getByTestId("plan-features-empty")).toBeVisible();
  if (free.prices.length === 0) {
    await expect(page.getByTestId("plan-prices-empty")).toBeVisible();
  } else {
    for (const pr of free.prices) await expect(page.getByTestId(`price-row-${pr.id}`)).toBeVisible();
  }
  // A plan WITH a verified price mapping (the billing suite registers one for professional when the fake provider runs).
  const pro = (await api("GET", "/platform/plans/professional", undefined, platform.token)).json;
  await page.getByTestId("plan-details-professional").click();
  await expect(page.getByTestId("plan-detail-title")).toHaveText(pro.name);
  if (pro.prices.length > 0) {
    for (const pr of pro.prices) {
      const row = page.getByTestId(`price-row-${pr.id}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(pr.providerMode);
      await expect(row).toContainText(pr.active ? "Active" : "Inactive");
    }
  } else {
    await expect(page.getByTestId("plan-prices-empty")).toBeVisible();
  }

  // Effective-limit preview for our tenant under its current plan (free): the API's rows, verbatim.
  await page.getByTestId("preview-plan").click();
  await page.getByRole("option", { name: free.name }).click();
  await page.getByTestId("preview-search").fill(COMPANY_NAME);
  await page.getByTestId(`preview-pick-${companyId}`).click();
  const pv = (await api("GET", `/platform/plans/free/effective-limits/${companyId}`, undefined, platform.token)).json;
  expect(pv).toMatchObject({ isCurrentPlan: true, blockingResources: ["contacts"], readOnly: true });
  await expect(page.getByTestId("preview-summary")).toContainText(COMPANY_NAME);
  for (const r of pv.rows) {
    const row = page.getByTestId(`preview-row-${r.resource}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`preview-effective-${r.resource}`)).toHaveText(limitText(r.effective));
    await expect(page.getByTestId(`preview-override-${r.resource}`)).toHaveText(r.override == null ? "—" : String(r.override));
    await expect(page.getByTestId(`preview-used-${r.resource}`)).toHaveText(r.measurable ? String(r.used) : "n/a");
  }
  await expect(page.getByTestId("preview-row-contacts")).toContainText("usage exceeds limit");
  await expect(page.getByTestId("preview-footnote")).toContainText("contacts");
  await expect(page.getByTestId("preview-footnote")).toContainText("no subscription, plan or override was modified");

  // Previewing is read-only: the tenant's subscription is untouched.
  const after = (await api("GET", `/platform/subscriptions/${companyId}`, undefined, platform.token)).json;
  expect(after.plan).toBe("free");
  expect(after.limitOverrides).toEqual({ contacts: 3 });

  expect(await pageOverflow(page)).toBe(0);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("responsive + dark: the Plans screen has no horizontal overflow and no console errors at phone width in dark theme", async ({ page }) => {
  const errors = trackConsole(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await seedAs(page, platform, "dark");
  await page.goto("/platform/plans");
  await expect(page.getByTestId("platform-plans")).toBeVisible();
  await expect(page.locator('[data-testid^="plan-row-"]')).toHaveCount(5);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByTestId("plan-details-free").click();
  await expect(page.getByTestId("plan-detail")).toBeVisible();
  expect(await pageOverflow(page)).toBe(0);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("tenant isolation: a company admin never renders /platform/plans and the API refuses the plan endpoints (403)", async ({ page }) => {
  // Browser: ProtectedRoute redirects before the platform layout mounts (same proof as m-role-routing).
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, boolean>;
    w.__platform_seen = false;
    const check = () => {
      if (document.body?.innerText?.includes("Platform Portal")) w.__platform_seen = true;
      if (document.querySelector('[data-testid="platform-plans"]')) w.__platform_seen = true;
    };
    new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
  });
  await seedAuth(page); // TechCorp primary_admin
  await page.goto("/platform/plans");
  await page.waitForURL("**/admin");
  await expect(page.getByTestId("platform-plans")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, boolean>).__platform_seen)).toBe(false);

  // API: every plan endpoint is behind the platform firewall.
  for (const path of ["/platform/plans", "/platform/plans/free", `/platform/plans/free/effective-limits/${companyId}`]) {
    const r = await api("GET", path, undefined, admin.token);
    expect(r.status, path).toBe(403);
  }
  const anon = await api("GET", "/platform/plans");
  expect(anon.status).toBe(401);
});
