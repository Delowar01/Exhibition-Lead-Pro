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
 * G. Dark-mode smoke — with csp_theme="dark" set pre-load, every page applies
 * html.dark, key regions are visible, body text color differs from the body
 * background (cheap invisible-text check), and the theme persists across tab
 * navigation.
 */

function parseRgb(s: string): [number, number, number, number] {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return [0, 0, 0, 1];
  const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
}

async function assertDarkRegions(page: import("@playwright/test").Page) {
  // html.dark applied.
  await expect(page.locator("html")).toHaveClass(/dark/);

  // Key regions visible.
  await expect(page.getByTestId("contact-hero")).toBeVisible(); // header
  await expect(page.getByRole("tablist", { name: "Workspace tabs" })).toBeVisible(); // tabs
  // main card = the active workspace panel; right rail = AI sidebar (desktop).
  const activePanel = page.locator('[role="tabpanel"]:not([hidden])');
  await expect(activePanel.first()).toBeVisible();

  // Invisible-text check: body text color must differ from body background.
  const { color, bg } = await page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return { color: cs.color, bg: cs.backgroundColor };
  });
  const [cr, cg, cb] = parseRgb(color);
  const [br, bg_, bb, ba] = parseRgb(bg);
  // If body bg is transparent, fall back to the html background.
  const bgColor =
    ba === 0
      ? await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
      : bg;
  const [fbr, fbg, fbb] = parseRgb(bgColor);
  const distance = Math.abs(cr - fbr) + Math.abs(cg - fbg) + Math.abs(cb - fbb);
  expect(distance, `body text ${color} vs background ${bgColor} too similar`).toBeGreaterThan(30);
}

test("dark mode applies on all four workspace pages", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const ws of WORKSPACES) {
    await seedAuth(page, { theme: "dark" });
    await page.goto(urlFor(state.contact.id, ws));
    await waitForWorkspace(page);
    await expect(page.getByTestId(`tab-${ws}`)).toHaveAttribute("aria-selected", "true");
    await assertDarkRegions(page);

    // Right rail (AI sidebar) present on desktop.
    await expect(page.getByRole("complementary", { name: "AI sidebar" })).toBeVisible();
  }
});

test("dark theme persists across tab navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedAuth(page, { theme: "dark" });
  await page.goto(urlFor(state.contact.id, "overview"));
  await waitForWorkspace(page);
  await expect(page.locator("html")).toHaveClass(/dark/);

  for (const ws of ["timeline", "documents", "ai", "overview"] as const) {
    await page.getByTestId(`tab-${ws}`).click();
    await expect(page.getByTestId(`tab-${ws}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("html")).toHaveClass(/dark/);
  }
});
