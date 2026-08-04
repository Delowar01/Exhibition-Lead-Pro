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
 * F. Responsive — run core route + navigation assertions at 1440px, 390px and
 * 360px. At the two phone widths additionally assert: tabs usable (visible +
 * clickable), no horizontal overflow, header readable, main content accessible,
 * and the timeline filters do not block tab navigation.
 */

const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900, phone: false },
  { name: "mobile-390", width: 390, height: 844, phone: true },
  { name: "mobile-360", width: 360, height: 800, phone: true },
] as const;

for (const vp of VIEWPORTS) {
  test(`core route + nav at ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await seedAuth(page);
    await page.goto(urlFor(state.contact.id, "overview"));
    await waitForWorkspace(page);

    // Header readable: contact name visible with a non-zero box.
    const name = page.getByTestId("text-contact-name");
    await expect(name).toBeVisible();
    const nameBox = await name.boundingBox();
    expect(nameBox && nameBox.width).toBeGreaterThan(0);

    // Navigate through every workspace via the tabs.
    for (const ws of WORKSPACES) {
      const tab = page.getByTestId(`tab-${ws}`);
      await expect(tab).toBeVisible();
      await tab.scrollIntoViewIfNeeded();
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      const expectedUrl =
        ws === "overview"
          ? new RegExp(`/admin/contacts/${state.contact.id}$`)
          : new RegExp(`/admin/contacts/${state.contact.id}/${ws}$`);
      await expect(page).toHaveURL(expectedUrl);
      // Main content accessible: the active tabpanel is visible.
      await expect(page.locator(`#workspace-panel-${ws}`)).toBeVisible();
    }

    if (vp.phone) {
      // No horizontal overflow.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `horizontal overflow of ${overflow}px at ${vp.name}`).toBeLessThanOrEqual(1);

      // Filters (timeline) must not block navigation: on the timeline page the
      // filter chips are present, yet tabs remain clickable.
      await page.getByTestId("tab-timeline").click();
      await expect(page.getByTestId("chip-timeline-all")).toBeVisible();
      const overviewTab = page.getByTestId("tab-overview");
      await overviewTab.scrollIntoViewIfNeeded();
      await overviewTab.click();
      await expect(overviewTab).toHaveAttribute("aria-selected", "true");

      // Re-check overflow on the timeline (heavy) page too.
      await page.getByTestId("tab-timeline").click();
      await expect(page.getByTestId("chip-timeline-all")).toBeVisible();
      const overflow2 = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow2, `timeline horizontal overflow of ${overflow2}px at ${vp.name}`).toBeLessThanOrEqual(1);
    }
  });
}
