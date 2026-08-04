import {
  test,
  expect,
  state,
  seedAuth,
  urlFor,
  waitForWorkspace,
} from "./fixtures/workspace";

/**
 * E. Documents route renders the documents workspace; AI route renders the AI
 * Copilot workspace; and there are no legacy "Activities" or "Interactions"
 * tabs anywhere in the workspace.
 */

test("documents route renders the documents workspace", async ({ page }) => {
  await seedAuth(page);
  await page.goto(urlFor(state.contact.id, "documents"));
  await waitForWorkspace(page);
  const panel = page.locator("#workspace-panel-documents");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("input-documents-search")).toBeVisible();
  await expect(panel.getByTestId("select-documents-category")).toBeVisible();
});

test("ai route renders the AI Copilot workspace", async ({ page }) => {
  await seedAuth(page);
  await page.goto(urlFor(state.contact.id, "ai"));
  await waitForWorkspace(page);
  const panel = page.locator("#workspace-panel-ai");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Suggested Actions" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "AI Sessions" })).toBeVisible();
});

test("no Activities or Interactions tabs exist in the workspace", async ({ page }) => {
  await seedAuth(page);
  await page.goto(urlFor(state.contact.id, "overview"));
  await waitForWorkspace(page);

  const tablist = page.getByRole("tablist", { name: "Workspace tabs" });
  const tabs = tablist.getByRole("tab");
  await expect(tabs).toHaveCount(4);

  const labels = (await tabs.allInnerTexts()).map((t) => t.trim());
  expect(labels).toEqual(["Overview", "Timeline", "Documents", "AI Copilot"]);

  await expect(tablist.getByRole("tab", { name: /activities/i })).toHaveCount(0);
  await expect(tablist.getByRole("tab", { name: /interactions/i })).toHaveCount(0);
  await expect(page.getByTestId("tab-activities")).toHaveCount(0);
  await expect(page.getByTestId("tab-interactions")).toHaveCount(0);
});
