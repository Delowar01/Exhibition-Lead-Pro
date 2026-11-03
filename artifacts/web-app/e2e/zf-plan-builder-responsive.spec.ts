import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/workspace";
import { API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * ZF. Batch 43 (PB-5) — Plan Builder layouts at desktop, tablet and narrow mobile-browser widths.
 *
 * For each viewport the platform owner opens the Plans catalog, a plan detail with its draft
 * editor, the Subscriptions screen with a tenant's manage dialog (plan history) and the
 * migration dialog. Proves: no horizontal overflow of the document, every dialog fits the
 * viewport, the primary controls are visible and reachable, and no console error is raised.
 * The data is created through the API (the oracle); nothing is asserted that the UI invents.
 */

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const SUFFIX = Date.now().toString(36);
const SLUG = `zf-${SUFFIX}`;
const PLAN_NAME = `Layout ${SUFFIX}`;

type Auth = { token: string; user: { id: number; companyId: number | null; email: string } };

let platform: Auth;
let v1Id = 0;
let v2Id = 0;
let companyId = 0;

const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "tablet-820", width: 820, height: 1180 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;

async function api(method: string, path: string, body?: unknown, token: string | null = null) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

async function login(email: string, password: string): Promise<Auth> {
  const res = await api("POST", "/auth/login", { email, password });
  expect(res.status, res.text).toBe(200);
  return { token: res.json.token, user: res.json.user };
}

async function seedAs(page: Page, auth: Auth) {
  await page.addInitScript(
    ([t, u, cid, userId]) => {
      try {
        localStorage.setItem("csp_token", t as string);
        localStorage.setItem("csp_user", u as string);
        if (cid) localStorage.setItem("csp_company_id", cid as string);
        localStorage.setItem("csp_theme", "light");
        localStorage.setItem(`csp_theme:u${userId}c${cid}`, "light");
      } catch {
        /* storage unavailable */
      }
    },
    [auth.token, JSON.stringify(auth.user), String(auth.user.companyId ?? ""), String(auth.user.id)] as const,
  );
}

function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  const noise = (s: string) => /fonts\.googleapis|fonts\.gstatic|ERR_CERT_AUTHORITY_INVALID|Failed to load resource/.test(s);
  page.on("console", (m) => {
    if (m.type() === "error" && !noise(m.text()) && !noise(m.location()?.url ?? "")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const pageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/**
 * The element's box must lie inside the viewport horizontally (dialogs and sticky controls).
 * Radix dialogs animate in (fade + zoom + slide from the left / top), so the box is polled until the
 * open animation has settled; a box that never fits fails after the poll timeout.
 */
async function expectFitsViewport(page: Page, testId: string, width: number) {
  const el = page.getByTestId(testId);
  await expect(el).toBeVisible();
  await el.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))));
  await expect
    .poll(
      async () => {
        const box = await el.boundingBox();
        return box ? { x: Math.round(box.x), right: Math.round(box.x + box.width) } : null;
      },
      { message: `${testId} must fit the viewport width ${width}`, timeout: 5000 },
    )
    .toEqual(expect.objectContaining({ x: expect.any(Number), right: expect.any(Number) }));
  const box = await el.boundingBox();
  expect(box, `${testId} has no box`).not.toBeNull();
  expect(box!.x, `${testId} starts left of the viewport`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${testId} exceeds the viewport width ${width}`).toBeLessThanOrEqual(width + 1);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  platform = await login(PLATFORM.email, PLATFORM.password);
  const created = await api("POST", "/platform/plans", { id: SLUG, name: PLAN_NAME, limits: { contacts: 50 }, features: {} }, platform.token);
  expect(created.status, created.text).toBe(201);
  v1Id = created.json.draft.id;
  const published = await api("POST", `/platform/plans/${SLUG}/versions/${v1Id}/publish`, undefined, platform.token);
  expect(published.status, published.text).toBe(200);
  const draft = await api("POST", `/platform/plans/${SLUG}/versions`, {}, platform.token);
  expect(draft.status, draft.text).toBe(201);
  v2Id = draft.json.id ?? draft.json.version?.id;
  expect(v2Id).toBeTruthy();
  const company = await api("POST", "/companies", { name: `${RUN_TAG} ZF Layout Co`, plan: "free", industry: "QA" }, platform.token);
  expect(company.status, company.text).toBe(201);
  companyId = company.json.id;
  const pinned = await api("POST", `/platform/subscriptions/${companyId}/plan`, { plan: SLUG, planVersionId: v1Id, reason: "ZF layout" }, platform.token);
  expect(pinned.status, pinned.text).toBe(200);
});

test.afterAll(async () => {
  if (!platform) return;
  if (companyId) await api("DELETE", `/companies/${companyId}`, undefined, platform.token);
  if (v2Id) await api("DELETE", `/platform/plans/${SLUG}/versions/${v2Id}`, undefined, platform.token);
  await api("POST", `/platform/plans/${SLUG}/archive`, undefined, platform.token);
});

for (const vp of VIEWPORTS) {
  test(`plans catalog, detail and draft editor fit the viewport at ${vp.name}`, async ({ page }) => {
    const errors = trackConsole(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await seedAs(page, platform);
    await page.goto(`/platform/plans?plan=${SLUG}`);
    await expect(page.getByTestId("platform-plans")).toBeVisible();
    await expect(page.getByTestId("plan-create-open")).toBeVisible();
    await expect(page.getByTestId("plan-detail-title")).toHaveText(PLAN_NAME);
    expect(await pageOverflow(page), `overflow at ${vp.name} (catalog + detail)`).toBeLessThanOrEqual(1);
    // The draft editor: every primary control reachable, the form inside the viewport.
    await page.getByTestId(`version-open-${v2Id}`).click();
    await expect(page.getByTestId("version-editor")).toBeVisible();
    for (const id of ["version-validate", "version-save", "version-publish-open"]) {
      const b = page.getByTestId(id);
      await b.scrollIntoViewIfNeeded();
      await expect(b).toBeVisible();
    }
    await expectFitsViewport(page, "version-editor", vp.width);
    expect(await pageOverflow(page), `overflow at ${vp.name} (editor)`).toBeLessThanOrEqual(1);
    // The migration dialog from the published version fits the viewport (scope controls + actions).
    await page.getByTestId(`version-open-${v1Id}`).click();
    await expect(page.getByTestId("version-title")).toContainText("v1");
    const migrateOpen = page.getByTestId("version-migrate-open");
    await migrateOpen.scrollIntoViewIfNeeded();
    await migrateOpen.click();
    await expectFitsViewport(page, "migrate-dialog", vp.width);
    await expect(page.getByTestId("migrate-dry-run")).toBeVisible();
    await expect(page.getByTestId("migrate-execute")).toBeDisabled();
    await page.getByTestId("migrate-close").click();
    await expect(page.getByTestId("migrate-dialog")).toBeHidden();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test(`subscriptions list and the manage dialog with plan history fit the viewport at ${vp.name}`, async ({ page }) => {
    const errors = trackConsole(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await seedAs(page, platform);
    await page.goto("/platform/subscriptions");
    await expect(page.getByTestId("platform-subscriptions")).toBeVisible();
    await expect(page.getByTestId("sub-search")).toBeVisible();
    expect(await pageOverflow(page), `overflow at ${vp.name} (subscriptions)`).toBeLessThanOrEqual(1);
    // The deep link used by Companies / tenant detail ("Manage subscription") opens the manage dialog.
    await page.goto(`/platform/subscriptions?company=${companyId}`);
    await expectFitsViewport(page, "sub-detail", vp.width);
    await expect(page.getByTestId("plan-history-summary")).toContainText(`${SLUG} v1`);
    await page.getByTestId("plan-history-toggle").click();
    await expect(page.getByTestId("plan-history-table")).toBeVisible();
    await expectFitsViewport(page, "sub-detail", vp.width);
    expect(await pageOverflow(page), `overflow at ${vp.name} (manage dialog)`).toBeLessThanOrEqual(1);
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
