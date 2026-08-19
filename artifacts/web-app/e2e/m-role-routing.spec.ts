import { test, expect, state, seedAuth } from "./fixtures/workspace";
import { API_BASE } from "./fixtures/seed-values";
import type { Page } from "@playwright/test";

/**
 * M. Role-route isolation — wrong-role portal pages must NEVER render, not
 * even for one frame (ProtectedRoute decides at render time via <Redirect>).
 *
 *   customer (primary_admin): /platform[/*]  → /admin,   PlatformLayout never mounts
 *   platform_owner:           /admin[/*]     → /platform, AdminLayout never mounts
 *   unauthenticated:          protected URLs → /login,    nothing protected mounts
 *
 * "Never mounts" is proven with a MutationObserver armed BEFORE navigation:
 * if the wrong layout's unique marker ever appears in the DOM — even
 * transiently — the sentinel trips and the test fails.
 */

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };

// PlatformLayout renders "Platform Portal" (sidebar + footer); AdminLayout's
// sidebar nav renders the /admin/contacts link. Each is unique to its layout.
async function armSentinels(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, boolean>;
    w.__platform_seen = false;
    w.__admin_seen = false;
    const check = () => {
      if (document.body?.innerText?.includes("Platform Portal")) w.__platform_seen = true;
      if (document.querySelector('a[href="/admin/contacts"]')) w.__admin_seen = true;
    };
    new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
  });
}

function sentinel(page: Page, key: "__platform_seen" | "__admin_seen") {
  return page.evaluate((k) => (window as unknown as Record<string, boolean>)[k], key);
}

async function seedPlatformOwner(page: Page) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(PLATFORM),
  });
  if (!res.ok) throw new Error(`platform owner login failed: ${res.status}`);
  const auth = await res.json();
  await page.addInitScript(
    ([t, r, u]) => {
      localStorage.setItem("csp_token", t as string);
      localStorage.setItem("csp_user", u as string);
      if (r) localStorage.setItem("csp_refresh_token", r as string);
      localStorage.setItem("csp_theme", "light");
    },
    [auth.token, auth.refreshToken ?? "", JSON.stringify(auth.user)] as const,
  );
}

test("customer on /platform is redirected to /admin without rendering the platform page", async ({ page }) => {
  await seedAuth(page); // TechCorp primary_admin
  await armSentinels(page);
  await page.goto("/platform");
  await page.waitForURL("**/admin");
  await expect(page.getByText("Platform Portal")).toHaveCount(0);
  expect(await sentinel(page, "__platform_seen")).toBe(false);
});

test("customer on a nested /platform/* route is redirected without rendering", async ({ page }) => {
  await seedAuth(page);
  await armSentinels(page);
  await page.goto("/platform/users");
  await page.waitForURL("**/admin");
  expect(await sentinel(page, "__platform_seen")).toBe(false);
});

test("platform owner on /admin is redirected to /platform without rendering the admin page", async ({ page }) => {
  await seedPlatformOwner(page);
  await armSentinels(page);
  await page.goto("/admin");
  await page.waitForURL("**/platform");
  expect(await sentinel(page, "__admin_seen")).toBe(false);
});

test("platform owner on a nested /admin/* route is redirected without rendering", async ({ page }) => {
  await seedPlatformOwner(page);
  await armSentinels(page);
  await page.goto("/admin/contacts");
  await page.waitForURL("**/platform");
  expect(await sentinel(page, "__admin_seen")).toBe(false);
});

test("unauthenticated protected routes land on /login with nothing protected rendered", async ({ page }) => {
  await armSentinels(page); // no auth seeded
  await page.goto("/admin");
  await page.waitForURL("**/login");
  await page.goto("/platform");
  await page.waitForURL("**/login");
  expect(await sentinel(page, "__admin_seen")).toBe(false);
  expect(await sentinel(page, "__platform_seen")).toBe(false);
});
