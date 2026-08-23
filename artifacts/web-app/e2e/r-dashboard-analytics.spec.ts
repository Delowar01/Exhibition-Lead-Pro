import { test, expect, state, seedAuth } from "./fixtures/workspace";

// The seeded admin's display name (from the real login response captured by
// global-setup) — used to pick their own employee scope in the selectors.
const USER_NAME = state.user.name ?? "TechCorp Admin";

/**
 * R. Batch 10 — Dashboard command center (/admin) and Performance Analytics
 * (/admin/analytics): rendering with real backend data, scope switching,
 * date-range switching, the branded CSV export, saved dashboard views, and
 * the two pages staying complementary (no duplicated activity feed).
 * Runs as the seeded TechCorp primary_admin.
 */

test("dashboard command center renders real scoped data", async ({ page }) => {
  await seedAuth(page);
  await page.goto("/admin");

  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  // Header description proves a real scope resolution (name · headcount · window).
  await expect(page.getByText(/·\s*\d+\s*(person|people)\s*·/).first()).toBeVisible();

  await expect(page.getByText("Pipeline Value").first()).toBeVisible();
  await expect(page.getByText("Activity Trend").first()).toBeVisible();
  await expect(page.getByText("Pipeline Funnel").first()).toBeVisible();
  await expect(page.getByText("Monthly Growth").first()).toBeVisible();
  await expect(page.getByText("Capture Source").first()).toBeVisible();
});

test("scope switching reloads the dashboard for the selected scope", async ({ page }) => {
  await seedAuth(page);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();

  // Drill into the admin's own employee scope — the title flips to My Dashboard
  // and the description now names that person.
  await page.getByTestId("dashboard-scope").click();
  await page.getByRole("option", { name: USER_NAME, exact: true }).click();

  await expect(page.getByRole("heading", { name: "My Dashboard" })).toBeVisible();
  await expect(page.getByText(new RegExp(`${USER_NAME}\\s*·`)).first()).toBeVisible();

  // And back to the company command center.
  await page.getByTestId("dashboard-scope").click();
  await page.getByRole("option", { name: "Company (All)" }).click();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
});

test("date-range switching updates the reporting window", async ({ page }) => {
  await seedAuth(page);
  await page.goto("/admin");
  const description = page.getByText(/·\s*\d+\s*(person|people)\s*·/).first();
  await expect(description).toBeVisible();
  const before = await description.textContent();

  await page.getByTestId("dashboard-range").click();
  await page.getByRole("option", { name: "Last 7 days" }).click();

  await expect(async () => {
    const after = await description.textContent();
    expect(after).not.toBe(before);
  }).toPass();
});

test("dashboard CSV export is branded Lead Capture Pro and scoped", async ({ page }) => {
  await seedAuth(page);
  await page.goto("/admin");
  await expect(page.getByTestId("dashboard-export")).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("dashboard-export").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^dashboard-.*\.csv$/);

  const path = await download.path();
  const fs = await import("node:fs");
  const content = fs.readFileSync(path!, "utf-8");
  expect(content).toContain("Lead Capture Pro — Dashboard Summary");
  expect(content).not.toContain("Card Scanner Pro");
  expect(content).toContain('"Scope"');
  expect(content).toContain('"Conversion rate %"');
});

test("saved views: save, appear without reload, apply, delete", async ({ page }) => {
  await seedAuth(page);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();

  // Save the current view.
  await page.getByTestId("dashboard-views").click();
  await page.getByRole("menuitem", { name: "Save current view" }).click();
  await page.getByPlaceholder(/View name/).fill("B10 QA View");
  await page.getByRole("button", { name: "Save view" }).click();

  // It must appear in the menu WITHOUT a page reload (refetch-on-save fix).
  await page.getByTestId("dashboard-views").click();
  const savedItem = page.getByRole("menuitem", { name: "B10 QA View" });
  await expect(savedItem).toBeVisible();

  // Applying it keeps the dashboard rendering.
  await savedItem.click();
  await expect(page.getByRole("heading", { name: /Command Center|Dashboard/ })).toBeVisible();

  // Delete it and confirm it is gone from the menu.
  await page.getByTestId("dashboard-views").click();
  await page.getByRole("button", { name: "Delete saved view B10 QA View" }).click();
  await expect(page.getByRole("menuitem", { name: "B10 QA View" })).toHaveCount(0);
});

test("analytics is a distinct performance workspace (no duplicated activity feed)", async ({ page }) => {
  await seedAuth(page);
  await page.goto("/admin/analytics");

  await expect(page.getByRole("heading", { name: "Performance Analytics" })).toBeVisible();
  await expect(page.getByText("Conversion Rate").first()).toBeVisible();
  await expect(page.getByText(/\d+W \/ \d+L/).first()).toBeVisible();
  await expect(page.getByTestId("analytics-followup")).toBeVisible();
  await expect(page.getByText("On-time adherence")).toBeVisible();

  // The operational recent-activity feed belongs to the Dashboard only.
  await expect(page.getByText("Recent Activity")).toHaveCount(0);

  // Range switching updates the header window.
  const description = page.getByText(/Deep-dive analysis/).first();
  await expect(description).toBeVisible();
  const before = await description.textContent();
  await page.getByTestId("analytics-range").click();
  await page.getByRole("option", { name: "Last 7 days" }).click();
  await expect(async () => {
    expect(await description.textContent()).not.toBe(before);
  }).toPass();

  // Scope switching to the admin's own employee scope re-resolves the header.
  await page.getByTestId("analytics-scope").click();
  await page.getByRole("option", { name: USER_NAME, exact: true }).click();
  await expect(page.getByText(new RegExp(`${USER_NAME}\\s*·`)).first()).toBeVisible();
});
