import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * O. Split portal subdomains — real hostname behavior via Chromium
 * host-resolver rules (admin/elite/dev.kaptnow.com all resolve to the local
 * gateway; each is a genuine distinct browser origin with its own
 * localStorage). External cross-portal redirects are intercepted and stubbed
 * so the test can assert the navigation without leaving the machine.
 *
 *   admin.kaptnow.com — customer portal only; /platform never renders
 *   elite.kaptnow.com — Platform Owner portal only; /admin never renders
 *   dev.kaptnow.com   — mixed staging behavior (both roles)
 */

const RESOLVER =
  "--host-resolver-rules=" +
  "MAP admin.kaptnow.com 127.0.0.1,MAP elite.kaptnow.com 127.0.0.1,MAP dev.kaptnow.com 127.0.0.1";

test.use({
  launchOptions: {
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    args: [RESOLVER],
  },
});

const ADMIN_HOST = "http://admin.kaptnow.com";
const ELITE_HOST = "http://elite.kaptnow.com";
const DEV_HOST = "http://dev.kaptnow.com";

const CUSTOMER = { email: "admin@techcorp.com", password: "Admin123!" };
const OWNER = { email: "admin@cardscannerpro.com", password: "Admin123!" };

// Sentinels: trip if the foreign portal's layout ever appears in the DOM.
async function armSentinels(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, boolean>;
    w.__platform_seen = false;
    w.__admin_seen = false;
    new MutationObserver(() => {
      if (document.body?.innerText?.includes("Platform Portal")) w.__platform_seen = true;
      if (document.querySelector('a[href="/admin/contacts"]')) w.__admin_seen = true;
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
}
function sentinel(page: Page, key: "__platform_seen" | "__admin_seen") {
  return page.evaluate((k) => (window as unknown as Record<string, boolean>)[k], key);
}

// Stub the OTHER portal's https origin so an external redirect is observable.
async function stubExternal(page: Page, origin: "elite" | "admin") {
  const url = origin === "elite" ? "https://elite.kaptnow.com/**" : "https://admin.kaptnow.com/**";
  await page.route(url, (route) =>
    route.fulfill({ contentType: "text/plain", body: `${origin.toUpperCase()}-PORTAL-STUB` }),
  );
}

async function uiLogin(page: Page, host: string, creds: { email: string; password: string }) {
  await page.goto(`${host}/login`);
  await page.locator("#email").fill(creds.email);
  await page.locator("#password").fill(creds.password);
  await page.locator('button[type="submit"]').click();
}

async function storedAuth(page: Page) {
  return page.evaluate(() => ({
    token: localStorage.getItem("csp_token"),
    user: localStorage.getItem("csp_user"),
  }));
}

test("admin host: customer login lands on /admin and survives new tab + reload", async ({ page, context }) => {
  await uiLogin(page, ADMIN_HOST, CUSTOMER);
  await page.waitForURL(`${ADMIN_HOST}/admin`);
  await expect(page.locator('a[href="/admin/contacts"]').first()).toBeVisible();

  const tab = await context.newPage();
  const urls: string[] = [];
  tab.on("framenavigated", (f) => f === tab.mainFrame() && urls.push(new URL(f.url()).pathname));
  await tab.goto(`${ADMIN_HOST}/admin`);
  await tab.waitForURL(`${ADMIN_HOST}/admin`);
  expect(urls.filter((u) => u.startsWith("/login"))).toHaveLength(0);
  await tab.reload();
  await tab.waitForURL(`${ADMIN_HOST}/admin`);

  // Root pins to the customer portal when authenticated.
  await tab.goto(`${ADMIN_HOST}/`);
  await tab.waitForURL(`${ADMIN_HOST}/admin`);
});

test("admin host: /platform never renders and exits to elite.kaptnow.com", async ({ page }) => {
  await uiLogin(page, ADMIN_HOST, CUSTOMER);
  await page.waitForURL(`${ADMIN_HOST}/admin`);

  await armSentinels(page);
  await stubExternal(page, "elite");
  await page.goto(`${ADMIN_HOST}/platform`);
  await expect(page.getByText("ELITE-PORTAL-STUB")).toBeVisible();
  expect(page.url()).toBe("https://elite.kaptnow.com/");
  expect(await sentinel(page, "__platform_seen")).toBe(false);
});

test("admin host: Platform Owner login is refused and persists nothing", async ({ page }) => {
  await uiLogin(page, ADMIN_HOST, OWNER);
  await expect(page.getByText(/Platform Owner access is available at elite\.kaptnow\.com/)).toBeVisible();
  expect(page.url()).toContain("/login");
  const auth = await storedAuth(page);
  expect(auth.token).toBeNull();
  expect(auth.user).toBeNull();
});

test("elite host: owner login lands on /platform and survives new tab + reload", async ({ page, context }) => {
  await uiLogin(page, ELITE_HOST, OWNER);
  await page.waitForURL(`${ELITE_HOST}/platform`);
  await expect(page.getByText("Platform Portal").first()).toBeVisible();

  const tab = await context.newPage();
  const urls: string[] = [];
  tab.on("framenavigated", (f) => f === tab.mainFrame() && urls.push(new URL(f.url()).pathname));
  await tab.goto(`${ELITE_HOST}/platform`);
  await tab.waitForURL(`${ELITE_HOST}/platform`);
  expect(urls.filter((u) => u.startsWith("/login"))).toHaveLength(0);
  await tab.reload();
  await tab.waitForURL(`${ELITE_HOST}/platform`);

  await tab.goto(`${ELITE_HOST}/`);
  await tab.waitForURL(`${ELITE_HOST}/platform`);
});

test("elite host: /admin never renders and exits to admin.kaptnow.com", async ({ page }) => {
  await uiLogin(page, ELITE_HOST, OWNER);
  await page.waitForURL(`${ELITE_HOST}/platform`);

  await armSentinels(page);
  await stubExternal(page, "admin");
  await page.goto(`${ELITE_HOST}/admin`);
  await expect(page.getByText("ADMIN-PORTAL-STUB")).toBeVisible();
  expect(page.url()).toBe("https://admin.kaptnow.com/");
  expect(await sentinel(page, "__admin_seen")).toBe(false);
});

test("elite host: customer login is refused and persists nothing", async ({ page }) => {
  await uiLogin(page, ELITE_HOST, CUSTOMER);
  await expect(page.getByText(/Customer access is available at admin\.kaptnow\.com/)).toBeVisible();
  expect(page.url()).toContain("/login");
  const auth = await storedAuth(page);
  expect(auth.token).toBeNull();
  expect(auth.user).toBeNull();
});

test("dev host keeps mixed behavior: both roles log in to their portals", async ({ page, browser }) => {
  await uiLogin(page, DEV_HOST, CUSTOMER);
  await page.waitForURL(`${DEV_HOST}/admin`);

  const ownerCtx = await browser.newContext();
  const p2 = await ownerCtx.newPage();
  await uiLogin(p2, DEV_HOST, OWNER);
  await p2.waitForURL(`${DEV_HOST}/platform`);
  await ownerCtx.close();
});

test("unauthenticated behavior per host", async ({ page, context }) => {
  await page.goto(`${ADMIN_HOST}/admin`);
  await page.waitForURL(`${ADMIN_HOST}/login`);

  const p2 = await context.newPage();
  await p2.goto(`${ELITE_HOST}/platform`);
  await p2.waitForURL(`${ELITE_HOST}/login`);

  // Foreign route family exits the host even when unauthenticated.
  const p3 = await context.newPage();
  await armSentinels(p3);
  await stubExternal(p3, "elite");
  await p3.goto(`${ADMIN_HOST}/platform`);
  await expect(p3.getByText("ELITE-PORTAL-STUB")).toBeVisible();
  expect(await sentinel(p3, "__platform_seen")).toBe(false);
});
