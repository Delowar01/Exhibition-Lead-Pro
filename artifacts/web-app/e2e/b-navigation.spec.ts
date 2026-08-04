import {
  test,
  expect,
  state,
  seedAuth,
  urlFor,
  waitForWorkspace,
  markNoReload,
  markerStillSet,
} from "./fixtures/workspace";

/**
 * B. Navigation — clicking tabs changes the URL without a full reload (a window
 * marker set before clicks survives), browser back/forward restore the prior
 * workspace, and reload keeps the current route.
 */

test("tab clicks change URL without a full page reload", async ({ page }) => {
  await seedAuth(page);
  await page.goto(urlFor(state.contact.id, "overview"));
  await waitForWorkspace(page);
  await markNoReload(page);

  await page.getByTestId("tab-timeline").click();
  await expect(page).toHaveURL(new RegExp(`/admin/contacts/${state.contact.id}/timeline$`));
  expect(await markerStillSet(page), "marker cleared → full reload happened").toBe(true);

  await page.getByTestId("tab-documents").click();
  await expect(page).toHaveURL(new RegExp(`/admin/contacts/${state.contact.id}/documents$`));
  expect(await markerStillSet(page)).toBe(true);

  await page.getByTestId("tab-ai").click();
  await expect(page).toHaveURL(new RegExp(`/admin/contacts/${state.contact.id}/ai$`));
  expect(await markerStillSet(page)).toBe(true);

  await page.getByTestId("tab-overview").click();
  await expect(page).toHaveURL(new RegExp(`/admin/contacts/${state.contact.id}$`));
  expect(await markerStillSet(page)).toBe(true);
});

test("browser back/forward restore the prior workspace", async ({ page }) => {
  await seedAuth(page);
  await page.goto(urlFor(state.contact.id, "overview"));
  await waitForWorkspace(page);

  await page.getByTestId("tab-timeline").click();
  await expect(page.getByTestId("tab-timeline")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("tab-ai").click();
  await expect(page.getByTestId("tab-ai")).toHaveAttribute("aria-selected", "true");

  // Back → timeline
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/admin/contacts/${state.contact.id}/timeline$`));
  await expect(page.getByTestId("tab-timeline")).toHaveAttribute("aria-selected", "true");

  // Back → overview
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/admin/contacts/${state.contact.id}$`));
  await expect(page.getByTestId("tab-overview")).toHaveAttribute("aria-selected", "true");

  // Forward → timeline
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/admin/contacts/${state.contact.id}/timeline$`));
  await expect(page.getByTestId("tab-timeline")).toHaveAttribute("aria-selected", "true");
});

test("reload keeps the current route and active tab", async ({ page }) => {
  await seedAuth(page);
  await page.goto(urlFor(state.contact.id, "documents"));
  await waitForWorkspace(page);
  await expect(page.getByTestId("tab-documents")).toHaveAttribute("aria-selected", "true");

  await page.reload();
  await waitForWorkspace(page);
  await expect(page).toHaveURL(new RegExp(`/admin/contacts/${state.contact.id}/documents$`));
  await expect(page.getByTestId("tab-documents")).toHaveAttribute("aria-selected", "true");
});
