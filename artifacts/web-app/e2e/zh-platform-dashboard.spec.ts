import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/workspace";
import { API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * ZH. G-7 — the Platform Dashboard (/platform) uses the same definitions as Platform Owner
 * Analytics: Total Users are company users that exist today, every capture is told apart
 * from the card scans sent for OCR, and money is formatted in the currency's own minor unit.
 *
 * Figures are compared with the API's own answer (the oracle); the currency cases intercept
 * the single stats request because a local database holds one currency at most.
 *
 * Launch polish: the same six metric cards, charts and company table in the approved visual
 * system — the cards now sit two or three to a row so no label is cut and a long amount stays
 * inside its card, the dark card is readable throughout, the status list is the chart's
 * legend (nothing overlaps it), and Recent Companies leads with the newest tenants.
 *
 * Set G7_SHOTS_DIR to an existing directory to also save screenshots (off by default).
 */

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const SHOTS = process.env.G7_SHOTS_DIR;
type Auth = { token: string; user: { id: number; companyId: number | null; email: string } };
let platform: Auth;
let pg: Client;
const NEWEST = [`${RUN_TAG} ZH Newest A`, `${RUN_TAG} ZH Newest B`];

/** The companies the sorting test creates must not stay behind. */
async function purge() {
  const companies = await pg.query("select id from companies where name = any($1)", [NEWEST]);
  for (const { id } of companies.rows) {
    await pg.query("delete from audit_logs where company_id = $1", [id]);
    await pg.query("delete from users where company_id = $1", [id]);
    await pg.query("delete from subscriptions where company_id = $1", [id]);
    await pg.query("delete from companies where id = $1", [id]);
  }
}

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

/**
 * WCAG contrast of every label, figure, footer text and icon inside an element, against the
 * background each sits on. Colours are resolved by painting them (computed styles may be
 * rgb(), oklab() or color-mix()), so the figures are what the eye gets.
 */
async function contrastsIn(page: Page, testId: string): Promise<Array<{ what: string; ratio: number; icon: boolean }>> {
  return page.getByTestId(testId).evaluate((root) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const cx = cv.getContext("2d", { willReadFrequently: true })!;
    const rgba = (c: string) => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "rgba(0,0,0,0)";
      cx.fillStyle = c;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    };
    type C = { r: number; g: number; b: number; a: number };
    const over = (f: C, b: C): C => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
    const lum = (c: C) => {
      const f = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const backgroundOf = (el: Element): C => {
      const stack: C[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        if (c.a > 0) {
          stack.push(c);
          if (c.a >= 1) break;
        }
      }
      let base: C = { r: 255, g: 255, b: 255, a: 1 };
      for (const c of stack.reverse()) base = over(c, base);
      return base;
    };
    const ratioOf = (el: Element) => {
      const bg = backgroundOf(el);
      const a = lum(over(rgba(getComputedStyle(el).color), bg));
      const b = lum(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const out: Array<{ what: string; ratio: number; icon: boolean }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? "").trim();
      if (text && n.parentElement && !n.parentElement.closest("svg")) out.push({ what: text.slice(0, 30), ratio: ratioOf(n.parentElement), icon: false });
    }
    for (const svg of root.querySelectorAll("svg")) out.push({ what: "icon", ratio: ratioOf(svg), icon: true });
    return out;
  });
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

const ALL_STATUSES = ["trialing", "active", "past_due", "cancelled", "expired", "suspended"] as const;

/** Opens the dashboard with every subscription status present (a local database rarely has all six). */
async function openWithAllStatuses(page: Page) {
  const real = (await api("GET", "/platform/stats", platform.token)).json;
  const byStatus = ALL_STATUSES.map((status, i) => ({ status, count: [6, 21, 4, 3, 2, 5][i] }));
  await page.route("**/api/platform/stats", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...real, subscriptions: { ...real.subscriptions, byStatus } }) }),
  );
  await page.goto("/platform");
  await expect(page.getByTestId("platform-dashboard")).toBeVisible();
  await expect(page.getByTestId("dashboard-status-legend").locator("li")).toHaveCount(ALL_STATUSES.length);
  await expect(page.getByTestId("dashboard-subscription-status").locator(".recharts-pie-sector path")).toHaveCount(ALL_STATUSES.length);
}

/** Painted colours of the legend dots and of the ring segments, as [r, g, b]. */
async function statusColours(page: Page) {
  return page.getByTestId("dashboard-subscription-status").evaluate((root) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const cx = cv.getContext("2d", { willReadFrequently: true })!;
    const paint = (c: string) => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = c;
      cx.fillRect(0, 0, 1, 1);
      return Array.from(cx.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    return {
      dots: [...root.querySelectorAll("[data-testid='dashboard-status-legend'] span[aria-hidden='true']")].map((el) => paint(getComputedStyle(el).backgroundColor)),
      segments: [...root.querySelectorAll(".recharts-pie-sector path")].map((el) => paint(getComputedStyle(el).fill)),
    };
  });
}

test.beforeAll(async () => {
  if (SHOTS && !fs.existsSync(SHOTS)) throw new Error(`G7_SHOTS_DIR does not exist: ${SHOTS}`);
  const res = await api("POST", "/auth/login", null, PLATFORM);
  expect(res.status, res.text).toBe(200);
  platform = { token: res.json.token, user: res.json.user };
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  await purge();
});

test.afterAll(async () => {
  await purge();
  await pg.end();
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
  // The card is dark; its label, icon, figure and footer must all be readable on it (the
  // figure used to be dark on dark, the label and icon were low-contrast).
  const onDarkCard = await contrastsIn(page, "dashboard-total-captures");
  expect(onDarkCard.map((c) => c.what)).toEqual(expect.arrayContaining(["Total Captures", fmt(stats.totalCaptures), "icon"]));
  for (const c of onDarkCard) expect(c.ratio, `${c.what} ${c.ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(c.icon ? 3 : 4.5);
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

test("Recent Companies lists the five newest tenants, newest first", async ({ page }) => {
  // Two tenants onboarded now are the two newest; the later one leads.
  for (const name of NEWEST) {
    const created = await api("POST", "/companies", platform.token, { name, plan: "free", industry: "QA" });
    expect(created.status, created.text).toBe(201);
  }
  await seedAs(page, platform);
  const wait = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/companies") && r.status() === 200);
  await openDashboard(page);
  const listed = (await (await wait).json()).companies as Array<{ id: number; name: string; createdAt: string }>;
  expect(listed).toHaveLength(5);
  expect(listed.slice(0, 2).map((c) => c.name)).toEqual([NEWEST[1], NEWEST[0]]);

  // Newest first all the way down, and they are the five newest of every company there is.
  const newestFirst = (a: { id: number; createdAt: string }, b: { id: number; createdAt: string }) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id - a.id;
  expect(listed.map((c) => c.id)).toEqual([...listed].sort(newestFirst).map((c) => c.id));
  const newest = await pg.query("select id from companies order by created_at desc, id desc limit 5");
  expect(listed.map((c) => c.id)).toEqual(newest.rows.map((r) => r.id));

  // The page shows them in that order and says what the list is.
  const card = page.getByTestId("platform-dashboard").locator("table").locator("xpath=ancestor::div[contains(@class,'rounded-xl') or contains(@class,'shadow-sm')][1]");
  await expect(card).toContainText("The five tenants onboarded most recently");
  const rows = page.getByTestId("platform-dashboard").locator("table tbody tr");
  await expect(rows).toHaveCount(5);
  for (const [i, c] of listed.entries()) await expect(rows.nth(i).locator("td").first()).toHaveText(c.name);
  await expect(page.getByTestId("platform-dashboard").getByText("Latest onboarded tenants")).toHaveCount(0);
});

test("the status list is the legend of the ring and matches the API's counts", async ({ page }) => {
  await seedAs(page, platform);
  const stats = await openDashboard(page);
  const statuses = (stats.subscriptions.byStatus as Array<{ status: string; count: number }>).filter((s) => s.count > 0);
  expect(statuses.length).toBeGreaterThan(0);
  const card = page.getByTestId("dashboard-subscription-status");

  // One row per status with its count and a colour dot; no second, chart-drawn legend.
  await expect(card.locator(".recharts-legend-wrapper")).toHaveCount(0);
  await expect(page.getByTestId("dashboard-status-legend").locator("li")).toHaveCount(statuses.length);
  for (const s of statuses) {
    const row = page.getByTestId(`status-count-${s.status}`);
    await expect(row.locator("span.tabular-nums")).toHaveText(String(s.count));
    await expect(row.locator("span[aria-hidden='true']")).toHaveCount(1);
  }
  await expect(card.locator(".recharts-pie-sector path")).toHaveCount(statuses.length);
  const colours = await statusColours(page);
  expect(colours.dots).toEqual(colours.segments);
});

for (const theme of ["light", "dark"] as const) {
  test(`six statuses wear six clearly different colours in the ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedAs(page, platform, theme);
    await openWithAllStatuses(page);
    const { dots, segments } = await statusColours(page);
    expect(dots).toHaveLength(ALL_STATUSES.length);
    // Each dot is the colour of its ring segment.
    expect(dots).toEqual(segments);
    // "Past due" used to be the very red of "Suspended". Now no two statuses share a colour,
    // and Past due is never the closest pair: it is further from every other status than the
    // two closest colours of the palette as it was (Trialing's navy and Expired's grey).
    const pairs: Array<{ pair: string; distance: number; pastDue: boolean }> = [];
    for (let a = 0; a < dots.length; a++) {
      for (let b = a + 1; b < dots.length; b++) {
        const distance = Math.hypot(dots[a][0] - dots[b][0], dots[a][1] - dots[b][1], dots[a][2] - dots[b][2]);
        pairs.push({ pair: `${ALL_STATUSES[a]} vs ${ALL_STATUSES[b]}`, distance, pastDue: ALL_STATUSES[a] === "past_due" || ALL_STATUSES[b] === "past_due" });
      }
    }
    for (const p of pairs) expect(p.distance, p.pair).toBeGreaterThan(40);
    const closest = [...pairs].sort((x, y) => x.distance - y.distance)[0];
    expect(closest.pastDue, `closest pair: ${closest.pair} (${closest.distance.toFixed(0)})`).toBe(false);
    for (const p of pairs.filter((x) => x.pastDue)) expect(p.distance, p.pair).toBeGreaterThan(65);
    expect(pairs.find((p) => p.pair === "past_due vs suspended")!.distance).toBeGreaterThan(100);
    if (SHOTS) await page.getByTestId("dashboard-subscription-status").screenshot({ path: path.join(SHOTS, `status-card-${theme}.png`) });
  });
}

for (const width of [1440, 1280, 1279, 1024, 820, 768, 390, 320]) {
  test(`the status ring and its legend are whole at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await seedAs(page, platform);
    await openWithAllStatuses(page);
    // The ring animates in: measure it once its box has stopped changing (a fixed pause
    // measured it mid-animation on a busy machine).
    const ringWidth = () => page.getByTestId("dashboard-subscription-status").locator(".recharts-pie").evaluate((el) => Math.round(el.getBoundingClientRect().width));
    let lastWidth = -1;
    await expect
      .poll(
        async () => {
          const now = await ringWidth();
          const stable = now === lastWidth;
          lastWidth = now;
          return stable;
        },
        { timeout: 8000, intervals: [250] },
      )
      .toBe(true);
    const m = await page.getByTestId("dashboard-subscription-status").evaluate((root) => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
      };
      const revenue = document.querySelector("[data-testid='dashboard-revenue-trend']")!;
      return {
        card: box(root),
        revenue: box(revenue),
        chart: box(root.querySelector(".recharts-wrapper")!),
        ring: box(root.querySelector(".recharts-pie")!),
        rows: [...root.querySelectorAll("[data-testid='dashboard-status-legend'] li")].map(box),
        cutNames: [...root.querySelectorAll("[data-testid='dashboard-status-legend'] span.truncate")].map((el) => el.scrollWidth - el.clientWidth),
        names: [...root.querySelectorAll("[data-testid='dashboard-status-legend'] span.truncate")].map((el) => el.textContent),
      };
    });

    // The whole ring is inside the chart area (it used to be clipped to two arcs in a 130 px card).
    expect(m.ring.left, "ring left").toBeGreaterThanOrEqual(m.chart.left);
    expect(m.ring.right, "ring right").toBeLessThanOrEqual(m.chart.right);
    expect(m.ring.top, "ring top").toBeGreaterThanOrEqual(m.chart.top);
    expect(m.ring.bottom, "ring bottom").toBeLessThanOrEqual(m.chart.bottom);
    expect(m.ring.right - m.ring.left, "ring width").toBeGreaterThanOrEqual(150);

    // Every status name is written in full, and the rows sit below the ring, inside the card, one under another.
    expect(m.names).toEqual(["Trialing", "Active", "Past due", "Cancelled", "Expired", "Suspended"]);
    expect(m.cutNames).toEqual([0, 0, 0, 0, 0, 0]);
    let floor = m.chart.bottom;
    for (const [i, row] of m.rows.entries()) {
      expect(row.top, `row ${i}`).toBeGreaterThanOrEqual(floor);
      expect(row.left, `row ${i}`).toBeGreaterThanOrEqual(m.card.left);
      expect(row.right, `row ${i}`).toBeLessThanOrEqual(m.card.right);
      floor = row.bottom;
    }
    expect(floor, "legend bottom").toBeLessThanOrEqual(m.card.bottom);

    // Beside the revenue chart only where there is room for it; otherwise beneath it.
    if (width >= 1280) expect(m.card.left, "side by side").toBeGreaterThanOrEqual(m.revenue.right);
    else expect(m.card.top, "stacked").toBeGreaterThanOrEqual(m.revenue.bottom);
  });
}

for (const vp of [
  { name: "desktop-1440", width: 1440 },
  { name: "laptop-1280", width: 1280 },
  { name: "laptop-1024", width: 1024 },
  { name: "tablet-820", width: 820 },
  { name: "tablet-768", width: 768 },
  { name: "mobile-390", width: 390 },
  { name: "small-320", width: 320 },
] as const) {
  /** How a money figure sits in its card: lines of text, size, and room left on each side. */
  const figure = (page: Page, id: string) =>
    value(page, id).evaluate((el) => {
      const card = el.closest(".rounded-lg")!.getBoundingClientRect();
      const holder = el.querySelector("span") ?? el;
      const range = document.createRange();
      range.selectNodeContents(holder);
      const text = range.getBoundingClientRect();
      const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
      return { lines: tops.size, size: parseFloat(getComputedStyle(holder).fontSize), left: Math.round(text.left - card.left), right: Math.round(card.right - text.right), below: Math.round(card.bottom - text.bottom) };
    });

  test(`an ordinary amount keeps the full figure size and a six-figure one stays on one line at ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: 900 });
    await seedAs(page, platform);
    const snapshot = (currency: string, monthlyRecurringMinor: number) => ({ available: true, reason: null, currency, monthlyRecurringMinor, countedSubscriptions: 3, unpricedSubscriptions: 0 });

    // $1,766.00 / $21,192.00: set exactly like the other figures of the row.
    await openWithRevenue(page, snapshot("usd", 176600));
    const other = await value(page, "dashboard-total-users").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    for (const id of ["dashboard-mrr", "dashboard-arr"]) {
      const f = await figure(page, id);
      expect(f.size, `${id} ${vp.name}`).toBe(other);
      expect(f.lines, `${id} ${vp.name}`).toBe(1);
    }

    // SAR 123,456.78 / SAR 1,481,481.36: one line, inside the card, never split mid-number.
    await page.unroute("**/api/platform/stats");
    await openWithRevenue(page, snapshot("sar", 12_345_678));
    await expect(value(page, "dashboard-mrr")).toHaveText("SAR 123,456.78");
    await expect(value(page, "dashboard-arr")).toHaveText("SAR 1,481,481.36");
    for (const id of ["dashboard-mrr", "dashboard-arr"]) {
      const f = await figure(page, id);
      expect(f.lines, `${id} ${vp.name}`).toBe(1);
      expect(f.left, `${id} ${vp.name}`).toBeGreaterThan(0);
      expect(f.right, `${id} ${vp.name}`).toBeGreaterThan(0);
      expect(f.size, `${id} ${vp.name}`).toBeGreaterThanOrEqual(16);
      expect(f.size, `${id} ${vp.name}`).toBeLessThanOrEqual(other);
    }
    // The cards of the row keep one height, whatever the size of the figure.
    const heights = await page.getByTestId("dashboard-metrics").locator(":scope > *").evaluateAll((els) => {
      const rows = new Map<number, Set<number>>();
      for (const el of els) {
        const r = el.getBoundingClientRect();
        rows.set(Math.round(r.top), (rows.get(Math.round(r.top)) ?? new Set()).add(Math.round(r.height)));
      }
      return [...rows.values()].map((set) => set.size);
    });
    for (const distinct of heights) expect(distinct, vp.name).toBe(1);
  });

  test(`a very long recurring amount stays inside its card at ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: 900 });
    await seedAs(page, platform);
    // 9.9 billion a month: an ARR of fifteen digits and separators.
    await openWithRevenue(page, { available: true, reason: null, currency: "sar", monthlyRecurringMinor: 987_654_321_012, countedSubscriptions: 3, unpricedSubscriptions: 0 });
    await expect(value(page, "dashboard-mrr")).toHaveText("SAR 9,876,543,210.12");
    await expect(value(page, "dashboard-arr")).toHaveText("SAR 118,518,518,521.44");
    for (const id of ["dashboard-mrr", "dashboard-arr"]) {
      const fit = await value(page, id).evaluate((el) => {
        const card = el.closest(".rounded-lg")!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const text = range.getBoundingClientRect();
        return { left: Math.round(text.left - card.left), right: Math.round(card.right - text.right), below: Math.round(card.bottom - text.bottom), clipped: el.scrollWidth - el.clientWidth };
      });
      expect(fit.left, `${id} ${vp.name}`).toBeGreaterThan(0);
      expect(fit.right, `${id} ${vp.name}`).toBeGreaterThan(0);
      expect(fit.below, `${id} ${vp.name}`).toBeGreaterThan(0);
      expect(fit.clipped, `${id} ${vp.name}`).toBeLessThanOrEqual(0);
    }
    const overflow = await page.evaluate(() => {
      const main = document.querySelector("main");
      return { document: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
    });
    expect(overflow, vp.name).toEqual({ document: 0, main: 0 });
    if (SHOTS) await page.getByTestId("dashboard-metrics").screenshot({ path: path.join(SHOTS, `dashboard-long-amount-${vp.name}.png`) });
  });
}

for (const vp of [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "tablet-820", width: 820, height: 1180 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "small-320", width: 320, height: 700 },
] as const) {
  test(`the dashboard keeps its design and fits ${vp.name}`, async ({ page }) => {
    const errors = trackConsole(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await seedAs(page, platform);
    await openDashboard(page);
    await page.waitForTimeout(300);

    // The same six metric cards, in the same order — two, then three to a row.
    const metrics = page.getByTestId("dashboard-metrics");
    const labels = metrics.locator("p.text-sm.font-medium");
    expect(await labels.allInnerTexts()).toEqual(["Total Companies", "Total Users", "MRR", "ARR", "Total Leads", "Total Captures"]);
    for (const id of ["dashboard-revenue-trend", "dashboard-subscription-status", "dashboard-scan-trend"]) await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Platform Dashboard" })).toBeVisible();
    const cells = metrics.locator(":scope > *");
    await expect(cells).toHaveCount(6);
    const columns = new Set(await cells.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)))).size;
    expect(columns, vp.name).toBe(vp.width >= 1280 ? 3 : vp.width >= 640 ? 2 : 1);

    // No label is cut off, and no figure runs past its card.
    for (const [i, label] of (await labels.all()).entries()) {
      const cut = await label.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(cut, `label ${i} at ${vp.name}`).toBeLessThanOrEqual(0);
    }
    const figures = await metrics.locator("p.text-3xl").evaluateAll((els) =>
      els.map((el) => {
        const card = el.closest(".rounded-lg")!.getBoundingClientRect();
        // The text itself (a range) — the paragraph box is as wide as the card by definition.
        const range = document.createRange();
        range.selectNodeContents(el);
        return Math.round(range.getBoundingClientRect().right - card.right);
      }),
    );
    for (const [i, past] of figures.entries()) expect(past, `figure ${i} at ${vp.name}`).toBeLessThan(0);

    // Every card fills its grid cell, so the cards of a row are equally tall.
    const fills = await cells.evaluateAll((els) =>
      els.map((el) => {
        const card = el.classList.contains("rounded-lg") ? el : el.firstElementChild!;
        return Math.round(el.getBoundingClientRect().height - card.getBoundingClientRect().height);
      }),
    );
    expect(fills, vp.name).toEqual([0, 0, 0, 0, 0, 0]);
    const rowHeights = await cells.evaluateAll((els) => {
      const rows = new Map<number, Set<number>>();
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const card = (el.classList.contains("rounded-lg") ? el : el.firstElementChild!).getBoundingClientRect();
        rows.set(Math.round(r.top), (rows.get(Math.round(r.top)) ?? new Set()).add(Math.round(card.height)));
      }
      return [...rows.values()].map((s) => s.size);
    });
    for (const distinct of rowHeights) expect(distinct, vp.name).toBe(1);

    // "View all" stays on one line beside the card title.
    const link = page.getByRole("link", { name: "View all" });
    expect(await link.evaluate((el) => el.getClientRects().length), vp.name).toBe(1);

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

for (const theme of ["light", "dark"] as const) {
  test(`labels, figures and icons of the metric cards are readable in the ${theme} theme`, async ({ page }) => {
    const errors = trackConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedAs(page, platform, theme);
    await openDashboard(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
    await page.waitForTimeout(300);

    const found = await contrastsIn(page, "dashboard-metrics");
    // Six labels, six figures, six icons at least.
    expect(found.filter((c) => c.icon).length).toBeGreaterThanOrEqual(6);
    expect(found.filter((c) => !c.icon).length).toBeGreaterThanOrEqual(12);
    for (const c of found) expect(c.ratio, `${theme}: ${c.what} ${c.ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(c.icon ? 3 : 4.5);

    // The status list and the company table, too.
    for (const c of await contrastsIn(page, "dashboard-status-legend")) {
      if (c.what === "icon") continue;
      expect(c.ratio, `${theme}: legend ${c.what} ${c.ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }

    if (SHOTS && theme === "dark") {
      const height = await page.evaluate(() => document.querySelector("main")?.scrollHeight ?? document.body.scrollHeight);
      await page.setViewportSize({ width: 1440, height: Math.min(Math.max(height + 140, 900), 7800) });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, "dashboard-desktop-1440-dark.png") });
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
