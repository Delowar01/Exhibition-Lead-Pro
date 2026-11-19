import fs from "node:fs";
import path from "node:path";
import type { Page, Response } from "@playwright/test";
import { test, expect } from "./fixtures/workspace";
import { ADMIN, API_BASE } from "./fixtures/seed-values";

/**
 * ZG. G-7 — Platform Owner Analytics (/platform/analytics).
 *
 * Integration against the real backend: every figure asserted on screen is compared with the
 * JSON the page itself received (the oracle), never with a number the test invents. Covers
 * the seven tabs, the period filter and its URL state, the chart/table switch, the loading,
 * error, stale and empty states, the honest revenue wording (estimate vs. actual events vs.
 * "not recorded"), role routing, keyboard use, and the layout at desktop, tablet and narrow
 * mobile-browser widths. Where a state cannot be produced from live data (a failing request,
 * a specific revenue estimate) the single request is intercepted; nothing else is mocked.
 *
 * Set G7_SHOTS_DIR to an existing directory to also save a screenshot of every tab at every
 * viewport (visual evidence; off by default so a normal run writes nothing).
 */

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const TABS = ["overview", "growth", "subscriptions", "revenue", "activity", "ai", "operations"] as const;
type Tab = (typeof TABS)[number];
const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "tablet-820", width: 820, height: 1180 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;
const SHOTS = process.env.G7_SHOTS_DIR;

type Auth = { token: string; user: { id: number; companyId: number | null; email: string; role?: string } };
let platform: Auth;
let tenant: Auth;

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const DAY = 86_400_000;
const utcDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

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

async function login(email: string, password: string): Promise<Auth> {
  const res = await api("POST", "/auth/login", null, { email, password });
  expect(res.status, res.text).toBe(200);
  return { token: res.json.token, user: res.json.user };
}

async function seedAs(page: Page, auth: Auth, theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ([t, u, cid, userId, th]) => {
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
    [auth.token, JSON.stringify(auth.user), String(auth.user.companyId ?? ""), String(auth.user.id), theme] as const,
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

/** The analytics API section a URL addresses, or null (the dev server also serves source files under a similar path). */
const sectionOf = (url: string): string | null => /\/api(?:\/v1)?\/platform\/analytics\/([a-z]+)$/.exec(new URL(url).pathname)?.[1] ?? null;
const isSection = (r: Response, section: string) => sectionOf(r.url()) === section;

/** Opens the page on a tab and returns the JSON that tab's request received (the oracle). */
async function openTab(page: Page, tab: Tab, query = ""): Promise<{ data: any; url: URL }> {
  const q = new URLSearchParams(query);
  if (tab !== "overview") q.set("tab", tab);
  const wait = page.waitForResponse((r) => isSection(r, tab) && r.status() === 200);
  await page.goto(`/platform/analytics${q.toString() ? `?${q}` : ""}`);
  const res = await wait;
  await expect(page.getByTestId(`analytics-${tab}`)).toBeVisible();
  return { data: await res.json(), url: new URL(res.url()) };
}

/** The big figure of a KPI card. */
const kpiValue = (page: Page, testId: string) => page.getByTestId(testId).locator("p.text-3xl");

const overflow = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });

test.beforeAll(async () => {
  platform = await login(PLATFORM.email, PLATFORM.password);
  tenant = await login(ADMIN.email, ADMIN.password);
});

test.describe("live data", () => {
  test("the placeholder is gone and the overview shows exactly what the API reports", async ({ page }) => {
    const errors = trackConsole(page);
    await seedAs(page, platform);
    const { data, url } = await openTab(page, "overview");

    await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);

    // The default window is the last 30 UTC days, and the page asked for exactly that.
    expect(url.searchParams.get("to")).toBe(data.range.to);
    expect(url.searchParams.get("from")).toBe(data.range.from);
    expect(data.range.days).toBe(30);
    expect(url.searchParams.has("granularity")).toBe(false);
    await expect(page.getByTestId("analytics-range-summary")).toContainText("30 days");
    await expect(page.getByTestId("analytics-range-summary")).toContainText("all dates in UTC");

    // The same query answered directly by the API is what the page received.
    const direct = await api("GET", `/platform/analytics/overview${url.search}`, platform.token);
    expect(direct.status).toBe(200);
    expect(direct.json.period).toEqual(data.period);

    for (const [testId, key] of [
      ["kpi-new-companies", "newCompanies"],
      ["kpi-new-users", "newUsers"],
      ["kpi-active-companies", "activeCompanies"],
      ["kpi-active-users", "activeUsers"],
      ["kpi-scans", "scans"],
      ["kpi-contacts", "contacts"],
      ["kpi-leads", "leads"],
      ["kpi-ai-requests", "aiRequests"],
    ] as const) {
      await expect(kpiValue(page, testId), testId).toHaveText(fmt(data.period[key].current));
      const { current, previous } = data.period[key];
      const card = page.getByTestId(testId);
      if (previous === 0) {
        // No percentage is ever invented from a zero baseline.
        await expect(card, testId).toContainText(current === 0 ? "None in either period" : "None in the previous period");
        await expect(card, testId).not.toContainText("%");
      } else {
        await expect(card, testId).toContainText(`vs ${fmt(previous)} in the previous period`);
      }
    }

    const facts = page.getByTestId("overview-subscription-facts");
    await expect(facts).toContainText(`${fmt(data.subscriptions.fullAccess)} of ${fmt(data.subscriptions.total)}`);
    for (const s of data.subscriptions.byStatus as Array<{ status: string; count: number }>) {
      if (data.subscriptions.total > 0) await expect(page.getByTestId(`overview-status-list-row-${s.status}`)).toContainText(fmt(s.count));
    }

    // Revenue is an estimate or "Unavailable" — exactly as the API says, never a made-up amount.
    const mrr = page.getByTestId("overview-mrr");
    if (data.revenue.available) await expect(mrr).toContainText(/\d/);
    else await expect(mrr).toHaveText("Unavailable");
    await expect(page.getByTestId("overview-revenue")).toContainText("Estimate");

    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("every tab loads only its own endpoint and renders it; tabs live in the URL", async ({ page }) => {
    const errors = trackConsole(page);
    await seedAs(page, platform);
    const requested: string[] = [];
    page.on("request", (r) => {
      const section = sectionOf(r.url());
      if (section) requested.push(section);
    });
    await openTab(page, "overview");
    // The overview reads the overview plus the two series it charts — nothing else.
    expect([...new Set(requested)].sort()).toEqual(["activity", "growth", "overview"]);

    for (const tab of TABS.slice(1)) {
      const before = requested.length;
      const wait = tab === "growth" || tab === "activity" ? null : page.waitForResponse((r) => isSection(r, tab) && r.status() === 200);
      await page.getByTestId(`analytics-tab-${tab}`).click();
      await expect(page).toHaveURL(new RegExp(`[?&]tab=${tab}(&|$)`));
      await expect(page.getByTestId(`analytics-${tab}`)).toBeVisible();
      await expect(page.getByTestId(`analytics-tab-${tab}`)).toHaveAttribute("aria-selected", "true");
      if (wait) {
        await wait;
        expect(requested.slice(before), tab).toEqual([tab]);
      } else {
        // Already loaded for the overview charts: served from the cache, no second request.
        expect(requested.slice(before), tab).toEqual([]);
      }
      for (const other of TABS) if (other !== tab) await expect(page.getByTestId(`analytics-${other}`)).toHaveCount(0);
    }

    await page.getByTestId("analytics-tab-overview").click();
    await expect(page).toHaveURL(/\/platform\/analytics$/);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("each tab's headline figures equal its API response", async ({ page }) => {
    await seedAs(page, platform);

    const growth = (await openTab(page, "growth")).data;
    await expect(kpiValue(page, "growth-new-companies")).toHaveText(fmt(growth.companies.added.current));
    await expect(kpiValue(page, "growth-total-companies")).toHaveText(fmt(growth.companies.endingTotal));
    await expect(page.getByTestId("growth-total-companies")).toContainText(`${fmt(growth.companies.startingTotal)} before this period`);
    await expect(kpiValue(page, "growth-new-users")).toHaveText(fmt(growth.users.added.current));
    await expect(kpiValue(page, "growth-total-users")).toHaveText(fmt(growth.users.endingTotal));
    await expect(page.getByTestId("growth-note")).toContainText("permanently deleted");

    const subs = (await openTab(page, "subscriptions")).data;
    await expect(kpiValue(page, "subs-total")).toHaveText(fmt(subs.snapshot.total));
    await expect(kpiValue(page, "subs-full-access")).toHaveText(fmt(subs.snapshot.fullAccess));
    await expect(kpiValue(page, "subs-trials-ending")).toHaveText(fmt(subs.snapshot.trialsExpiringWithin7Days));
    await expect(kpiValue(page, "subs-kpi-created")).toHaveText(fmt(subs.lifecycle.totals.created));
    await expect(kpiValue(page, "subs-kpi-activated")).toHaveText(fmt(subs.lifecycle.totals.toActive));
    await expect(kpiValue(page, "subs-kpi-cancelled")).toHaveText(fmt(subs.lifecycle.totals.toCancelled));
    await expect(kpiValue(page, "subs-kpi-plan-changes")).toHaveText(fmt(subs.lifecycle.totals.planChanges));
    for (const s of subs.snapshot.byStatus as Array<{ status: string; count: number }>) {
      await expect(page.getByTestId(`subs-status-list-row-${s.status}`)).toContainText(fmt(s.count));
    }
    // One row per plan, in the API's order, each with that plan's total.
    const planRows = page.getByTestId("subs-plan-table").locator("tbody tr");
    await expect(planRows).toHaveCount(subs.snapshot.byPlan.length);
    for (const [i, p] of (subs.snapshot.byPlan as Array<{ planId: string; planName: string | null; total: number }>).entries()) {
      await expect(planRows.nth(i).locator("td").first()).toHaveText(p.planName ?? p.planId);
      await expect(planRows.nth(i).locator("td").nth(3)).toHaveText(fmt(p.total));
    }
    await expect(page.getByTestId("subs-note")).toContainText("audit trail");

    const activity = (await openTab(page, "activity")).data;
    await expect(kpiValue(page, "activity-kpi-scans")).toHaveText(fmt(activity.totals.scans.current));
    await expect(kpiValue(page, "activity-kpi-contacts")).toHaveText(fmt(activity.totals.contacts.current));
    await expect(kpiValue(page, "activity-kpi-leads")).toHaveText(fmt(activity.totals.leads.current));
    await expect(kpiValue(page, "activity-kpi-companies")).toHaveText(fmt(activity.totals.activeCompanies.current));
    await expect(page.getByTestId("activity-manual-entries")).toContainText(new RegExp(`^${fmt(activity.manualEntries)} manual entr`));
    if (activity.topCompanies.length > 0) {
      const first = activity.topCompanies[0];
      const row = page.getByTestId("activity-top-table").locator("tbody tr").first();
      await expect(row.getByRole("link")).toHaveText(first.companyName);
      await expect(row.getByRole("link")).toHaveAttribute("href", `/platform/companies/${first.companyId}`);
      await expect(row.locator("td").nth(1)).toHaveText(fmt(first.scans));
      await expect(page.getByTestId("activity-top-table").locator("tbody tr")).toHaveCount(activity.topCompanies.length);
    } else {
      await expect(page.getByTestId("activity-top-companies")).toContainText("No company captured a card or a contact in this period.");
    }
    await expect(page.getByTestId("activity-note")).toContainText("never shown here");

    const ai = (await openTab(page, "ai")).data;
    await expect(kpiValue(page, "ai-kpi-requests")).toHaveText(fmt(ai.totals.requests));
    await expect(page.getByTestId("ai-kpi-failure-rate")).toContainText(`${fmt(ai.totals.errors)} failed`);
    await expect(kpiValue(page, "ai-kpi-cache")).toHaveText(fmt(ai.totals.cacheHits));
    await expect(kpiValue(page, "ai-kpi-budget")).toHaveText(fmt(ai.totals.budgetDenied));
    await expect(page.getByTestId("ai-cost-chart")).toContainText("Estimate");
    await expect(page.getByTestId("ai-note")).toContainText("not the provider's invoice");

    const ops = (await openTab(page, "operations")).data;
    await expect(kpiValue(page, "ops-kpi-signins")).toHaveText(fmt(ops.signIns.successful.current));
    await expect(kpiValue(page, "ops-kpi-failed-signins")).toHaveText(fmt(ops.signIns.failed.current));
    await expect(kpiValue(page, "ops-kpi-active-users")).toHaveText(fmt(ops.signIns.activeUsers.current));
    await expect(kpiValue(page, "ops-kpi-audit")).toHaveText(fmt(ops.auditEvents.total.current));
    await expect(kpiValue(page, "ops-kpi-security")).toHaveText(fmt(ops.securityEvents.total.current));
    await expect(kpiValue(page, "ops-kpi-billing")).toHaveText(fmt(ops.billingEvents.received.current));
    if (ops.jobs.durable) await expect(page.getByTestId("ops-jobs-figures")).toContainText(fmt(ops.jobs.pending));
    else await expect(page.getByTestId("ops-jobs")).toContainText("runs jobs in memory");
  });

  test("a chart can be read as a table with one row per period", async ({ page }) => {
    await seedAs(page, platform);
    const wait = page.waitForResponse((r) => isSection(r, "activity") && r.status() === 200);
    await openTab(page, "overview");
    const activity = await (await wait).json();
    const card = page.getByTestId("overview-scans-chart");
    const chartButton = card.getByRole("button", { name: "Chart" });
    const tableButton = card.getByRole("button", { name: "Table" });
    await expect(chartButton).toHaveAttribute("aria-pressed", "true");
    await expect(card.getByRole("table")).toHaveCount(0);

    await tableButton.click();
    await expect(tableButton).toHaveAttribute("aria-pressed", "true");
    await expect(chartButton).toHaveAttribute("aria-pressed", "false");
    const table = card.getByRole("table");
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveText(["Day", "Card scans"]);
    await expect(table.locator("tbody tr")).toHaveCount(activity.series.length);
    const last = activity.series[activity.series.length - 1];
    await expect(table.locator("tbody tr").last().locator("td").last()).toHaveText(fmt(last.scans));
    // The selected view is white text on the brand orange.
    await expect(tableButton).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(tableButton).toHaveCSS("background-color", "rgb(255, 102, 0)");

    await chartButton.click();
    await expect(card.getByRole("table")).toHaveCount(0);
  });

  test("links lead to the existing management pages", async ({ page }) => {
    await seedAs(page, platform);
    await openTab(page, "subscriptions");
    await expect(page.getByTestId("link-plans")).toHaveAttribute("href", "/platform/plans");
    await page.getByTestId("link-manage-subscriptions").click();
    await expect(page).toHaveURL(/\/platform\/subscriptions$/);
    await page.goBack();
    await expect(page.getByTestId("analytics-subscriptions")).toBeVisible();

    await openTab(page, "ai");
    await expect(page.getByTestId("link-ai")).toHaveAttribute("href", "/platform/ai");
    await openTab(page, "operations");
    await expect(page.getByTestId("link-activity")).toHaveAttribute("href", "/platform/activity");
    await openTab(page, "activity");
    await expect(page.getByTestId("link-companies")).toHaveAttribute("href", "/platform/companies");

    // In-page links between tabs keep the reporting window.
    await openTab(page, "overview", "range=7d");
    await page.getByRole("button", { name: "Revenue details" }).click();
    await expect(page).toHaveURL(/tab=revenue/);
    await expect(page).toHaveURL(/range=7d/);
    await expect(page.getByTestId("analytics-revenue")).toBeVisible();
  });

  test("the sidebar opens the page", async ({ page }) => {
    await seedAs(page, platform);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/platform");
    await page.getByRole("link", { name: "Analytics", exact: true }).first().click();
    await expect(page).toHaveURL(/\/platform\/analytics$/);
    await expect(page.getByTestId("platform-analytics")).toBeVisible();
  });
});

test.describe("period filter", () => {
  test("a preset changes the window, the URL and every request", async ({ page }) => {
    await seedAs(page, platform);
    await openTab(page, "overview");
    const wait = page.waitForResponse((r) => isSection(r, "overview") && new URL(r.url()).searchParams.get("from") === utcDay(-6));
    await page.getByTestId("analytics-period").click();
    await page.getByRole("option", { name: "Last 7 days" }).click();
    const res = await wait;
    const data = await res.json();
    expect(data.range).toMatchObject({ from: utcDay(-6), to: utcDay(0), days: 7, granularity: "day" });
    await expect(page).toHaveURL(/[?&]range=7d/);
    await expect(page.getByTestId("analytics-range-summary")).toContainText("7 days");
    await expect(kpiValue(page, "kpi-scans")).toHaveText(fmt(data.period.scans.current));

    // 12 months: the API groups by week on its own and the summary says so.
    const yearWait = page.waitForResponse((r) => isSection(r, "overview") && new URL(r.url()).searchParams.get("from") === utcDay(-364));
    await page.getByTestId("analytics-period").click();
    await page.getByRole("option", { name: "Last 12 months" }).click();
    expect((await (await yearWait).json()).range).toMatchObject({ days: 365, granularity: "week" });
    await expect(page.getByTestId("analytics-range-summary")).toContainText("Weekly figures");

    // Back to the default keeps the URL clean.
    await page.getByTestId("analytics-period").click();
    await page.getByRole("option", { name: "Last 30 days" }).click();
    await expect(page).toHaveURL(/\/platform\/analytics$/);
  });

  test("a custom range is validated before anything is requested, then applied", async ({ page }) => {
    await seedAs(page, platform);
    await openTab(page, "growth");
    const requests: string[] = [];
    page.on("request", (r) => {
      if (sectionOf(r.url())) requests.push(r.url());
    });

    await expect(page.getByTestId("analytics-custom-range")).toHaveCount(0);
    await page.getByTestId("analytics-period").click();
    await page.getByRole("option", { name: "Custom range" }).click();
    await expect(page.getByTestId("analytics-custom-range")).toBeVisible();
    await expect(page.getByLabel("From")).toBeVisible();
    await expect(page.getByLabel("To", { exact: true })).toBeVisible();

    // Reversed dates: an inline error, the fields are marked invalid, and no request is made.
    await page.getByTestId("analytics-from").fill(utcDay(-5));
    await page.getByTestId("analytics-to").fill(utcDay(-10));
    await page.getByTestId("analytics-apply").click();
    const error = page.getByTestId("analytics-range-error");
    await expect(error).toHaveText("The start date must not be after the end date.");
    await expect(error).toHaveAttribute("role", "alert");
    await expect(page.getByTestId("analytics-from")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("analytics-from")).toHaveAttribute("aria-describedby", "analytics-range-error");

    // A window longer than the limit is refused in the same way.
    await page.getByTestId("analytics-from").fill(utcDay(-800));
    await page.getByTestId("analytics-to").fill(utcDay(-1));
    await page.getByTestId("analytics-apply").click();
    await expect(error).toHaveText("A window can span at most 731 days.");
    expect(requests).toEqual([]);
    await expect(page).not.toHaveURL(/from=/);

    // A valid range is applied on submit (Enter works too) and lands in the URL.
    const from = utcDay(-40);
    const to = utcDay(-10);
    const wait = page.waitForResponse((r) => isSection(r, "growth") && new URL(r.url()).searchParams.get("from") === from);
    await page.getByTestId("analytics-from").fill(from);
    await page.getByTestId("analytics-to").fill(to);
    await page.getByTestId("analytics-to").press("Enter");
    const data = await (await wait).json();
    expect(data.range).toMatchObject({ from, to, days: 31 });
    await expect(error).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`from=${from}&to=${to}`));
    await expect(page.getByTestId("analytics-range-summary")).toContainText("31 days");
    await expect(kpiValue(page, "growth-new-companies")).toHaveText(fmt(data.companies.added.current));
    // The Apply button is white text on the brand orange.
    await expect(page.getByTestId("analytics-apply")).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(page.getByTestId("analytics-apply")).toHaveCSS("background-color", "rgb(255, 102, 0)");
  });

  test("group-by is sent to the API and a deep link restores the whole view", async ({ page }) => {
    await seedAs(page, platform);
    await openTab(page, "activity", "range=90d");
    const wait = page.waitForResponse((r) => isSection(r, "activity") && new URL(r.url()).searchParams.get("granularity") === "month");
    await page.getByTestId("analytics-granularity").click();
    await page.getByRole("option", { name: "Month" }).click();
    const data = await (await wait).json();
    expect(data.range.granularity).toBe("month");
    await expect(page).toHaveURL(/granularity=month/);
    await expect(page.getByTestId("analytics-range-summary")).toContainText("Monthly figures");

    // Reload the exact URL: tab, range and bucket size all come back.
    const url = page.url();
    const again = page.waitForResponse((r) => isSection(r, "activity") && r.status() === 200);
    await page.goto(url);
    const restored = new URL((await again).url());
    expect(restored.searchParams.get("granularity")).toBe("month");
    expect(restored.searchParams.get("from")).toBe(utcDay(-89));
    await expect(page.getByTestId("analytics-tab-activity")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("analytics-period")).toContainText("Last 90 days");
    await expect(page.getByTestId("analytics-granularity")).toContainText("Month");

    // A custom deep link opens with its dates in the form.
    const from = utcDay(-20);
    const to = utcDay(-3);
    await openTab(page, "operations", `from=${from}&to=${to}&granularity=week`);
    await expect(page.getByTestId("analytics-period")).toContainText("Custom range");
    await expect(page.getByTestId("analytics-from")).toHaveValue(from);
    await expect(page.getByTestId("analytics-to")).toHaveValue(to);
    await expect(page.getByTestId("analytics-range-summary")).toContainText("18 days");
  });

  test("daily grouping is not offered for a window the API would refuse, and a bad link falls back safely", async ({ page }) => {
    await seedAs(page, platform);
    const from = utcDay(-400);
    const to = utcDay(-1);
    // The link asks for daily buckets over 400 days: the page requests the automatic size instead.
    const { data, url } = await openTab(page, "growth", `from=${from}&to=${to}&granularity=day`);
    expect(url.searchParams.has("granularity")).toBe(false);
    expect(data.range).toMatchObject({ days: 400, granularity: "month" });
    await expect(page.getByTestId("analytics-granularity")).toContainText("Automatic");
    await page.getByTestId("analytics-granularity").click();
    await expect(page.getByRole("option", { name: "Day" })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");

    // Nonsense in the query string never breaks the page: it opens on the defaults.
    const fallback = await openTab(page, "overview", "tab=nope&range=5y&granularity=hour&from=2026-02-30&to=x");
    expect(fallback.data.range.days).toBe(30);
    await expect(page.getByTestId("analytics-tab-overview")).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("states", () => {
  test("loading: a skeleton, then the data — never a blank page", async ({ page }) => {
    await seedAs(page, platform);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route("**/api/platform/analytics/subscriptions**", async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto("/platform/analytics?tab=subscriptions");
    await expect(page.getByTestId("analytics-loading")).toBeVisible();
    await expect(page.getByTestId("analytics-loading")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("analytics-subscriptions")).toHaveCount(0);
    // The header, the filter and the tabs are usable while the data loads.
    await expect(page.getByTestId("analytics-filters")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Analytics sections" })).toBeVisible();
    release();
    await expect(page.getByTestId("analytics-subscriptions")).toBeVisible();
    await expect(page.getByTestId("analytics-loading")).toHaveCount(0);
  });

  test("error: an explanation and a working retry; the rest of the page keeps working", async ({ page }) => {
    await seedAs(page, platform);
    let fail = true;
    await page.route("**/api/platform/analytics/growth**", (route) =>
      fail ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal Server Error" }) }) : route.continue(),
    );
    await page.goto("/platform/analytics?tab=growth");
    const error = page.getByTestId("analytics-error");
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error.getByRole("alert")).toContainText("Analytics unavailable");
    await expect(error).toContainText("could not be loaded");
    await expect(page.getByTestId("analytics-growth")).toHaveCount(0);
    // No figure is shown in place of the failed request.
    await expect(page.locator("p.text-3xl")).toHaveCount(0);

    // Another tab is unaffected.
    await page.getByTestId("analytics-tab-operations").click();
    await expect(page.getByTestId("analytics-operations")).toBeVisible();
    await page.getByTestId("analytics-tab-growth").click();
    await expect(error).toBeVisible({ timeout: 20_000 });

    fail = false;
    await page.getByTestId("analytics-retry").click();
    await expect(page.getByTestId("analytics-growth")).toBeVisible();
    await expect(error).toHaveCount(0);
  });

  test("a refused window is explained as such", async ({ page }) => {
    await seedAs(page, platform);
    await page.route("**/api/platform/analytics/ai**", (route) =>
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Invalid from date", code: "INVALID_ANALYTICS_WINDOW" }) }),
    );
    await page.goto("/platform/analytics?tab=ai");
    await expect(page.getByTestId("analytics-error")).toContainText("This reporting window is not valid", { timeout: 20_000 });
  });

  test("stale: when a refresh fails the last figures stay on screen with a warning", async ({ page }) => {
    await seedAs(page, platform);
    const { data } = await openTab(page, "operations");
    await expect(kpiValue(page, "ops-kpi-audit")).toHaveText(fmt(data.auditEvents.total.current));
    await page.route("**/api/platform/analytics/operations**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) }));
    await page.getByTestId("analytics-refresh").click();
    const stale = page.getByTestId("analytics-stale");
    await expect(stale).toBeVisible({ timeout: 20_000 });
    await expect(stale).toHaveAttribute("role", "alert");
    await expect(stale).toContainText("Showing the last figures received");
    await expect(page.getByTestId("analytics-operations")).toBeVisible();
    await expect(kpiValue(page, "ops-kpi-audit")).toHaveText(fmt(data.auditEvents.total.current));

    await page.unroute("**/api/platform/analytics/operations**");
    await stale.getByTestId("analytics-retry").click();
    await expect(stale).toHaveCount(0);
    await expect(page.getByTestId("analytics-operations")).toBeVisible();
  });

  test("empty: a period with no activity shows zeros and plain-language empty states", async ({ page }) => {
    const errors = trackConsole(page);
    await seedAs(page, platform);
    const window = "from=1999-06-01&to=1999-06-07";

    const overview = (await openTab(page, "overview", window)).data;
    for (const key of ["newCompanies", "scans", "contacts", "leads", "aiRequests"]) expect(overview.period[key], key).toEqual({ current: 0, previous: 0 });
    for (const id of ["kpi-new-companies", "kpi-scans", "kpi-contacts", "kpi-leads", "kpi-ai-requests"]) {
      await expect(kpiValue(page, id)).toHaveText("0");
      await expect(page.getByTestId(id)).toContainText("None in either period");
      await expect(page.getByTestId(id)).not.toContainText("%");
    }
    await expect(page.getByTestId("overview-scans-chart").getByTestId("chart-empty")).toHaveText("No cards were scanned in this period.");
    await expect(page.getByTestId("overview-companies-chart").getByTestId("chart-empty")).toHaveText("No companies were created in this period.");
    await expect(page.getByTestId("overview-ai-cost")).toContainText("$0.00");

    await openTab(page, "activity", window);
    await expect(page.getByTestId("activity-chart-scans").getByTestId("chart-empty")).toBeVisible();
    await expect(page.getByTestId("activity-method-list-empty")).toHaveText("No cards were scanned in this period.");
    await expect(page.getByTestId("activity-top-companies")).toContainText("No company captured a card or a contact in this period.");
    await expect(page.getByTestId("activity-manual-entries")).toContainText("0 manual entries");

    await openTab(page, "ai", window);
    await expect(kpiValue(page, "ai-kpi-requests")).toHaveText("0");
    await expect(page.getByTestId("ai-requests-chart").getByTestId("chart-empty")).toHaveText("No AI requests were made in this period.");
    await expect(page.getByTestId("ai-by-feature")).toContainText("No AI requests were made in this period.");
    await expect(page.getByTestId("ai-failure-list-empty")).toHaveText("No AI request failed in this period.");

    await openTab(page, "operations", window);
    await expect(page.getByTestId("ops-signins-chart").getByTestId("chart-empty")).toHaveText("No sign-in attempts were recorded in this period.");
    await expect(page.getByTestId("ops-audit-list-empty")).toBeVisible();
    await expect(page.getByTestId("ops-security-list-empty")).toBeVisible();

    const subs = (await openTab(page, "subscriptions", window)).data;
    // The lifecycle is empty, but the snapshot "as of now" does not depend on the period.
    await expect(page.getByTestId("subs-lifecycle")).toContainText("No subscription changes were recorded in this period.");
    await expect(page.getByTestId("subs-plan-moves")).toContainText("No company changed plan in this period.");
    await expect(kpiValue(page, "subs-total")).toHaveText(fmt(subs.snapshot.total));

    await openTab(page, "revenue", window);
    await expect(page.getByTestId("revenue-payments-chart").getByTestId("chart-empty")).toHaveText("No payment notifications were received in this period.");
    await expect(page.getByTestId("revenue-checkout-list-empty")).toHaveText("No checkouts were started in this period.");
    expect(errors, errors.join("\n")).toEqual([]);
  });
});

test.describe("revenue is never overstated", () => {
  async function withRevenue(page: Page, patch: (real: any) => any) {
    const real = (await api("GET", `/platform/analytics/revenue?from=${utcDay(-29)}&to=${utcDay(0)}`, platform.token)).json;
    await page.route("**/api/platform/analytics/revenue**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(patch(real)) }));
    await page.goto("/platform/analytics?tab=revenue");
    await expect(page.getByTestId("analytics-revenue")).toBeVisible();
  }

  test("the live tab separates the estimate, collected revenue and actual billing events", async ({ page }) => {
    await seedAs(page, platform);
    const { data } = await openTab(page, "revenue");

    const estimate = page.getByTestId("revenue-estimate");
    await expect(estimate.getByRole("heading", { name: "Estimated recurring revenue" })).toBeVisible();
    await expect(estimate).toContainText("It is an estimate, not money received");
    if (data.estimate.snapshot.available) {
      await expect(kpiValue(page, "revenue-mrr")).toContainText(/\d/);
    } else {
      await expect(kpiValue(page, "revenue-mrr")).toHaveText("Unavailable");
      await expect(kpiValue(page, "revenue-arr")).toHaveText("Unavailable");
      // With no estimate there is no currency amount anywhere in the estimate block.
      await expect(estimate).not.toContainText(/[$€£]\s?\d/);
    }
    await expect(kpiValue(page, "revenue-priced")).toHaveText(fmt(data.estimate.snapshot.countedSubscriptions));
    await expect(kpiValue(page, "revenue-unpriced")).toHaveText(fmt(data.estimate.snapshot.unpricedSubscriptions));

    const collected = page.getByTestId("revenue-collected");
    await expect(collected).toContainText("Collected revenue is not available");
    await expect(collected).toContainText("not stored by this system");
    await expect(collected).toContainText("No amount is estimated in its place");
    await expect(collected).not.toContainText(/[$€£]\s?\d/);

    const activity = page.getByTestId("revenue-activity");
    await expect(activity).toContainText("Actual events · counts only");
    await expect(kpiValue(page, "revenue-kpi-paid")).toHaveText(fmt(data.paymentEvents.paid.current));
    await expect(kpiValue(page, "revenue-kpi-failed")).toHaveText(fmt(data.paymentEvents.failed.current));
    await expect(kpiValue(page, "revenue-kpi-checkouts")).toHaveText(fmt(data.checkouts.started.current));
    await expect(kpiValue(page, "revenue-kpi-events")).toHaveText(fmt(data.providerEvents.total.current));
    // Billing events are counts: no currency amount appears among them.
    await expect(activity).not.toContainText(/[$€£]\s?\d/);
  });

  test("an available estimate is shown as an estimate, with its caveat and its split by plan", async ({ page }) => {
    await seedAs(page, platform);
    await withRevenue(page, (real) => ({
      ...real,
      estimate: {
        basis: "verified_provider_prices",
        snapshot: { available: true, reason: "PARTIAL_UNPRICED", currency: "usd", monthlyRecurringMinor: 176600, countedSubscriptions: 14, unpricedSubscriptions: 1 },
        byPlan: [
          { planId: "business", planName: "Business", subscriptions: 7, monthlyRecurringMinor: 104300 },
          { planId: "starter", planName: "Starter", subscriptions: 7, monthlyRecurringMinor: 72300 },
        ],
      },
      paymentEvents: { ...real.paymentEvents, paid: { current: 17, previous: 14 }, failed: { current: 9, previous: 0 } },
    }));
    await expect(kpiValue(page, "revenue-mrr")).toHaveText("$1,766.00");
    await expect(page.getByTestId("revenue-mrr")).toContainText("an estimate");
    await expect(kpiValue(page, "revenue-arr")).toHaveText("$21,192.00");
    await expect(kpiValue(page, "revenue-priced")).toHaveText("14");
    await expect(kpiValue(page, "revenue-unpriced")).toHaveText("1");
    await expect(page.getByTestId("revenue-estimate-caveat")).toHaveText("Some provider subscriptions have no verified price and are not included.");
    await expect(page.getByTestId("revenue-plan-list-row-business")).toContainText("$1,043.00");
    await expect(page.getByTestId("revenue-plan-list-row-business")).toContainText("7 priced subscriptions");
    await expect(page.getByTestId("revenue-plan-list-row-starter")).toContainText("$723.00");
    await expect(page.getByTestId("revenue-by-plan")).toContainText("Estimate");
    // Collected revenue stays unavailable even when an estimate exists.
    await expect(page.getByTestId("revenue-collected")).toContainText("Collected revenue is not available");

    await expect(kpiValue(page, "revenue-kpi-paid")).toHaveText("17");
    await expect(page.getByTestId("revenue-kpi-paid")).toContainText("+21.4%");
    await expect(kpiValue(page, "revenue-kpi-failed")).toHaveText("9");
    await expect(page.getByTestId("revenue-kpi-failed")).toContainText("None in the previous period");
    await expect(page.getByTestId("revenue-kpi-failed")).not.toContainText("%");
  });

  test("an unavailable estimate shows no amount at all, only the reason", async ({ page }) => {
    await seedAs(page, platform);
    await withRevenue(page, (real) => ({
      ...real,
      estimate: {
        basis: "verified_provider_prices",
        // Stray numbers must not be rendered once the API marks the estimate unavailable.
        snapshot: { available: false, reason: "NO_VERIFIED_PRICES", currency: "usd", monthlyRecurringMinor: 999900, countedSubscriptions: 0, unpricedSubscriptions: 3 },
        byPlan: [{ planId: "business", planName: "Business", subscriptions: 7, monthlyRecurringMinor: 104300 }],
      },
    }));
    await expect(kpiValue(page, "revenue-mrr")).toHaveText("Unavailable");
    await expect(page.getByTestId("revenue-mrr")).toContainText("No verified provider prices are registered.");
    await expect(kpiValue(page, "revenue-arr")).toHaveText("Unavailable");
    await expect(page.getByTestId("revenue-by-plan")).toContainText("No verified provider prices are registered.");
    await expect(page.getByTestId("revenue-plan-list")).toHaveCount(0);
    await expect(page.getByTestId("analytics-revenue")).not.toContainText(/[$€£]\s?\d/);
    await expect(page.getByTestId("analytics-revenue")).not.toContainText("9,999");
    await expect(page.getByTestId("analytics-revenue")).not.toContainText("1,043");
  });
});

test.describe("access", () => {
  test("a tenant admin cannot open the page or read its data", async ({ page }) => {
    const analyticsResponses: number[] = [];
    page.on("response", (r) => {
      if (sectionOf(r.url())) analyticsResponses.push(r.status());
    });
    await seedAs(page, tenant);
    await page.goto("/platform/analytics?tab=revenue");
    await expect(page).toHaveURL(/\/admin(\/|$|\?)/);
    await expect(page.getByTestId("platform-analytics")).toHaveCount(0);
    expect(analyticsResponses.filter((s) => s === 200)).toEqual([]);

    for (const tab of TABS) {
      const res = await api("GET", `/platform/analytics/${tab}`, tenant.token);
      expect(res.status, tab).toBe(403);
      expect(res.json?.range, tab).toBeUndefined();
    }
  });

  test("a signed-out visitor is sent to sign in", async ({ page }) => {
    await page.goto("/platform/analytics");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId("platform-analytics")).toHaveCount(0);
    expect((await api("GET", "/platform/analytics/overview")).status).toBe(401);
  });
});

test.describe("keyboard and semantics", () => {
  test("tabs, filters and regions are operable from the keyboard and correctly named", async ({ page }) => {
    await seedAs(page, platform);
    await openTab(page, "overview");

    const tablist = page.getByRole("tablist", { name: "Analytics sections" });
    await expect(tablist.getByRole("tab")).toHaveText(["Overview", "Growth", "Subscriptions", "Revenue & billing", "Activity", "AI usage", "Operations"]);
    const overviewTab = page.getByRole("tab", { name: "Overview" });
    await expect(overviewTab).toHaveAttribute("aria-selected", "true");
    // The selected tab is white text on the brand orange.
    await expect(overviewTab).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(overviewTab).toHaveCSS("background-color", "rgb(255, 102, 0)");
    await expect(page.getByRole("tab", { name: "Growth" })).not.toHaveCSS("background-color", "rgb(255, 102, 0)");

    await overviewTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Growth" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Growth" })).toBeFocused();
    await expect(page).toHaveURL(/tab=growth/);
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", /.+/);
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: "Operations" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("analytics-operations")).toBeVisible();
    await page.keyboard.press("Home");
    await expect(overviewTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("analytics-overview")).toBeVisible();

    // Filters have visible, programmatic labels.
    await expect(page.getByRole("region", { name: "Reporting period" })).toBeVisible();
    await expect(page.getByLabel("Period", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Group by", { exact: true })).toBeVisible();
    await page.getByLabel("Period", { exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: "Last 90 days" })).toBeVisible();
    await page.keyboard.press("Escape");

    // One h1; sections and charts are named.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Card scans" })).toBeVisible();
    await expect(page.getByRole("figure", { name: "Card scans over time" }).or(page.getByTestId("overview-scans-chart").getByTestId("chart-empty"))).toBeVisible();
    await expect(page.getByRole("img", { name: /^Subscriptions by status:/ })).toBeVisible();
    await expect(page.getByRole("list", { name: "Subscriptions by status" })).toBeVisible();

    // The chart/table switch is reachable and operable without a pointer.
    const tableButton = page.getByTestId("overview-scans-chart").getByRole("button", { name: "Table" });
    await tableButton.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Card scans per period" })).toBeVisible();
  });
});

for (const vp of VIEWPORTS) {
  test(`layout holds on every tab at ${vp.name}`, async ({ page }) => {
    test.setTimeout(150_000);
    const errors = trackConsole(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await seedAs(page, platform);

    for (const tab of TABS) {
      await openTab(page, tab);
      await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
      await expect(page.getByTestId("analytics-period")).toBeVisible();
      await expect(page.getByTestId("analytics-granularity")).toBeVisible();
      // Charts have had time to size themselves.
      await page.waitForTimeout(300);

      // Nothing makes the page scroll sideways.
      expect(await overflow(page), `${tab} at ${vp.name}`).toEqual({ document: 0, main: 0 });

      // Every card stays inside the content column.
      const boxes = await page.getByTestId(`analytics-${tab}`).locator("section, [data-testid^='kpi-'], [data-testid*='-kpi-']").evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: Math.floor(r.left), right: Math.ceil(r.right), width: Math.round(r.width) };
        }),
      );
      expect(boxes.length, `${tab} at ${vp.name}`).toBeGreaterThan(0);
      for (const b of boxes) {
        expect(b.left, `${tab} at ${vp.name}`).toBeGreaterThanOrEqual(0);
        expect(b.right, `${tab} at ${vp.name}`).toBeLessThanOrEqual(vp.width);
        expect(b.width, `${tab} at ${vp.name}`).toBeGreaterThan(120);
      }

      // The open tab is in view, including when the tab bar has to scroll (narrow screens).
      const active = await page.getByTestId(`analytics-tab-${tab}`).boundingBox();
      expect(active, tab).not.toBeNull();
      expect(active!.x, `${tab} tab at ${vp.name}`).toBeGreaterThanOrEqual(0);
      expect(active!.x + active!.width, `${tab} tab at ${vp.name}`).toBeLessThanOrEqual(vp.width);

      if (SHOTS) {
        const height = await page.evaluate(() => document.querySelector("main")?.scrollHeight ?? document.body.scrollHeight);
        await page.setViewportSize({ width: vp.width, height: Math.min(Math.max(height + 140, vp.height), 9000) });
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SHOTS, `${tab}-${vp.name}.png`) });
        await page.setViewportSize({ width: vp.width, height: vp.height });
      }
    }

    const scroller = page.getByTestId("analytics-tabs-scroller");
    const scroll = await scroller.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    if (vp.width >= 1440) {
      // Desktop: all seven tabs fit without scrolling.
      expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth);
    } else if (vp.width <= 390) {
      // Phone: the bar scrolls inside itself, and a tab at the far end can be reached and opened.
      expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
      await openTab(page, "overview");
      await page.getByTestId("analytics-tab-operations").scrollIntoViewIfNeeded();
      await page.getByTestId("analytics-tab-operations").click();
      await expect(page.getByTestId("analytics-operations")).toBeVisible();
    }

    // The table view of a chart scrolls inside its own card, not the page.
    await openTab(page, "subscriptions");
    await page.getByTestId("subs-trend").getByRole("button", { name: "Table" }).click();
    await expect(page.getByTestId("subs-trend-table")).toBeVisible();
    expect(await overflow(page), `subscription table view at ${vp.name}`).toEqual({ document: 0, main: 0 });

    // Filters stay usable: the custom range form fits the width.
    await page.getByTestId("analytics-period").click();
    await page.getByRole("option", { name: "Custom range" }).click();
    for (const id of ["analytics-from", "analytics-to", "analytics-apply"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(box!.x, `${id} at ${vp.name}`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${id} at ${vp.name}`).toBeLessThanOrEqual(vp.width);
    }
    expect(await overflow(page), `custom range at ${vp.name}`).toEqual({ document: 0, main: 0 });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

test("the dark theme renders every tab without layout or console problems", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackConsole(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedAs(page, platform, "dark");
  for (const tab of TABS) {
    await openTab(page, tab);
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await overflow(page), tab).toEqual({ document: 0, main: 0 });
    // The selected tab keeps white text on orange in the dark theme too.
    await expect(page.getByTestId(`analytics-tab-${tab}`)).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(page.getByTestId(`analytics-tab-${tab}`)).toHaveCSS("background-color", "rgb(255, 102, 0)");
    if (SHOTS && (tab === "overview" || tab === "revenue")) {
      const height = await page.evaluate(() => document.querySelector("main")?.scrollHeight ?? document.body.scrollHeight);
      await page.setViewportSize({ width: 1440, height: Math.min(Math.max(height + 140, 900), 9000) });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, `${tab}-dark-1440.png`) });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  }
  expect(errors, errors.join("\n")).toEqual([]);
});

test.beforeAll(() => {
  if (SHOTS && !fs.existsSync(SHOTS)) throw new Error(`G7_SHOTS_DIR does not exist: ${SHOTS}`);
});
