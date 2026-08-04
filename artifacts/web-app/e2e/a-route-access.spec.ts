import {
  test,
  expect,
  state,
  seedAuth,
  urlFor,
  waitForWorkspace,
  WORKSPACES,
} from "./fixtures/workspace";

/**
 * A. Route access — each of the four URLs deep-links to the right page with the
 * correct active tab, page-specific content, and the ContactHero name, without
 * crashing. Unknown contact id follows the app's existing "Contact not found".
 */

const PAGE_MARKERS: Record<(typeof WORKSPACES)[number], () => { name: string; check: (page: import("@playwright/test").Page) => Promise<void> }> = {
  overview: () => ({
    name: "Overview",
    check: async (page) => {
      // Overview panel is the tabpanel labelled by the overview tab.
      await expect(page.locator("#workspace-panel-overview")).toBeVisible();
    },
  }),
  timeline: () => ({
    name: "Timeline",
    check: async (page) => {
      await expect(page.locator("#workspace-panel-timeline")).toBeVisible();
      await expect(page.getByTestId("input-timeline-search")).toBeVisible();
    },
  }),
  documents: () => ({
    name: "Documents",
    check: async (page) => {
      await expect(page.locator("#workspace-panel-documents")).toBeVisible();
      await expect(page.getByTestId("input-documents-search")).toBeVisible();
    },
  }),
  ai: () => ({
    name: "AI Copilot",
    check: async (page) => {
      await expect(page.locator("#workspace-panel-ai")).toBeVisible();
      await expect(
        page.locator("#workspace-panel-ai").getByText("Suggested Actions"),
      ).toBeVisible();
    },
  }),
};

for (const ws of WORKSPACES) {
  test(`deep-link to ${ws} shows the right page, active tab and hero`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await seedAuth(page);
    await page.goto(urlFor(state.contact.id, ws));
    await waitForWorkspace(page);

    // Hero name visible.
    await expect(page.getByTestId("text-contact-name")).toContainText(state.contact.firstName);

    // Correct active tab (aria-selected + tabindex roving).
    const activeTab = page.getByTestId(`tab-${ws}`);
    await expect(activeTab).toHaveAttribute("aria-selected", "true");
    await expect(activeTab).toHaveAttribute("tabindex", "0");
    for (const other of WORKSPACES) {
      if (other === ws) continue;
      await expect(page.getByTestId(`tab-${other}`)).toHaveAttribute("aria-selected", "false");
    }

    // Page-specific content.
    await PAGE_MARKERS[ws]().check(page);

    // No runtime crash.
    expect(errors, `page errors on ${ws}: ${errors.join("; ")}`).toHaveLength(0);
  });
}

test("unknown contact id follows existing not-found behavior", async ({ page }) => {
  await seedAuth(page);
  await page.goto(urlFor(999999999, "overview"));
  // Existing behavior: a centered "Contact not found" message, no hero.
  await expect(page.getByText(/contact not found/i)).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("contact-hero")).toHaveCount(0);
  expect(page.url()).toContain("/admin/contacts/999999999");
});
