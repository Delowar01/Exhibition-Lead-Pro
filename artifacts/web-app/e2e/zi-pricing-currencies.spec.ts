import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/workspace";
import { API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * ZI. Launch pricing correctness — one currency policy on every pricing screen.
 *
 * Runs against the local stack with the deterministic FAKE billing provider: no real
 * price, checkout session, invoice or payment is ever created. The API is the oracle for
 * what was stored; the browser is checked for what is shown and what is sent.
 *
 *   • a manual price typed in US dollars, Saudi riyals, yen, Icelandic krónur, forints and
 *     Kuwaiti dinars is stored as the right number of minor units, and comes back as typed
 *     when the editor is opened again — and saving it untouched changes nothing;
 *   • an amount that cannot be converted exactly, and a currency the provider does not
 *     support, are refused in the editor: nothing is sent;
 *   • a stored price in an unsupported currency is never shown as if it had two decimals
 *     and is kept exactly as stored;
 *   • the AI cost allowance (US dollars) is converted exactly, and a figure that cannot be
 *     is refused instead of being saved as "no allowance";
 *   • verified provider prices show each currency in its own unit on the platform's
 *     Subscriptions and Plans pages, in the version's price mappings and on the tenant's
 *     Subscription page; the version comparison shows amounts, not raw minor units;
 *   • the pricing screens are the platform owner's: a tenant administrator is refused;
 *   • the editor and the published view fit a tablet, a phone and the dark theme.
 *
 * Set LP_SHOTS_DIR to an existing directory to also save screenshots (off by default).
 */

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const TENANT_DEMO = { email: "admin@techcorp.com", password: "Admin123!" };
const PASSWORD = "PricingQa123!";
const SUFFIX = Date.now().toString(36);
const SLUG = `zi-${SUFFIX}`;
const PLAN_NAME = `Currencies ${SUFFIX}`;
const COMPANY_NAME = `${RUN_TAG} ZI Pricing Co`;
const ADMIN_EMAIL = `${RUN_TAG.toLowerCase()}.zi-admin@example.test`;
const SHOTS = process.env.LP_SHOTS_DIR;

/** What is typed, what must be stored, what the field shows on reopening, and how it reads. */
const MANUAL = [
  { currency: "usd", interval: "Month", typed: "49.00", minor: 4900, reopened: "49.00", reads: "$49.00" },
  { currency: "sar", interval: "Year", typed: "1250.5", minor: 125050, reopened: "1250.50", reads: "SAR 1,250.50" },
  { currency: "jpy", interval: "Month", typed: "5000", minor: 5000, reopened: "5000", reads: "¥5,000" },
  { currency: "isk", interval: "Month", typed: "500", minor: 50000, reopened: "500", reads: "ISK 500" },
  { currency: "huf", interval: "Month", typed: "4900", minor: 490000, reopened: "4900.00", reads: "HUF 4,900.00" },
  { currency: "kwd", interval: "Month", typed: "10.5", minor: 10500, reopened: "10.500", reads: "KWD 10.500" },
] as const;

/** Provider prices, synthesized by the fake provider from their ids (currency, minor units, interval). */
const PROVIDER = [
  { id: "price_fake_usd_4917_month", reads: "$49.17" },
  { id: "price_fake_sar_37517_month", reads: "SAR 375.17" },
  { id: "price_fake_jpy_5017_month", reads: "¥5,017" },
  { id: "price_fake_isk_51700_month", reads: "ISK 517" },
  { id: "price_fake_huf_491700_month", reads: "HUF 4,917.00" },
  { id: "price_fake_kwd_10517_month", reads: "KWD 10.517" },
] as const;

type Auth = { token: string; user: { id: number; companyId: number | null; email: string } };
let platform: Auth;
let tenantAdmin: Auth;
let pg: Client;
let v1Id = 0;
let draftId = 0;
let nextDraftId = 0;
let companyId = 0;
const priceRowIds: number[] = [];

test.describe.configure({ mode: "serial" });

async function api(method: string, p: string, body?: unknown, token: string | null = null) {
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
  const res = await api("POST", "/auth/login", { email, password });
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
/** Viewport-safe Radix select helper (as in the plan-builder specs). */
async function pickOption(page: Page, trigger: string, name: string | RegExp) {
  const t = page.getByTestId(trigger);
  await expect(t).toBeVisible();
  for (let attempt = 1; attempt <= 5; attempt++) {
    await t.evaluate(async (el) => {
      let last = el.getBoundingClientRect().top;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const now = el.getBoundingClientRect().top;
        if (Math.abs(now - last) < 1) break;
        last = now;
      }
      el.scrollIntoView({ block: "center" });
    });
    await t.click();
    const option = page.getByRole("option", { name });
    await expect(option).toBeVisible();
    const inViewport = await option.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
    });
    if (inViewport) {
      await option.click();
      return;
    }
    await page.keyboard.press("Escape");
    await expect(option).toBeHidden();
    await page.waitForTimeout(300);
  }
  throw new Error(`option ${String(name)} of ${trigger} never came into the viewport`);
}

type StoredPrice = { interval: string; intervalCount: number; currency: string; unitAmountMinor: number; label: string | null };
const draftPrices = async (): Promise<StoredPrice[]> => (await api("GET", `/platform/plans/${SLUG}/versions/${draftId}`, undefined, platform.token)).json.snapshot.manualPrices ?? [];
const storedMinor = async () => Object.fromEntries((await draftPrices()).map((p) => [p.currency, p.unitAmountMinor]));
const expectedMinor = Object.fromEntries(MANUAL.map((m) => [m.currency, m.minor]));
const isDraftWrite = (method: string, url: string) => (method === "PATCH" || method === "PUT") && new URL(url).pathname.includes(`/platform/plans/${SLUG}/versions/`);

async function openDraft(page: Page) {
  await page.goto(`/platform/plans?plan=${SLUG}`);
  await expect(page.getByTestId("plan-detail-title")).toHaveText(PLAN_NAME);
  await expect(page.getByTestId("version-editor")).toBeVisible();
  await expect(page.getByTestId("version-manual-prices")).toBeVisible();
}
/**
 * Clicks Save and returns once the editor has answered: saved (true) or refused (false).
 * A row the editor marks invalid means the save must be refused locally; otherwise the
 * draft write is awaited, so the API can be read back straight after.
 */
async function save(page: Page): Promise<boolean> {
  const invalid = await page.locator('[data-testid^="manual-price-hint-"][data-state="invalid"]').count();
  if (invalid > 0) {
    await page.getByTestId("version-save").click();
    await expect(page.getByTestId("version-save-errors")).toBeVisible();
    return false;
  }
  const written = page.waitForResponse((r) => isDraftWrite(r.request().method(), r.url()));
  await page.getByTestId("version-save").click();
  const response = await written;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByTestId("version-save-errors")).toHaveCount(0);
  return true;
}

async function purge() {
  // Prices, then the plan of this spec with its versions (no company subscribes to it).
  await pg.query("delete from plan_prices where plan_id like 'zi-%' or provider_price_id = any($1)", [PROVIDER.map((p) => p.id)]);
  await pg.query("delete from plan_versions where plan_id like 'zi-%'");
  await pg.query("delete from plans where id like 'zi-%'");
  const companies = await pg.query("select id from companies where name = $1", [COMPANY_NAME]);
  for (const { id } of companies.rows) {
    await pg.query("delete from audit_logs where company_id = $1", [id]);
    await pg.query("delete from users where company_id = $1", [id]);
    await pg.query("delete from subscriptions where company_id = $1", [id]);
    await pg.query("delete from companies where id = $1", [id]);
  }
}

test.beforeAll(async () => {
  if (SHOTS && !fs.existsSync(SHOTS)) throw new Error(`LP_SHOTS_DIR does not exist: ${SHOTS}`);
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  await purge();
  platform = await login(PLATFORM.email, PLATFORM.password);

  // A published plan (v1) and a draft (v2) for the editor.
  const created = await api("POST", "/platform/plans", { id: SLUG, name: PLAN_NAME, limits: { contacts: 25 }, features: {} }, platform.token);
  expect(created.status, created.text).toBe(201);
  v1Id = created.json.draft.id;
  expect((await api("POST", `/platform/plans/${SLUG}/versions/${v1Id}/publish`, undefined, platform.token)).status).toBe(200);
  const draft = await api("POST", `/platform/plans/${SLUG}/versions`, { sourceVersionId: v1Id }, platform.token);
  expect(draft.status, draft.text).toBe(201);
  draftId = draft.json.id;

  // A newly onboarded tenant (trialing): its Subscription page offers the online prices.
  const company = await api("POST", "/companies", { name: COMPANY_NAME, plan: "free", industry: "QA" }, platform.token);
  expect(company.status, company.text).toBe(201);
  companyId = company.json.id;
  const admin = await api("POST", "/users", { email: ADMIN_EMAIL, name: "ZI Pricing Admin", role: "primary_admin", companyId, password: PASSWORD }, platform.token);
  expect(admin.status, admin.text).toBe(201);
  tenantAdmin = await login(ADMIN_EMAIL, PASSWORD);
});

test.afterAll(async () => {
  // Nothing of this spec stays behind: other specs list every active price and every plan.
  await purge();
  await pg.end();
});

test("manual prices: typed amounts are stored exactly, and reopening shows what was typed", async ({ page }) => {
  const errors = trackConsole(page);
  await seedAs(page, platform);
  await openDraft(page);
  await expect(page.getByTestId("manual-prices-empty")).toBeVisible();

  for (const [i, m] of MANUAL.entries()) {
    await page.getByTestId("manual-price-add").click();
    if (m.interval !== "Month") await pickOption(page, `manual-price-interval-${i}`, m.interval);
    await page.getByTestId(`manual-price-currency-${i}`).fill(m.currency);
    await page.getByTestId(`manual-price-amount-${i}`).fill(m.typed);
    // The row says what will be stored, in the currency's own unit, before anything is saved.
    const hint = page.getByTestId(`manual-price-hint-${i}`);
    await expect(hint).toHaveAttribute("data-state", "ok");
    await expect(hint).toContainText(m.reads);
    await expect(page.getByTestId(`manual-price-amount-${i}`)).toHaveAttribute("aria-invalid", "false");
  }
  expect(await save(page)).toBe(true);
  expect(await storedMinor()).toEqual(expectedMinor);

  // Reopen: every field shows the amount in the currency's own unit — never the amount ÷ 100.
  await page.reload();
  await expect(page.getByTestId("version-editor")).toBeVisible();
  for (const [i, m] of MANUAL.entries()) {
    await expect(page.getByTestId(`manual-price-currency-${i}`)).toHaveValue(m.currency);
    await expect(page.getByTestId(`manual-price-amount-${i}`)).toHaveValue(m.reopened);
    await expect(page.getByTestId(`manual-price-hint-${i}`)).toContainText(m.reads);
  }
  if (SHOTS) await page.getByTestId("version-manual-prices").screenshot({ path: path.join(SHOTS, "manual-prices-editor.png") });

  // Saving without touching anything sends the same amounts back.
  expect(await save(page)).toBe(true);
  expect(await storedMinor()).toEqual(expectedMinor);

  // Editing one price changes that price only.
  await page.getByTestId("manual-price-amount-0").fill("59.99");
  await expect(page.getByTestId("manual-price-hint-0")).toContainText("$59.99");
  expect(await save(page)).toBe(true);
  expect(await storedMinor()).toEqual({ ...expectedMinor, usd: 5999 });
  await page.getByTestId("manual-price-amount-0").fill("49.00");
  expect(await save(page)).toBe(true);
  expect(await storedMinor()).toEqual(expectedMinor);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("an amount that cannot be stored exactly is refused in the editor — nothing is sent", async ({ page }) => {
  await seedAs(page, platform);
  const writes: string[] = [];
  page.on("request", (r) => {
    if (isDraftWrite(r.method(), r.url())) writes.push(`${r.method()} ${r.url()}`);
  });
  await openDraft(page);
  const before = await draftPrices();
  const amount = page.getByTestId("manual-price-amount-0");
  const hint = page.getByTestId("manual-price-hint-0");

  const refusals: Array<[currency: string, typed: string, message: RegExp]> = [
    ["usd", "49.999", /USD has 2 decimals/],
    ["usd", "", /Enter an amount/],
    ["usd", "abc", /digits/],
    ["usd", "1e3", /digits/],
    ["usd", "-5", /digits/],
    ["usd", "1,000", /without commas or spaces/],
    ["usd", "1 000", /without commas or spaces/],
    ["usd", "10000000.01", /too large \(at most \$10,000,000\.00\)/],
    ["jpy", "5000.5", /JPY has no decimals/],
    ["isk", "5.5", /ISK has no decimals/],
    ["kwd", "1.2345", /KWD has 3 decimals/],
    ["xyz", "10", /XYZ is not a currency the billing provider supports/],
    ["us", "10", /US is not a currency the billing provider supports/],
  ];
  for (const [currency, typed, message] of refusals) {
    await page.getByTestId("manual-price-currency-0").fill(currency);
    await amount.fill(typed);
    await expect(hint, `${currency} "${typed}"`).toHaveAttribute("data-state", "invalid");
    await expect(hint, `${currency} "${typed}"`).toContainText(message);
    await expect(amount, `${currency} "${typed}"`).toHaveAttribute("aria-invalid", "true");
  }
  // The largest amounts are accepted exactly at the limit.
  await page.getByTestId("manual-price-currency-0").fill("usd");
  await amount.fill("10000000.00");
  await expect(hint).toHaveAttribute("data-state", "ok");
  await expect(hint).toContainText("$10,000,000.00");

  // Save with a refused amount: the editor says why and sends nothing.
  await amount.fill("49.999");
  expect(await save(page)).toBe(false);
  await expect(page.getByTestId("version-save-errors")).toContainText("manualPrices.0");
  await expect(page.getByTestId("version-save-errors")).toContainText("USD has 2 decimals");
  expect(writes, writes.join("\n")).toEqual([]);
  expect(await draftPrices()).toEqual(before);

  // Corrected, it saves again.
  await amount.fill("49.00");
  expect(await save(page)).toBe(true);
  expect(writes.length).toBe(1);
  expect(await storedMinor()).toEqual(expectedMinor);
});

test("the AI cost allowance is converted exactly; a figure that cannot be is refused, not saved as none", async ({ page }) => {
  await seedAs(page, platform);
  const writes: string[] = [];
  page.on("request", (r) => {
    if (isDraftWrite(r.method(), r.url())) writes.push(`${r.method()} ${r.url()}`);
  });
  await openDraft(page);
  const cost = page.getByTestId("version-allowance-cost");
  const error = page.getByTestId("version-allowance-cost-error");
  const stored = async () => (await api("GET", `/platform/plans/${SLUG}/versions/${draftId}`, undefined, platform.token)).json.allowances.aiCostMicroUsdPerMonth;
  expect(await stored()).toBeNull();

  // Dollars typed, millionths of a dollar stored — exactly.
  for (const [typed, micro] of [["12.5", 12_500_000], ["0.000001", 1], ["19.99", 19_990_000], ["0.1", 100_000]] as const) {
    await cost.fill(typed);
    await expect(error).toHaveCount(0);
    await expect(cost).toHaveAttribute("aria-invalid", "false");
    expect(await save(page), typed).toBe(true);
    expect(await stored(), typed).toBe(micro);
  }
  await page.reload();
  await expect(page.getByTestId("version-editor")).toBeVisible();
  await expect(cost).toHaveValue("0.1");

  // What cannot be an exact number of millionths is marked, and the draft is not sent.
  const sent = writes.length;
  for (const typed of ["0.0000001", "abc", "1,5", "-3", "1e2", "12 5"]) {
    await cost.fill(typed);
    await expect(error, typed).toBeVisible();
    await expect(cost, typed).toHaveAttribute("aria-invalid", "true");
    await page.getByTestId("version-save").click();
    await expect(page.getByTestId("version-save-errors"), typed).toContainText("allowances.aiCostMicroUsdPerMonth");
  }
  expect(writes.length, writes.join("\n")).toBe(sent);
  expect(await stored()).toBe(100_000); // still the last accepted amount — not "no allowance"

  // Blank is the one way to say "no allowance".
  await cost.fill("");
  await expect(error).toHaveCount(0);
  expect(await save(page)).toBe(true);
  expect(await stored()).toBeNull();
  await cost.fill("12.5");
  expect(await save(page)).toBe(true);
  expect(await stored()).toBe(12_500_000);
});

test("a stored price in an unsupported currency is kept as stored and never read as two decimals", async ({ page }) => {
  // Such a row can only arrive from outside the editor; the API stores what it is given.
  const withUnknown = [...(await draftPrices()), { interval: "week", intervalCount: 1, currency: "xyz", unitAmountMinor: 5000, label: "Legacy" }];
  const patched = await api("PATCH", `/platform/plans/${SLUG}/versions/${draftId}`, { manualPrices: withUnknown }, platform.token);
  expect(patched.status, patched.text).toBe(200);

  await seedAs(page, platform);
  await openDraft(page);
  const i = MANUAL.length;
  await expect(page.getByTestId(`manual-price-currency-${i}`)).toHaveValue("xyz");
  await expect(page.getByTestId(`manual-price-amount-${i}`)).toHaveValue(""); // no amount is invented
  const hint = page.getByTestId(`manual-price-hint-${i}`);
  await expect(hint).toHaveAttribute("data-state", "kept");
  await expect(hint).toContainText("5,000 XYZ (minor units)");
  await expect(hint).not.toContainText("50.00");

  // Saved untouched (with a label edited next to it), the amount is exactly what it was.
  await page.getByTestId(`manual-price-label-${i}`).fill("Legacy price");
  expect(await save(page)).toBe(true);
  const kept = (await draftPrices()).find((p) => p.currency === "xyz");
  expect(kept).toMatchObject({ unitAmountMinor: 5000, label: "Legacy price" });

  // It cannot be given a new amount while the currency is unsupported.
  await page.getByTestId(`manual-price-amount-${i}`).fill("60");
  await expect(hint).toHaveAttribute("data-state", "invalid");
  await expect(hint).toContainText("XYZ is not a currency the billing provider supports");
  expect(await save(page)).toBe(false);
  expect((await draftPrices()).find((p) => p.currency === "xyz")?.unitAmountMinor).toBe(5000);

  // Leave the draft as the next test expects it: the row removed.
  await page.getByTestId(`manual-price-remove-${i}`).click();
  expect(await save(page)).toBe(true);
  expect(await storedMinor()).toEqual(expectedMinor);
});

test("the published version shows every price in its own unit", async ({ page }) => {
  const published = await api("POST", `/platform/plans/${SLUG}/versions/${draftId}/publish`, undefined, platform.token);
  expect(published.status, published.text).toBe(200);
  await seedAs(page, platform);
  await page.goto(`/platform/plans?plan=${SLUG}`);
  await expect(page.getByTestId("plan-detail-title")).toHaveText(PLAN_NAME);
  const snapshot = page.getByTestId("snapshot-manual-prices");
  await expect(snapshot).toHaveAttribute("data-count", String(MANUAL.length));
  for (const m of MANUAL) await expect(page.getByTestId(m.interval === "Year" ? "manual-prices-annual" : "manual-prices-monthly")).toContainText(m.reads);
  // What amount ÷ 100 showed for these prices ("¥50", "KWD 105.000", "ISK 500.00") is not there.
  await expect(snapshot).not.toContainText("¥50");
  await expect(snapshot).not.toContainText("KWD 105");
  await expect(snapshot).not.toContainText("ISK 500.00");
  await expect(page.getByTestId("snapshot-allowance-cost")).toHaveText("$12.50");
  if (SHOTS) await snapshot.screenshot({ path: path.join(SHOTS, "manual-prices-published.png") });

  // The comparison with v1 (no manual price) shows the same amounts, not "usd/monthx1=4900".
  await pickOption(page, "compare-select", /^v1 /);
  const row = page.getByTestId("compare-row-pricing-manualPrices");
  await expect(row).toHaveAttribute("data-changed", "true");
  for (const m of MANUAL) await expect(row).toContainText(m.reads);
  await expect(row).not.toContainText("x1=");
  await expect(page.getByTestId("compare-row-allowances-aiCostMicroUsdPerMonth")).toContainText("$12.50");
});

test("verified provider prices read the same on Subscriptions, Plans and the version's mappings", async ({ page }) => {
  for (const p of PROVIDER) {
    const res = await api("POST", "/platform/billing/prices", { planId: SLUG, providerPriceId: p.id }, platform.token);
    expect(res.status, `${p.id}: ${res.text}`).toBe(201);
    priceRowIds.push(res.json.id);
  }
  const errors = trackConsole(page);
  await seedAs(page, platform);

  await page.goto("/platform/subscriptions");
  await expect(page.getByTestId("platform-subscriptions")).toBeVisible();
  // Each of these fails under amount ÷ 100 (5,017 yen read "¥50", 10.517 dinars "KWD 105.170").
  for (const p of PROVIDER) await expect(page.getByTestId("prices-card")).toContainText(p.reads);
  if (SHOTS) await page.getByTestId("prices-card").screenshot({ path: path.join(SHOTS, "subscriptions-prices.png") });

  await page.goto(`/platform/plans?plan=${SLUG}`);
  await expect(page.getByTestId("plan-detail-title")).toHaveText(PLAN_NAME);
  for (const [i, p] of PROVIDER.entries()) {
    await expect(page.getByTestId(`price-row-${priceRowIds[i]}`)).toContainText(p.reads);
    await expect(page.getByTestId(`mapping-row-${priceRowIds[i]}`).first()).toContainText(p.reads);
  }
  await expect(page.getByTestId(`price-row-${priceRowIds[2]}`)).not.toContainText("¥50");
  await expect(page.getByTestId(`price-row-${priceRowIds[5]}`)).not.toContainText("KWD 105");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("the tenant's Subscription page offers the same prices in the same units", async ({ page }) => {
  await seedAs(page, tenantAdmin);
  const current = (await api("GET", "/subscriptions/current", undefined, tenantAdmin.token)).json;
  expect(current.billing.checkoutAvailable, JSON.stringify(current.billing)).toBe(true);
  await page.goto("/admin/subscription");
  await expect(page.getByTestId("checkout-card")).toBeVisible();
  for (const [i, p] of PROVIDER.entries()) await expect(page.getByTestId(`price-option-${priceRowIds[i]}`)).toContainText(`${p.reads} / month`);
  if (SHOTS) await page.getByTestId("checkout-card").screenshot({ path: path.join(SHOTS, "tenant-checkout-prices.png") });
});

test("the pricing screens are the platform owner's", async ({ page }) => {
  const tenant = await login(TENANT_DEMO.email, TENANT_DEMO.password);
  for (const [method, p, body] of [
    ["GET", "/platform/plans", undefined],
    ["GET", `/platform/plans/${SLUG}/versions`, undefined],
    ["PATCH", `/platform/plans/${SLUG}/versions/${draftId}`, { manualPrices: [] }],
    ["GET", "/platform/billing/prices", undefined],
    ["POST", "/platform/billing/prices", { planId: SLUG, providerPriceId: "price_fake_usd_100_month" }],
  ] as const) {
    expect((await api(method, p, body, tenant.token)).status, `tenant ${method} ${p}`).toBe(403);
    expect((await api(method, p, body, tenantAdmin.token)).status, `tenant admin ${method} ${p}`).toBe(403);
    expect((await api(method, p, body)).status, `anonymous ${method} ${p}`).toBe(401);
  }
  // Nothing was changed by the refused calls.
  expect((await api("GET", "/platform/billing/prices", undefined, platform.token)).json.prices.filter((x: { planId: string }) => x.planId === SLUG)).toHaveLength(PROVIDER.length);

  // In the browser a tenant administrator never reaches the Plan Builder.
  await seedAs(page, tenant);
  await page.goto(`/platform/plans?plan=${SLUG}`);
  await expect(page).not.toHaveURL(/\/platform\/plans/);
  await expect(page.getByTestId("plan-detail-title")).toHaveCount(0);
});

test("a new draft opens with the published prices, unchanged", async ({ page }) => {
  const draft = await api("POST", `/platform/plans/${SLUG}/versions`, { sourceVersionId: draftId }, platform.token);
  expect(draft.status, draft.text).toBe(201);
  nextDraftId = draft.json.id;
  await seedAs(page, platform);
  await openDraft(page);
  for (const [i, m] of MANUAL.entries()) {
    await expect(page.getByTestId(`manual-price-currency-${i}`)).toHaveValue(m.currency);
    await expect(page.getByTestId(`manual-price-amount-${i}`)).toHaveValue(m.reopened);
  }
  const written = page.waitForResponse((r) => isDraftWrite(r.request().method(), r.url()));
  await page.getByTestId("version-save").click();
  expect((await written).status()).toBe(200);
  const stored = (await api("GET", `/platform/plans/${SLUG}/versions/${nextDraftId}`, undefined, platform.token)).json.snapshot.manualPrices as StoredPrice[];
  expect(Object.fromEntries(stored.map((p) => [p.currency, p.unitAmountMinor]))).toEqual(expectedMinor);
});

for (const view of [
  { name: "tablet-820", width: 820, height: 1180, theme: "light" },
  { name: "mobile-390", width: 390, height: 844, theme: "light" },
  { name: "desktop-1440-dark", width: 1440, height: 900, theme: "dark" },
] as const) {
  test(`the price editor and the published prices fit ${view.name}`, async ({ page }) => {
    const errors = trackConsole(page);
    await page.setViewportSize({ width: view.width, height: view.height });
    await seedAs(page, platform, view.theme);
    const overflow = () =>
      page.evaluate(() => {
        const main = document.querySelector("main");
        return { document: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
      });
    const shot = async (name: string) => {
      if (!SHOTS) return;
      const height = await page.evaluate(() => document.querySelector("main")?.scrollHeight ?? document.body.scrollHeight);
      await page.setViewportSize({ width: view.width, height: Math.min(Math.max(height + 140, view.height), 7800) });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, `${name}-${view.name}.png`) });
      await page.setViewportSize({ width: view.width, height: view.height });
    };

    // The editor (the draft): six price rows, each field inside its row, each hint readable.
    await openDraft(page);
    for (const [i, m] of MANUAL.entries()) {
      await expect(page.getByTestId(`manual-price-amount-${i}`)).toHaveValue(m.reopened);
      await expect(page.getByTestId(`manual-price-hint-${i}`)).toContainText(m.reads);
      const inside = await page.getByTestId(`manual-price-${i}`).evaluate((row) => {
        const box = row.getBoundingClientRect();
        return [...row.querySelectorAll("input, button, p")].every((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= box.left - 1 && r.right <= box.right + 1 && r.width > 0;
        });
      });
      expect(inside, `row ${i} at ${view.name}`).toBe(true);
    }
    // A refused amount shows its reason in the row at this width too.
    await page.getByTestId("manual-price-amount-2").fill("5000.5");
    await expect(page.getByTestId("manual-price-hint-2")).toContainText("JPY has no decimals");
    expect(await overflow(), `${view.name} editor`).toEqual({ document: 0, main: 0 });
    await shot("plan-editor");
    await page.getByTestId("manual-price-amount-2").fill("5000");

    // The published version: the same prices, read-only.
    await page.getByTestId(`version-open-${draftId}`).click();
    await expect(page.getByTestId("snapshot-manual-prices")).toBeVisible();
    for (const m of MANUAL) await expect(page.getByTestId("snapshot-manual-prices")).toContainText(m.reads);
    expect(await overflow(), `${view.name} published`).toEqual({ document: 0, main: 0 });
    await shot("plan-prices");
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
