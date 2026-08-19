import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * P. dev.kaptnow.com is RETIRED from interactive use — a redirect-only host.
 * Every browser route leaves for the same path on the real portal
 * (elite.kaptnow.com for /platform*, admin.kaptnow.com for everything else)
 * before any provider, router, or layout mounts. Real hostnames via Chromium
 * host-resolver rules; the target https origins are stubbed so the external
 * navigation is observable without leaving the machine.
 *
 * Login refusal through Host: dev.kaptnow.com (403, no session, no token) and
 * /api/readyz being unaffected are covered server-side in
 * artifacts/api-server/test/portal-host-login.test.ts. /healthz is served by
 * nginx (docker/nginx/default.conf.template), outside this SPA entirely.
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

const DEV_HOST = "http://dev.kaptnow.com";

// Stub both real portal https origins so the exit is observable offline.
async function stubPortals(page: Page) {
  await page.route("https://admin.kaptnow.com/**", (route) =>
    route.fulfill({ contentType: "text/plain", body: "ADMIN-PORTAL-STUB" }),
  );
  await page.route("https://elite.kaptnow.com/**", (route) =>
    route.fulfill({ contentType: "text/plain", body: "ELITE-PORTAL-STUB" }),
  );
}

// Layout sentinels that survive the cross-origin exit: a trip is reported to
// the TEST PROCESS the moment a foreign layout appears in the DOM, so even a
// one-frame flash on the dev host is caught although the page navigates away.
async function armSentinels(page: Page): Promise<string[]> {
  const trips: string[] = [];
  await page.exposeFunction("__sentinelTrip", (what: string) => trips.push(what));
  await page.addInitScript(() => {
    const report = (what: string) =>
      (window as unknown as { __sentinelTrip?: (w: string) => void }).__sentinelTrip?.(what);
    new MutationObserver(() => {
      if (document.body?.innerText?.includes("Platform Portal")) report("platform-layout");
      if (document.querySelector('a[href="/admin/contacts"]')) report("admin-layout");
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
  return trips;
}

async function expectExit(page: Page, fromPath: string, toUrl: string, stub: string) {
  await page.goto(`${DEV_HOST}${fromPath}`);
  await page.waitForURL(toUrl);
  await expect(page.getByText(stub)).toBeVisible();
  expect(page.url()).toBe(toUrl);
}

test("dev / exits to the customer portal root", async ({ page }) => {
  const trips = await armSentinels(page);
  await stubPortals(page);
  await expectExit(page, "/", "https://admin.kaptnow.com/", "ADMIN-PORTAL-STUB");
  expect(trips).toHaveLength(0);
});

test("dev /login exits to admin.kaptnow.com/login", async ({ page }) => {
  const trips = await armSentinels(page);
  await stubPortals(page);
  await expectExit(page, "/login", "https://admin.kaptnow.com/login", "ADMIN-PORTAL-STUB");
  expect(trips).toHaveLength(0);
});

test("dev /admin exits same-path; AdminLayout never renders", async ({ page }) => {
  const trips = await armSentinels(page);
  await stubPortals(page);
  await expectExit(page, "/admin", "https://admin.kaptnow.com/admin", "ADMIN-PORTAL-STUB");
  expect(trips).toHaveLength(0);
});

test("dev /admin/contacts exits same-path; AdminLayout never renders", async ({ page }) => {
  const trips = await armSentinels(page);
  await stubPortals(page);
  await expectExit(page, "/admin/contacts", "https://admin.kaptnow.com/admin/contacts", "ADMIN-PORTAL-STUB");
  expect(trips).toHaveLength(0);
});

test("dev /platform exits to elite.kaptnow.com/platform; PlatformLayout never renders", async ({ page }) => {
  const trips = await armSentinels(page);
  await stubPortals(page);
  await expectExit(page, "/platform", "https://elite.kaptnow.com/platform", "ELITE-PORTAL-STUB");
  expect(trips).toHaveLength(0);
});

test("dev /platform/users exits same-path to elite.kaptnow.com", async ({ page }) => {
  const trips = await armSentinels(page);
  await stubPortals(page);
  await expectExit(page, "/platform/users", "https://elite.kaptnow.com/platform/users", "ELITE-PORTAL-STUB");
  expect(trips).toHaveLength(0);
});
