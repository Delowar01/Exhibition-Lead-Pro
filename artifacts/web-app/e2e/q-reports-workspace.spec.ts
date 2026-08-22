import { test, expect, seedAuth } from "./fixtures/workspace";

/**
 * Q. Batch 9 — Reports & Export Center workspace (/admin/reports).
 *
 * Storage note: export generation uploads to object storage. Without GCS
 * (typical localhost) the backend deterministically records a FAILED run and
 * answers 502 — the UI must surface that failure state cleanly, which is
 * asserted here; with storage configured the success panel is asserted
 * instead. The active branch is decided by probing /api/readyz.
 */

let STORAGE = false;

test.beforeAll(async ({ request }) => {
  const res = await request.get("http://localhost:80/api/readyz");
  STORAGE = (await res.json())?.checks?.storage === "ok";
});

test("workspace loads with all four areas", async ({ page }) => {
  await seedAuth(page);
  await page.goto("/admin/reports");

  await expect(page.getByTestId("reports-workspace-tabs")).toBeVisible();
  await expect(page.getByText("Scan Activity Trend (Last 30 Days)")).toBeVisible();

  await page.getByTestId("tab-export").click();
  await expect(page.getByTestId("export-center-panel")).toBeVisible();

  await page.getByTestId("tab-schedules").click();
  await expect(page.getByTestId("export-schedules-panel")).toBeVisible();

  await page.getByTestId("tab-history").click();
  await expect(page.getByTestId("export-history-panel")).toBeVisible();

  await page.getByTestId("tab-reports").click();
  await expect(page.getByText("Scan Activity Trend (Last 30 Days)")).toBeVisible();
});

test("event report: empty prompt, then a real report for a selected event", async ({ page }) => {
  await seedAuth(page);
  await page.goto("/admin/reports");

  await page.getByTestId("subtab-event").click();
  await expect(page.getByText("Select an event to build its report")).toBeVisible();

  await page.getByTestId("event-report-event").click();
  await page.getByRole("option").first().click();

  await expect(page.getByTestId("event-report-results")).toBeVisible();
  await expect(page.getByText("Total Leads").first()).toBeVisible();
  await expect(page.getByText("Pipeline Value").first()).toBeVisible();
});

test("team member report renders metrics and activity", async ({ page }) => {
  await seedAuth(page);
  await page.goto("/admin/reports");

  await page.getByTestId("subtab-member").click();
  await expect(page.getByText("Pick an event and a team member")).toBeVisible();

  await page.getByTestId("member-report-event").click();
  await page.getByRole("option").first().click();
  await page.getByTestId("member-report-user").click();
  await page.getByRole("option").first().click();

  await expect(page.getByTestId("member-report-results")).toBeVisible();
  await expect(page.getByText("Conversion").first()).toBeVisible();
  await expect(page.getByText(/Recent Activity —/).first()).toBeVisible();
});

test("on-demand export: password rules, generation outcome, and history entry", async ({ page }) => {
  await seedAuth(page);
  await page.goto("/admin/reports");
  await page.getByTestId("tab-export").click();

  // Password gate: too-short password disables Generate; unchecking re-enables.
  await page.getByTestId("export-format-json").click();
  await page.locator("#export-protect").click();
  await page.getByTestId("export-password").fill("abc");
  await expect(page.getByTestId("export-generate")).toBeDisabled();
  await page.getByTestId("export-password").fill("");
  await page.locator("#export-protect").click();
  await expect(page.getByTestId("export-generate")).toBeEnabled();

  await page.getByTestId("export-generate").click();

  if (STORAGE) {
    await expect(page.getByTestId("export-result")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("export-result-filename")).toContainText("contacts-export");
    await expect(page.getByTestId("export-result-download")).toBeVisible();
  } else {
    // Environment-gated: no object storage locally → clean failure state.
    await expect(page.getByTestId("export-failed")).toBeVisible({ timeout: 30_000 });
  }

  // Either outcome records a run that Export History must show.
  await page.getByTestId("tab-history").click();
  const firstRow = page.locator('[data-testid^="export-run-"]').first();
  await expect(firstRow).toBeVisible();
  await expect(firstRow.getByText(STORAGE ? "Completed" : "Failed")).toBeVisible();
});

test("schedules: create, toggle, edit, run-now feedback, delete with confirmation", async ({ page }) => {
  await seedAuth(page);
  await page.goto("/admin/reports");
  await page.getByTestId("tab-schedules").click();

  // Create
  await page.getByTestId("schedule-new").click();
  await page.getByTestId("schedule-name").fill("B9 UI Schedule");
  await page.getByTestId("schedule-save").click();
  const row = page.locator('[data-testid^="schedule-row-"]', { hasText: "B9 UI Schedule" });
  await expect(row).toBeVisible();
  await expect(row.getByText("weekly")).toBeVisible();

  // Deactivate / reactivate via the switch
  const toggle = row.locator('[data-testid^="schedule-toggle-"]');
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(row.getByText("Paused")).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // Run now — success toast with storage, clean failure toast without.
  await row.locator('[data-testid^="schedule-run-"]').click();
  if (STORAGE) {
    await expect(page.getByText(/Export generated/).first()).toBeVisible({ timeout: 30_000 });
  } else {
    await expect(page.getByText(/Run failed|Could not run the schedule/).first()).toBeVisible({ timeout: 30_000 });
  }

  // Edit
  await row.locator('[data-testid^="schedule-edit-"]').click();
  await page.getByTestId("schedule-name").fill("B9 UI Schedule v2");
  await page.getByTestId("schedule-save").click();
  const renamed = page.locator('[data-testid^="schedule-row-"]', { hasText: "B9 UI Schedule v2" });
  await expect(renamed).toBeVisible();

  // Delete requires confirmation
  await renamed.locator('[data-testid^="schedule-delete-"]').click();
  await expect(page.getByText("Delete this schedule?")).toBeVisible();
  await page.getByTestId("schedule-delete-confirm").click();
  await expect(renamed).toHaveCount(0);
});

test("platform owner cannot reach the customer Reports workspace", async ({ page }) => {
  await page.goto("/login");
  await page.locator("#email").fill("admin@cardscannerpro.com");
  await page.locator("#password").fill("Admin123!");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/platform");

  await page.goto("/admin/reports");
  await page.waitForURL("**/platform");
  await expect(page.getByTestId("reports-workspace-tabs")).toHaveCount(0);
});
