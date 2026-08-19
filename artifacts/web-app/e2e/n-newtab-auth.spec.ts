import { test, expect } from "@playwright/test";
import type { Page, BrowserContext } from "@playwright/test";

/**
 * N. New-tab / reload session continuity — an already-authenticated user
 * opening a NEW TAB (same browser context ⇒ shared localStorage) or
 * reloading must reach their portal directly and must NEVER pass through
 * /login — not as a URL, not as a rendered form.
 *
 * Auth is established by a REAL UI login in tab A (AuthContext itself writes
 * localStorage) — no addInitScript seeding anywhere in this spec.
 */

const CUSTOMER = { email: "admin@techcorp.com", password: "Admin123!" };
const OWNER = { email: "admin@cardscannerpro.com", password: "Admin123!" };

// Record every main-frame navigation URL + arm a DOM sentinel that trips if
// the login form (#email input outside /login) ever renders.
async function track(page: Page): Promise<string[]> {
  const urls: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) urls.push(new URL(frame.url()).pathname);
  });
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, boolean>;
    w.__login_form_seen = false;
    new MutationObserver(() => {
      if (document.querySelector("form #email") && location.pathname !== "/login") {
        w.__login_form_seen = true;
      }
      if (location.pathname === "/login") w.__login_form_seen = true;
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
  return urls;
}

async function realLogin(page: Page, creds: { email: string; password: string }, dest: string) {
  await page.goto("/login");
  await page.locator("#email").fill(creds.email);
  await page.locator("#password").fill(creds.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`**${dest}`);
}

async function newTab(context: BrowserContext) {
  const page = await context.newPage();
  const urls = await track(page);
  return { page, urls };
}

function assertNeverLogin(urls: string[]) {
  expect(urls.filter((u) => u.startsWith("/login"))).toHaveLength(0);
}

test("customer: new tabs open /admin directly and /platform → /admin, never via /login", async ({ page, context }) => {
  await realLogin(page, CUSTOMER, "/admin");

  const tabB = await newTab(context);
  await tabB.page.goto("/admin");
  await tabB.page.waitForURL("**/admin");
  await expect(tabB.page.locator('a[href="/admin/contacts"]').first()).toBeVisible();
  assertNeverLogin(tabB.urls);
  expect(await tabB.page.evaluate(() => (window as any).__login_form_seen)).toBe(false);

  const tabC = await newTab(context);
  await tabC.page.goto("/platform");
  await tabC.page.waitForURL("**/admin");
  assertNeverLogin(tabC.urls);
  expect(await tabC.page.evaluate(() => (window as any).__login_form_seen)).toBe(false);
});

test("platform owner: new tabs open /platform directly and /admin → /platform, never via /login", async ({ page, context }) => {
  await realLogin(page, OWNER, "/platform");

  const tabB = await newTab(context);
  await tabB.page.goto("/platform");
  await tabB.page.waitForURL("**/platform");
  await expect(tabB.page.getByText("Platform Portal").first()).toBeVisible();
  assertNeverLogin(tabB.urls);
  expect(await tabB.page.evaluate(() => (window as any).__login_form_seen)).toBe(false);

  const tabC = await newTab(context);
  await tabC.page.goto("/admin");
  await tabC.page.waitForURL("**/platform");
  assertNeverLogin(tabC.urls);
  expect(await tabC.page.evaluate(() => (window as any).__login_form_seen)).toBe(false);
});

test("reload/deep-link keeps the authenticated portal, never /login", async ({ page, context }) => {
  await realLogin(page, CUSTOMER, "/admin");
  const urls = await track(page);
  await page.reload();
  await page.waitForURL("**/admin");
  await expect(page.locator('a[href="/admin/contacts"]').first()).toBeVisible();
  assertNeverLogin(urls);

  const ownerTab = await context.browser()!.newContext();
  const p2 = await ownerTab.newPage();
  await realLogin(p2, OWNER, "/platform");
  const urls2 = await track(p2);
  await p2.reload();
  await p2.waitForURL("**/platform");
  await expect(p2.getByText("Platform Portal").first()).toBeVisible();
  assertNeverLogin(urls2);
  await ownerTab.close();
});

test("authenticated visitor to /login is bounced straight to their portal", async ({ page, context }) => {
  await realLogin(page, CUSTOMER, "/admin");
  const tab = await context.newPage();
  await tab.goto("/login");
  await tab.waitForURL("**/admin");
  await expect(tab.locator("form #email")).toHaveCount(0);
});

test("unauthenticated: /admin and /platform land on /login", async ({ page }) => {
  await page.goto("/admin");
  await page.waitForURL("**/login");
  await page.goto("/platform");
  await page.waitForURL("**/login");
});
