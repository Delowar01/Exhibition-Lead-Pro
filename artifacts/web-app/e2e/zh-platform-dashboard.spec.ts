import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/workspace";
import { API_BASE } from "./fixtures/seed-values";

/**
 * ZH. G-7 — the Platform Dashboard (/platform) uses the same definitions as Platform Owner
 * Analytics: Total Users are company users that exist today, every capture is told apart
 * from the card scans sent for OCR, and money is formatted in the currency's own minor unit.
 *
 * Figures are compared with the API's own answer (the oracle); the currency cases intercept
 * the single stats request because a local database holds one currency at most. The design
 * of the page is unchanged: the same six metric cards, charts and company table.
 *
 * Set G7_SHOTS_DIR to an existing directory to also save screenshots (off by default).
 */

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const SHOTS = process.env.G7_SHOTS_DIR;
type Auth = { token: string; user: { id: number; companyId: number | null; email: string } };
let platform: Auth;

const fmt = (n: number) => n.toLocaleString("en-US");

async function api(method: string, p: string, token: string | null = null, body?: unknown) {
  const res = await fetch(`${API_BASE}${p}`, {
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

async function seedAs(page: Page, auth: Auth) {
  await page.addInitScript(
    ([t, u, cid, userId]) => {
      try {
        localStorage.setItem("csp_token", t as string);
        localStorage.setItem("csp_user", u as string);
        if (cid) localStorage.setItem("csp_company_id", cid as string);
        localStorage.setItem("csp_theme", "light");
        localStorage.setItem(`csp_theme:u${userId}c${cid}`, "light");
      } catch {
        /* storage unavailable */
      }
    },
    [auth.token, JSON.stringify(auth.user), String(auth.user.companyId ?? ""), String(auth.user.id)] as const,
  );
}

function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  const noise = (s: string) => /fonts\.googleapis|fonts\.gstatic|ERR_CERT_AUTHORITY_INVALID|Failed to load resource/.test(s);
  page.on("console", (m) => {
    if (m.type() === "error" && !noise(m.text()) && !noise(m.location()?.url ?? "")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const isStats = (url: string) => /\/api(?:\/v1)?\/platform\/stats$/.test(new URL(url).pathname);
const value = (page: Page, testId: string) => page.getByTestId(testId).locator("p.text-3xl");

/** Opens the dashboard and returns the stats JSON the page itself received. */
async function openDashboard(page: Page) {
  const wait = page.waitForResponse((r) => isStats(r.url()) && r.status() === 200);
  await page.goto("/platform");
  const stats = await (await wait).json();
  await expect(page.getByTestId("platform-dashboard")).toBeVisible();
  return stats;
}

/** Opens the dashboard with the revenue block of the stats response replaced. */
async function openWithRevenue(page: Page, revenue: Record<string, unknown>) {
  const real = (await api("GET", "/platform/stats", platform.token)).json;
  await page.route("**/api/platform/stats", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...real, revenue }) }));
  await page.goto("/platform");
  await expect(page.getByTestId("platform-dashboard")).toBeVisible();
}

test.beforeAll(async () => {
  if (SHOTS && !fs.existsSync(SHOTS)) throw new Error(`G7_SHOTS_DIR does not exist: ${SHOTS}`);
  const res = await api("POST", "/auth/login", null, PLATFORM);
  expect(res.status, res.text).toBe(200);
  platform = { token: res.json.token, user: res.json.user };
});

test("totals follow the shared definitions and captures are told apart from card scans", async ({ page }) => {
  const errors = trackConsole(page);
  await seedAs(page, platform);
  const stats = await openDashboard(page);

  // The API answers the same when asked directly, and its figures are internally consistent.
  const direct = (await api("GET", "/platform/stats", platform.token)).json;
  expect(direct.totalUsers).toBe(stats.totalUsers);
  expect(stats.totalScans).toBeLessThanOrEqual(stats.totalCaptures);

  await expect(page.getByTestId("dashboard-total-users")).toContainText("Total Users");
  await expect(value(page, "dashboard-total-users")).toHaveText(fmt(stats.totalUsers));
  await expect(page.getByTestId("dashboard-total-users")).toContainText("Company users across all tenants");

  // One card, two measures, each named for what it is.
  const captures = page.getByTestId("dashboard-total-captures");
  await expect(captures).toContainText("Total Captures");
  await expect(value(page, "dashboard-total-captures")).toHaveText(fmt(stats.totalCaptures));
  await expect(page.getByTestId("dashboard-card-scans")).toHaveText(`${fmt(stats.totalScans)} card ${stats.totalScans === 1 ? "scan" : "scans"} sent for OCR`);
  // The card is dark; its figure must be readable on it (it used to be dark on dark).
  const contrast = await value(page, "dashboard-total-captures").evaluate((el) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = (c: string) => {
      const [r, g, b] = rgb(c).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const fg = lum(getComputedStyle((el.firstElementChild as HTMLElement | null) ?? el).color);
    const bg = lum(getComputedStyle(el.closest(".rounded-lg")!).backgroundColor);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  // The ambiguous label is gone: nothing calls the capture total "scans".
  await expect(page.getByTestId("platform-dashboard").getByText("Total Scans", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("platform-dashboard").getByText("Cards captured system-wide")).toHaveCount(0);

  // The trend is named for what it counts.
  const trend = page.getByTestId("dashboard-scan-trend");
  await expect(trend).toContainText("Card Scan Volume");
  await expect(trend).toContainText("Card scans sent for OCR per day");
  await expect(trend).toContainText("Captures saved without OCR are not included");

  // The dashboard and the analytics page report the same users.
  const overview = (await api("GET", "/platform/analytics/overview", platform.token)).json;
  expect(overview.totals.users).toBe(stats.totalUsers);
  expect(overview.totals.companies).toBe(stats.totalCompanies);
  expect(errors, errors.join("\n")).toEqual([]);
});

// What the figure counts is proven against the database in the API suite
// (g7-platform-dashboard.test.ts); here the page is checked against the API.
test("the company table shows the API's Users figure for every company", async ({ page }) => {
  await seedAs(page, platform);
  const wait = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/companies") && r.status() === 200);
  await openDashboard(page);
  const listed = (await (await wait).json()).companies as Array<{ id: number; name: string; userCount: number }>;
  expect(listed.length).toBeGreaterThan(0);
  const rows = page.getByTestId("platform-dashboard").locator("table tbody tr");
  await expect(rows).toHaveCount(listed.length);
  for (const [i, c] of listed.entries()) {
    await expect(rows.nth(i).locator("td").first()).toHaveText(c.name);
    await expect(rows.nth(i).locator("td").nth(2)).toHaveText(String(c.userCount));
    // The same company read on its own reports the same figure.
    const detail = (await api("GET", `/companies/${c.id}`, platform.token)).json;
    expect(detail.userCount, c.name).toBe(c.userCount);
  }
});

test.describe("money is formatted in the currency's own minor unit", () => {
  const snapshot = (currency: string, monthlyRecurringMinor: number) => ({
    available: true,
    reason: null,
    currency,
    monthlyRecurringMinor,
    countedSubscriptions: 3,
    unpricedSubscriptions: 0,
  });

  test("US dollars keep their cents", async ({ page }) => {
    await seedAs(page, platform);
    await openWithRevenue(page, snapshot("usd", 176600));
    await expect(value(page, "dashboard-mrr")).toHaveText("$1,766.00");
    await expect(value(page, "dashboard-arr")).toHaveText("$21,192.00");
    await expect(page.getByTestId("dashboard-mrr")).toContainText("3 priced subscriptions");
    await expect(page.getByTestId("dashboard-arr")).toContainText("MRR × 12");
  });

  test("yen has no minor unit: 5,000 is ¥5,000, not ¥50", async ({ page }) => {
    await seedAs(page, platform);
    await openWithRevenue(page, snapshot("jpy", 5000));
    await expect(value(page, "dashboard-mrr")).toHaveText("¥5,000");
    await expect(value(page, "dashboard-arr")).toHaveText("¥60,000");
  });

  test("Kuwaiti dinar has three decimals: 10,000 fils are 10 dinars, not 100", async ({ page }) => {
    await seedAs(page, platform);
    await openWithRevenue(page, snapshot("kwd", 10000));
    await expect(value(page, "dashboard-mrr")).toContainText("10.000");
    await expect(value(page, "dashboard-mrr")).not.toContainText("100.00");
    await expect(value(page, "dashboard-arr")).toContainText("120.000");
  });

  test("an unavailable figure stays unavailable, with its reason and no amount", async ({ page }) => {
    await seedAs(page, platform);
    await openWithRevenue(page, { available: false, reason: "MIXED_CURRENCIES", currency: "usd", monthlyRecurringMinor: 999900, countedSubscriptions: 0, unpricedSubscriptions: 0 });
    await expect(page.getByTestId("dashboard-mrr")).toContainText("Unavailable");
    await expect(page.getByTestId("dashboard-arr")).toContainText("Unavailable");
    await expect(page.getByTestId("dashboard-mrr")).toContainText("more than one currency");
    await expect(page.getByTestId("dashboard-mrr")).not.toContainText(/[$€£¥]\s?\d/);
    await expect(page.getByTestId("dashboard-arr")).not.toContainText(/[$€£¥]\s?\d/);
  });
});

test("the Subscriptions page formats the same recurring revenue the same way", async ({ page }) => {
  // The MRR card of /platform/subscriptions shows the figure of the dashboard's MRR card.
  await seedAs(page, platform);
  const real = (await api("GET", "/platform/subscriptions/metrics", platform.token)).json;
  const revenue = { available: true, reason: null, currency: "jpy", monthlyRecurringMinor: 5000, countedSubscriptions: 3, unpricedSubscriptions: 0 };
  await page.route("**/api/platform/subscriptions/metrics", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...real, revenue }) }));
  await page.goto("/platform/subscriptions");
  await expect(page.getByTestId("platform-subscriptions")).toBeVisible();
  await expect(page.getByTestId("mrr-card")).toContainText("¥5,000");
  // Dividing by 100 would print ¥50: no "¥50" that is not the start of a longer figure.
  expect(await page.getByTestId("mrr-card").innerText()).not.toMatch(/¥50(?![\d,])/);
});

test("the company pages call the per-company figure Captures, not Scans", async ({ page }) => {
  await seedAs(page, platform);
  const listed = (await api("GET", "/companies?limit=1", platform.token)).json.companies as Array<{ id: number; scanCount: number }>;
  expect(listed.length).toBe(1);
  await page.goto("/platform/companies");
  await expect(page.getByRole("columnheader", { name: "Captures", exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Scans", exact: true })).toHaveCount(0);

  await page.goto(`/platform/companies/${listed[0].id}`);
  const figure = page.getByTestId("count-scans");
  await expect(figure).toHaveText(String(listed[0].scanCount));
  await expect(figure.locator("xpath=..")).toContainText("Captures");
});

for (const vp of [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "tablet-820", width: 820, height: 1180 },
  { name: "mobile-390", width: 390, height: 844 },
] as const) {
  test(`the dashboard keeps its design and fits ${vp.name}`, async ({ page }) => {
    const errors = trackConsole(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await seedAs(page, platform);
    await openDashboard(page);
    await page.waitForTimeout(300);

    // The same six metric cards, in the same order.
    const labels = await page.getByTestId("platform-dashboard").locator("div.grid").first().locator("p.text-sm.font-medium").allInnerTexts();
    expect(labels).toEqual(["Total Companies", "Total Users", "MRR", "ARR", "Total Leads", "Total Captures"]);
    for (const id of ["dashboard-revenue-trend", "dashboard-subscription-status", "dashboard-scan-trend"]) await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Platform Dashboard" })).toBeVisible();

    // The two cards that gained a test hook still fill their grid cell, like the plain cards beside them.
    for (const id of ["dashboard-total-users", "dashboard-total-captures"]) {
      const [cell, card] = await page.getByTestId(id).evaluate((el) => [el.getBoundingClientRect().height, el.firstElementChild!.getBoundingClientRect().height]);
      expect(Math.round(card), id).toBe(Math.round(cell));
    }
    if (vp.width >= 1440) {
      // On one row, the CARDS inside the two wrappers are as tall as the unwrapped
      // "Total Companies" and "Total Leads" cards (grid cells are equal by construction;
      // the cards themselves are what could fall short).
      const cells = page.getByTestId("platform-dashboard").locator("div.grid").first().locator(":scope > *");
      await expect(cells).toHaveCount(6);
      const cardHeight = (i: number, wrapped: boolean) => cells.nth(i).evaluate((el, w) => Math.round((w ? el.firstElementChild! : el).getBoundingClientRect().height), wrapped);
      const [companies, users, leads, captures] = await Promise.all([cardHeight(0, false), cardHeight(1, true), cardHeight(4, false), cardHeight(5, true)]);
      expect([users, leads, captures], `cards: ${[companies, users, leads, captures].join(",")}`).toEqual([companies, companies, companies]);
    }

    const overflow = await page.evaluate(() => {
      const main = document.querySelector("main");
      return { document: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
    });
    expect(overflow, vp.name).toEqual({ document: 0, main: 0 });

    if (SHOTS) {
      const height = await page.evaluate(() => document.querySelector("main")?.scrollHeight ?? document.body.scrollHeight);
      await page.setViewportSize({ width: vp.width, height: Math.min(Math.max(height + 140, vp.height), 7800) });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, `dashboard-${vp.name}.png`) });
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
