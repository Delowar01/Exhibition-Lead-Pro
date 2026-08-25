import { test, expect, state, seedAuth } from "./fixtures/workspace";

/**
 * U. Batch 13 — Customer portal UX modernization invariants. Behavior and
 * layout checks, no pixel snapshots: the admin shell renders, the sidebar
 * survives expanded → mini → expanded, mobile navigation opens and navigates,
 * Dashboard/Contacts/Leads keep their important controls reachable, the
 * Contact Workspace tabs stay exactly Overview/Timeline/Documents/AI Copilot,
 * core CRM pages never overflow horizontally at a mobile viewport, and dark
 * mode keeps the core controls present and visible.
 */

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

async function pageOverflow(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
}

test("admin shell renders: header, sidebar navigation and content column", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto("/admin");
  await expect(page.getByTestId("link-brand")).toBeVisible();
  await expect(page.getByTestId("button-global-search")).toBeVisible();
  await expect(page.getByTestId("button-user-menu")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByTestId("text-sidebar-company")).toBeVisible();
  await expect(page.getByTestId("dashboard-page")).toBeVisible();
});

test("sidebar expanded → mini → expanded stays fully usable", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto("/admin");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Contacts" })).toBeVisible();

  // Collapse to the icon rail: labels disappear visually but links stay
  // accessible by name (sr-only text) and still navigate.
  await page.getByTestId("button-sidebar-collapse").click();
  await expect(page.getByTestId("text-sidebar-company")).toHaveCount(0);
  const miniContacts = nav.getByRole("link", { name: "Contacts" });
  await expect(miniContacts).toBeVisible();
  await miniContacts.click();
  await expect(page).toHaveURL(/\/admin\/contacts/);

  // Expand again: full labels and company identity return.
  await page.getByTestId("button-sidebar-collapse").click();
  await expect(page.getByTestId("text-sidebar-company")).toBeVisible();
});

test("mobile sidebar opens, navigates and closes", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await seedAuth(page);
  await page.goto("/admin");
  await page.getByTestId("button-mobile-nav").click();
  const drawerNav = page.getByRole("dialog").getByRole("navigation", { name: "Primary" });
  await expect(drawerNav).toBeVisible();
  await drawerNav.getByRole("link", { name: "Contacts" }).click();
  await expect(page).toHaveURL(/\/admin\/contacts/);
  // Drawer auto-closes on navigation.
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Dashboard keeps its important controls reachable", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto("/admin");
  await expect(page.getByTestId("dashboard-scope")).toBeVisible();
  await expect(page.getByTestId("dashboard-range")).toBeVisible();
  await expect(page.getByTestId("dashboard-views")).toBeVisible();
  await expect(page.getByTestId("dashboard-export")).toBeVisible();
});

test("Contacts search/filter/action toolbar remains usable", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto("/admin/contacts");
  await expect(page.getByTestId("link-add-contact")).toBeVisible();
  const search = page.getByTestId("input-contact-search");
  await expect(search).toBeVisible();
  await search.fill(state.runTag);
  await expect(search).toHaveValue(state.runTag);
  await expect(page.getByRole("button", { name: /advanced filters/i })).toBeVisible();
});

test("Contact Workspace tabs are exactly Overview / Timeline / Documents / AI Copilot", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto(`/admin/contacts/${state.contact.id}`);
  const tablist = page.getByRole("tablist", { name: "Workspace tabs" });
  await expect(tablist).toBeVisible();
  const tabs = tablist.getByRole("tab");
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(0)).toContainText(/overview/i);
  await expect(tabs.nth(1)).toContainText(/timeline/i);
  await expect(tabs.nth(2)).toContainText(/documents/i);
  await expect(tabs.nth(3)).toContainText(/ai copilot/i);
});

test("Lead Pipeline table and Kanban views both remain reachable", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto("/admin/leads");
  await expect(page.getByTestId("button-view-table")).toBeVisible();
  await page.getByTestId("button-view-kanban").click();
  await expect(page.locator('[data-testid^="kanban-column-"]').first()).toBeVisible();
  await page.getByTestId("button-view-table").click();
  await expect(page.getByTestId("leads-table")).toBeVisible();
});

test("no page-level horizontal overflow on core CRM pages at 390×844", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await seedAuth(page);
  for (const path of ["/admin", "/admin/contacts", "/admin/leads", `/admin/contacts/${state.contact.id}`]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await pageOverflow(page);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
});

test("dark mode keeps core shell controls present and visible", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page, { theme: "dark" });
  await page.goto("/admin");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByTestId("link-brand")).toBeVisible();
  await expect(page.getByTestId("button-global-search")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByTestId("dashboard-scope")).toBeVisible();
  // The content column paints a real themed background (no invisible text on
  // unthemed white).
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe("rgb(255, 255, 255)");
});

test("tablet 1024×768: shell, contacts, pipeline and workspace stay usable with no overflow", async ({ page }) => {
  const TABLET = { width: 1024, height: 768 };
  await page.setViewportSize(TABLET);
  await seedAuth(page);

  // /admin — shell renders with the desktop/tablet sidebar (not the mobile
  // drawer), and the header controls neither overlap nor overflow.
  await page.goto("/admin");
  await expect(page.getByTestId("link-brand")).toBeVisible();
  await expect(page.getByTestId("button-global-search")).toBeVisible();
  await expect(page.getByTestId("button-quick-create")).toBeVisible();
  await expect(page.getByTestId("button-user-menu")).toBeVisible();
  await expect(page.getByTestId("button-mobile-nav")).toBeHidden(); // md+ uses the sidebar
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav).toBeVisible();
  const headerOverflow = await page
    .locator("header")
    .first()
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(headerOverflow, "header controls overflow/overlap").toBeLessThanOrEqual(1);
  const search = await page.getByTestId("button-global-search").boundingBox();
  const userMenu = await page.getByTestId("button-user-menu").boundingBox();
  expect(search && userMenu && search.x + search.width <= userMenu.x, "search overlaps user controls").toBe(true);
  expect(await pageOverflow(page)).toBeLessThanOrEqual(1);

  // Sidebar is usable: a nav link navigates.
  await nav.getByRole("link", { name: "Contacts" }).click();
  await expect(page).toHaveURL(/\/admin\/contacts/);

  // /admin/contacts — actions + search/filter toolbar reachable, no overflow.
  await expect(page.getByTestId("link-add-contact")).toBeVisible();
  const contactSearch = page.getByTestId("input-contact-search");
  await expect(contactSearch).toBeVisible();
  await contactSearch.fill("tablet-check");
  await expect(contactSearch).toHaveValue("tablet-check");
  await expect(page.getByRole("button", { name: /advanced filters/i })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(await pageOverflow(page), "overflow on /admin/contacts").toBeLessThanOrEqual(1);

  // /admin/leads — pipeline controls usable in both views without page overflow.
  await page.goto("/admin/leads");
  await expect(page.getByTestId("button-view-table")).toBeVisible();
  await expect(page.getByTestId("leads-table")).toBeVisible();
  expect(await pageOverflow(page), "overflow on /admin/leads (table)").toBeLessThanOrEqual(1);
  await page.getByTestId("button-view-kanban").click();
  await expect(page.locator('[data-testid^="kanban-column-"]').first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(await pageOverflow(page), "overflow on /admin/leads (kanban)").toBeLessThanOrEqual(1);

  // Contact Workspace — tabs reachable and switchable, no overflow.
  await page.goto(`/admin/contacts/${state.contact.id}`);
  const tablist = page.getByRole("tablist", { name: "Workspace tabs" });
  await expect(tablist).toBeVisible();
  await tablist.getByRole("tab", { name: /timeline/i }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/contacts/${state.contact.id}/timeline`));
  await page.waitForLoadState("networkidle");
  expect(await pageOverflow(page), "overflow on contact workspace").toBeLessThanOrEqual(1);
});
