import zlib from "node:zlib";
import { Client } from "pg";
import type { Page } from "@playwright/test";
import { test, expect, state } from "./fixtures/workspace";
import { API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * W. Batch 18 — Tenant Branding.
 *
 * Drives Organization → Branding against the real API and proves the resolved
 * branding is applied to the authenticated tenant portal (header identity, sidebar,
 * primary surfaces, focus/chart tokens) immediately, survives reload and a brand-new
 * login, that a member's own light/dark/system choice overrides the tenant default
 * and is scoped per user + company, that managed logos are uploaded / replaced /
 * removed through validated endpoints (with the storage-failure state leaving the
 * previous branding intact), that unsaved color changes are protected on links,
 * Cancel, reload and browser Back/Forward (B17 guard), that the public digital
 * business card carries only the tenant's public branding, that the shared login page
 * and the platform-owner portal keep the platform look, and that two tenants never
 * display each other's branding. No AI, no email, no live object storage: the local
 * stack serves logos from the in-memory branding store.
 */

const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 1024, height: 768 };
const MOBILE = { width: 390, height: 844 };
const PLATFORM_PRIMARY = "24 100% 50%";
const PRIMARY = "#0E7C86"; // teal → rgb(14,124,134), hsl ≈ 185 81% 29%
const SIDEBAR = "#12213A"; // navy → rgb(18,33,59)
const PRIMARY_RGB = "rgb(14, 124, 134)";
const SIDEBAR_RGB = "rgb(18, 33, 59)";
const PASSWORD = "BrViewer123!";
const VIEWER_EMAIL = `${RUN_TAG.toLowerCase()}.brand-viewer@example.test`;

type Auth = { token: string; user: { id: number; companyId: number; email: string; role?: string } };
type Theme = "light" | "dark" | "system";

let pg: Client;
let admin: Auth;
let nexus: Auth;
let viewer: Auth;
let companyName = "";
let hadCardBefore = false;
let cardToken = "";
let currentLogoUrl: string | null = null;
let firstLogoUrl: string | null = null;

async function api(method: string, path: string, body?: unknown, token: string | null = state.token) {
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

async function login(email: string, password = "Admin123!"): Promise<Auth> {
  const res = await api("POST", "/auth/login", { email, password }, null);
  expect(res.status, res.text).toBe(200);
  return { token: res.json.token, user: res.json.user };
}

/** Real login token seeded the way the app boots. `theme: null` leaves no stored preference. */
async function seedAs(page: Page, auth: Auth, theme: Theme | null = "light") {
  await page.addInitScript(
    ([t, u, companyId, th]) => {
      try {
        localStorage.setItem("csp_token", t as string);
        localStorage.setItem("csp_user", u as string);
        localStorage.setItem("csp_company_id", companyId as string);
        if (th) localStorage.setItem("csp_theme", th as string);
      } catch {
        /* storage unavailable */
      }
    },
    [auth.token, JSON.stringify(auth.user), String(auth.user.companyId ?? ""), theme ?? ""] as const,
  );
}

const cssVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const hasSheet = (page: Page) => page.evaluate(() => !!document.getElementById("tenant-branding"));
const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));
const pageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const storageKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("csp_theme")).sort());

async function styleOf(page: Page, selector: string): Promise<{ color: string; background: string }> {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`no element for ${s}`);
    const cs = getComputedStyle(el);
    return { color: cs.color, background: cs.backgroundColor };
  }, selector);
}

function parseRgb(s: string): [number, number, number] {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`not an rgb color: ${s}`);
  const p = m[1].split(",").map((x) => parseFloat(x.trim()));
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

function luminance(rgb: string): number {
  const [r, g, b] = parseRgb(rgb).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two computed rgb() colors. */
function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Derived colors round-trip through HSL, so branded surfaces may differ by a unit per channel. */
function expectColorClose(actual: string, expected: string, tolerance = 2) {
  const a = parseRgb(actual);
  const e = parseRgb(expected);
  const distance = Math.max(Math.abs(a[0] - e[0]), Math.abs(a[1] - e[1]), Math.abs(a[2] - e[2]));
  expect(distance, `${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}

/** Minimal dependency-free RGBA PNG encoder (solid color with alpha) — a real, decodable image. */
function makePng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buf: Buffer) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 4;
      raw[o] = rgba[0];
      raw[o + 1] = rgba[1];
      raw[o + 2] = rgba[2];
      raw[o + 3] = rgba[3];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function gotoBranding(page: Page) {
  await page.goto("/admin/organization");
  await expect(page.getByTestId("branding-section")).toBeVisible();
  await expect(page.getByTestId("branding-primary-hex")).toBeVisible();
}

async function expectPlatformLook(page: Page) {
  expect(await cssVar(page, "--primary")).toBe(PLATFORM_PRIMARY);
  expect(await hasSheet(page)).toBe(false);
  await expect(page.locator("html")).not.toHaveAttribute("data-tenant-branded", "true");
}

async function expectBrandedLook(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-tenant-branded", "true");
  expect(await cssVar(page, "--primary")).toMatch(/^18[456] 8[012]% 29%$/);
  expect(await hasSheet(page)).toBe(true);
  expectColorClose((await styleOf(page, "header")).background, SIDEBAR_RGB);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  admin = { token: state.token, user: state.user as Auth["user"] };
  nexus = await login("admin@nexussys.io");

  // Start from the platform defaults no matter what an earlier run left behind.
  const reset = await api("POST", "/organization/branding/reset");
  expect(reset.status, reset.text).toBe(200);
  expect(reset.json.isCustomized).toBe(false);

  const org = await api("GET", "/organization");
  expect(org.status, org.text).toBe(200);
  companyName = org.json.name;

  hadCardBefore = (await api("GET", "/cards/me")).status === 200;

  // A view-only member through the real management API (organization:view only).
  const created = await api("POST", "/users", { email: VIEWER_EMAIL, password: PASSWORD, name: `${RUN_TAG} Branding viewer`, role: "employee" });
  expect(created.status, created.text).toBeLessThan(300);
  await pg.query(`UPDATE users SET permissions = $1::jsonb WHERE email = $2`, [JSON.stringify({ organization: ["view"] }), VIEWER_EMAIL]);
  viewer = await login(VIEWER_EMAIL, PASSWORD);
});

test.afterAll(async () => {
  try {
    await api("POST", "/organization/branding/reset");
    if (!hadCardBefore) await api("DELETE", "/cards/me");
    const res = await pg.query(`SELECT id FROM users WHERE email = $1`, [VIEWER_EMAIL]);
    for (const row of res.rows) {
      await pg.query(`DELETE FROM sessions WHERE user_id = $1`, [row.id]);
      await pg.query(`DELETE FROM user_roles WHERE user_id = $1`, [row.id]);
      await pg.query(`DELETE FROM verification_tokens WHERE user_id = $1`, [row.id]);
      await pg.query(`DELETE FROM login_attempts WHERE user_id = $1`, [row.id]);
      await pg.query(`DELETE FROM trusted_devices WHERE user_id = $1`, [row.id]);
      await pg.query(`DELETE FROM audit_logs WHERE user_id = $1`, [row.id]);
      await pg.query(`DELETE FROM users WHERE id = $1`, [row.id]);
    }
  } finally {
    await pg.end();
  }
});

test("an unbranded tenant renders the platform defaults and the Branding section shows them", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAs(page, admin);
  await gotoBranding(page);

  await expectPlatformLook(page);
  await expect(page.getByTestId("branding-customized")).toHaveCount(0);
  await expect(page.getByTestId("branding-primary-hex")).toHaveValue("");
  await expect(page.getByTestId("branding-primary-hex")).toHaveAttribute("placeholder", /#FF6B00/);
  await expect(page.getByTestId("branding-sidebar-hex")).toHaveAttribute("placeholder", /#1A1C2E/);
  await expect(page.getByTestId("branding-theme-default")).toBeChecked();
  await expect(page.getByTestId("branding-logo-preview")).toHaveAttribute("data-logo-source", "none");
  await expect(page.getByTestId("branding-logo-image")).toHaveCount(0);
  await expect(page.getByTestId("branding-reset")).toBeDisabled();
  await expect(page.getByTestId("branding-save")).toBeDisabled();
  await expect(page.getByTestId("branding-preview-light")).toBeVisible();
  await expect(page.getByTestId("branding-preview-dark")).toBeVisible();

  // Tenant identity in the header even without custom colors; no logo → the platform mark.
  await expect(page.getByTestId("link-brand")).toHaveAttribute("data-brand", "tenant");
  await expect(page.getByTestId("brand-name")).toHaveText(companyName);
  await expect(page.getByTestId("brand-mark")).toBeVisible();
  await expect(page.getByTestId("brand-logo")).toHaveCount(0);
});

test("invalid and unreadable colors are rejected inline, saving stays blocked, Cancel restores the draft", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAs(page, admin);
  await gotoBranding(page);

  await page.getByTestId("branding-primary-hex").fill("#12");
  await expect(page.getByTestId("branding-primary-error")).toContainText("6-digit hex");
  await expect(page.getByTestId("branding-primary-hex")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("branding-dirty")).toBeVisible();
  await expect(page.getByTestId("branding-save")).toBeDisabled();

  await page.getByTestId("branding-primary-hex").fill("#7A7A7A");
  await expect(page.getByTestId("branding-primary-error")).toContainText("minimum 4.5:1");
  await expect(page.getByTestId("branding-save")).toBeDisabled();

  await page.getByTestId("branding-sidebar-hex").fill("red");
  await expect(page.getByTestId("branding-sidebar-error")).toContainText("6-digit hex");

  await page.getByTestId("branding-cancel").click();
  await expect(page.getByTestId("branding-primary-hex")).toHaveValue("");
  await expect(page.getByTestId("branding-sidebar-hex")).toHaveValue("");
  await expect(page.getByTestId("branding-primary-error")).toHaveCount(0);
  await expect(page.getByTestId("branding-sidebar-error")).toHaveCount(0);
  await expect(page.getByTestId("branding-dirty")).toHaveCount(0);
  await expect(page.getByTestId("branding-section")).toHaveAttribute("data-dirty", "false");
  // Nothing reached the server.
  expect((await api("GET", "/organization/branding")).json.isCustomized).toBe(false);
  await expectPlatformLook(page);
});

test("configuring colors and the default theme applies immediately to header, sidebar, primary surfaces and tokens", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAs(page, admin, null); // no stored preference → the tenant default decides
  await gotoBranding(page);
  expect(await isDark(page)).toBe(false);

  await page.getByTestId("branding-primary-hex").fill(PRIMARY);
  await page.getByTestId("branding-sidebar-hex").fill(SIDEBAR);
  await page.getByTestId("branding-theme-dark").check();
  await expect(page.getByTestId("branding-dirty")).toBeVisible();

  // The live preview mirrors the draft before anything is saved.
  expectColorClose((await styleOf(page, '[data-testid="branding-preview-light-header"]')).background, SIDEBAR_RGB);
  expectColorClose((await styleOf(page, '[data-testid="branding-preview-light-button"]')).background, PRIMARY_RGB);
  expectColorClose((await styleOf(page, '[data-testid="branding-preview-dark-nav-active"]')).background, PRIMARY_RGB);
  const previewBtn = await styleOf(page, '[data-testid="branding-preview-light-button"]');
  expect(contrast(previewBtn.color, previewBtn.background)).toBeGreaterThanOrEqual(4.5);
  // The portal itself is still on the platform look until Save.
  await expectPlatformLook(page);

  await page.getByTestId("branding-save").click();
  await expect(page.getByText("Branding saved").first()).toBeVisible();
  await expect(page.getByTestId("branding-customized")).toBeVisible();
  await expect(page.getByTestId("branding-dirty")).toHaveCount(0);
  await expect(page.getByTestId("branding-reset")).toBeEnabled();

  // Applied at once: tokens, header, sidebar, active navigation, primary button, chart + ring accents.
  await expectBrandedLook(page);
  // Focus rings and text links use the contrast-safe variant of the brand hue (lightness adapted per mode).
  expect(await cssVar(page, "--ring")).toMatch(/^18[456] 8[012]% \d+%$/);
  expect(await cssVar(page, "--brand-link")).toMatch(/^18[456] 8[012]% \d+%$/);
  expect(await cssVar(page, "--chart-1")).toBe(await cssVar(page, "--primary"));
  expect(await cssVar(page, "--sidebar-primary")).toBe(await cssVar(page, "--primary"));
  await expect(page.locator("html")).toHaveClass(/dark/); // tenant default theme = dark
  expectColorClose((await styleOf(page, '[data-testid="admin-sidebar"]')).background, SIDEBAR_RGB);
  const active = await styleOf(page, 'nav[aria-label="Primary"] a[aria-current="page"]');
  expectColorClose(active.background, PRIMARY_RGB);
  expect(contrast(active.color, active.background)).toBeGreaterThanOrEqual(4.5);
  const header = await styleOf(page, '[data-testid="brand-name"]');
  expect(contrast(header.color, SIDEBAR_RGB)).toBeGreaterThanOrEqual(4.5);
  const button = await styleOf(page, "button.bg-primary");
  expectColorClose(button.background, PRIMARY_RGB);
  expect(contrast(button.color, button.background)).toBeGreaterThanOrEqual(4.5);

  const saved = await api("GET", "/organization/branding");
  expect(saved.json.primaryColor).toBe(PRIMARY);
  expect(saved.json.sidebarColor).toBe(SIDEBAR);
  expect(saved.json.defaultTheme).toBe("dark");
  expect(saved.json.isCustomized).toBe(true);
});

test("branding persists after a reload and after a brand-new login through the shared login page", async ({ page, browser }) => {
  await page.setViewportSize(DESKTOP);
  await seedAs(page, admin);
  await gotoBranding(page);
  await expectBrandedLook(page);
  await expect(page.getByTestId("branding-primary-hex")).toHaveValue(PRIMARY);
  await expect(page.getByTestId("branding-sidebar-hex")).toHaveValue(SIDEBAR);
  await expect(page.getByTestId("branding-theme-dark")).toBeChecked();

  await page.reload();
  await expect(page.getByTestId("branding-section")).toBeVisible();
  await expectBrandedLook(page);
  await expect(page.getByTestId("branding-customized")).toBeVisible();
  await expect(page.getByTestId("branding-primary-hex")).toHaveValue(PRIMARY);

  // A fresh browser profile, a real login: the login page is platform-branded, the portal is not.
  const context = await browser.newContext({ viewport: DESKTOP });
  const fresh = await context.newPage();
  await fresh.goto("/login");
  await expect(fresh.locator("#email")).toBeVisible();
  await expectPlatformLook(fresh);
  await fresh.locator("#email").fill(admin.user.email);
  await fresh.locator("#password").fill("Admin123!");
  await fresh.locator('button[type="submit"]').click();
  await fresh.waitForURL("**/admin");
  await expect(fresh.getByTestId("brand-name")).toHaveText(companyName);
  await expectBrandedLook(fresh);
  await context.close();
});

test("a member's own theme choice overrides the tenant default and never leaks to another tenant in the same browser", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAs(page, admin, null);
  await page.goto("/admin");
  await expect(page.getByTestId("theme-toggle")).toBeVisible();

  // No preference stored → the tenant default (dark) applies.
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByTestId("theme-toggle")).toHaveAttribute("data-theme-preference", "default");
  expect(await storageKeys(page)).toEqual([]);

  // An explicit choice wins and is stored per user + company only.
  await page.getByTestId("theme-toggle").click();
  await expect(page.getByTestId("theme-option-default")).toContainText("Organization default (Dark)");
  await page.getByTestId("theme-option-light").click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  const scopedKey = `csp_theme:u${admin.user.id}c${admin.user.companyId}`;
  expect(await storageKeys(page)).toEqual([scopedKey]);
  await expect(page.getByTestId("theme-toggle")).toHaveAttribute("data-theme-preference", "light");

  await page.reload();
  await expect(page.getByTestId("theme-toggle")).toHaveAttribute("data-theme-preference", "light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expectBrandedLook(page);

  // Back to "Organization default" → dark again, the stored choice is gone.
  await page.getByTestId("theme-toggle").click();
  await page.getByTestId("theme-option-default").click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await storageKeys(page)).toEqual([]);

  // Leave a light preference behind, then boot the OTHER tenant in the same browser storage.
  await page.getByTestId("theme-toggle").click();
  await page.getByTestId("theme-option-light").click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  const other = await page.context().newPage(); // no init script → whatever localStorage holds
  await other.goto("/login");
  await other.evaluate(
    ([t, u, cid]) => {
      localStorage.setItem("csp_token", t);
      localStorage.setItem("csp_user", u);
      localStorage.setItem("csp_company_id", cid);
    },
    [nexus.token, JSON.stringify(nexus.user), String(nexus.user.companyId)] as const,
  );
  await other.goto("/admin");
  await expect(other.getByTestId("theme-toggle")).toBeVisible();
  await expect(other.getByTestId("brand-name")).not.toHaveText(companyName);
  await expect(other.getByTestId("theme-toggle")).toHaveAttribute("data-theme-preference", "default");
  await expect(other.locator("html")).not.toHaveClass(/dark/);
  await expectPlatformLook(other);
  expect(await storageKeys(other)).toEqual([scopedKey]); // TechCorp's key untouched, none for the other tenant
  await other.getByTestId("theme-toggle").click();
  await expect(other.getByTestId("theme-option-default")).toHaveCount(0); // no tenant default → no such option
  await other.keyboard.press("Escape");
  await other.close();
});

test("logo upload, replace and remove apply to the header, sidebar and preview; unsupported files are rejected", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAs(page, admin);
  await gotoBranding(page);
  const cid = admin.user.companyId;
  const logoSrc = new RegExp(`^/api/branding/logos/${cid}/[0-9a-f]{32}$`);

  // Client-side pre-checks: wrong type and oversized files never reach the server.
  let uploads = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/organization/branding/logo")) uploads++;
  });
  await page.getByTestId("branding-logo-upload").setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") });
  await expect(page.getByText("Unsupported file type").first()).toBeVisible();
  await page.getByTestId("branding-logo-upload").setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 1) });
  await expect(page.getByText("Logo too large").first()).toBeVisible();
  expect(uploads).toBe(0);

  // A renamed non-image is rejected by the server; branding stays unchanged.
  await page.getByTestId("branding-logo-upload").setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("this is not an image at all, just text pretending to be a png") });
  await expect(page.getByText("Logo rejected").first()).toBeVisible();
  expect(uploads).toBe(1);
  await expect(page.getByTestId("branding-logo-image")).toHaveCount(0);
  expect((await api("GET", "/organization/branding")).json.logoUrl).toBeNull();

  // Upload a real transparent PNG.
  await page.getByTestId("branding-logo-upload").setInputFiles({ name: "logo-a.png", mimeType: "image/png", buffer: makePng(200, 80, [14, 124, 134, 220]) });
  await expect(page.getByText("Logo uploaded").first()).toBeVisible();
  const img = page.getByTestId("branding-logo-image");
  await expect(img).toBeVisible();
  firstLogoUrl = await img.getAttribute("src");
  expect(firstLogoUrl).toMatch(logoSrc);
  await expect(page.getByTestId("branding-logo-preview")).toHaveAttribute("data-logo-source", "managed");
  await expect(page.getByTestId("brand-logo")).toBeVisible();
  await expect(page.getByTestId("brand-logo")).toHaveAttribute("src", firstLogoUrl!);
  await expect(page.getByTestId("brand-mark")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-company-logo")).toBeVisible();
  await expect(page.getByTestId("branding-preview-light").locator("img")).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(200);
  // The managed URL is an API route, not a storage location, and serves the image.
  const served = await fetch(`${API_BASE.replace(/\/api$/, "")}${firstLogoUrl}`);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(served.headers.get("cache-control")).toContain("immutable");

  // Replace → a new id; the previous route is gone.
  await page.getByTestId("branding-logo-replace").click({ trial: true });
  await page.getByTestId("branding-logo-upload").setInputFiles({ name: "logo-b.png", mimeType: "image/png", buffer: makePng(300, 120, [249, 115, 22, 255]) });
  await expect(page.getByText("Logo replaced").first()).toBeVisible();
  await expect(img).not.toHaveAttribute("src", firstLogoUrl!);
  const secondLogoUrl = (await img.getAttribute("src"))!;
  expect(secondLogoUrl).toMatch(logoSrc);
  await expect(page.getByTestId("brand-logo")).toHaveAttribute("src", secondLogoUrl);
  expect((await fetch(`${API_BASE.replace(/\/api$/, "")}${firstLogoUrl}`)).status).toBe(404);
  expect((await fetch(`${API_BASE.replace(/\/api$/, "")}${secondLogoUrl}`)).status).toBe(200);

  // Remove → confirmation → fallback mark everywhere; the object route is gone.
  await page.getByTestId("branding-logo-remove").click();
  await expect(page.getByTestId("branding-confirm-dialog")).toBeVisible();
  await page.getByTestId("branding-confirm-remove").click();
  await expect(page.getByText("Logo removed").first()).toBeVisible();
  await expect(page.getByTestId("branding-logo-image")).toHaveCount(0);
  await expect(page.getByTestId("branding-logo-preview")).toHaveAttribute("data-logo-source", "none");
  await expect(page.getByTestId("brand-mark")).toBeVisible();
  await expect(page.getByTestId("brand-logo")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-company-logo")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-company-mark")).toBeVisible();
  expect((await fetch(`${API_BASE.replace(/\/api$/, "")}${secondLogoUrl}`)).status).toBe(404);
  expect((await api("GET", "/organization/branding")).json.logoUrl).toBeNull();
  // Colors survive logo changes.
  await expectBrandedLook(page);
});

test("a storage failure during upload shows the storage state and leaves the previous logo untouched", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAs(page, admin);
  await gotoBranding(page);

  await page.getByTestId("branding-logo-upload").setInputFiles({ name: "logo-a.png", mimeType: "image/png", buffer: makePng(160, 64, [14, 124, 134, 255]) });
  await expect(page.getByText("Logo uploaded").first()).toBeVisible();
  currentLogoUrl = await page.getByTestId("branding-logo-image").getAttribute("src");
  expect(currentLogoUrl).toBeTruthy();

  // Make the (non-production) logo store fail exactly once for the next upload.
  await page.route("**/api/organization/branding/logo", async (route) => {
    await route.continue({ headers: { ...route.request().headers(), "x-branding-test-storage-fail": "1" } });
  });
  await page.getByTestId("branding-logo-upload").setInputFiles({ name: "logo-b.png", mimeType: "image/png", buffer: makePng(160, 64, [249, 115, 22, 255]) });
  const alert = page.getByTestId("branding-storage-error");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Your current branding was not changed");
  await expect(alert.getByRole("button", { name: "Try again" })).toBeEnabled();
  await page.unroute("**/api/organization/branding/logo");

  // Previous logo still in place on the page, in the header and on the server.
  await expect(page.getByTestId("branding-logo-image")).toHaveAttribute("src", currentLogoUrl!);
  await expect(page.getByTestId("brand-logo")).toHaveAttribute("src", currentLogoUrl!);
  expect((await api("GET", "/organization/branding")).json.logoUrl).toBe(currentLogoUrl);
  expect((await fetch(`${API_BASE.replace(/\/api$/, "")}${currentLogoUrl}`)).status).toBe(200);

  // "Try again" re-opens the file picker and clears the alert.
  const chooser = page.waitForEvent("filechooser");
  await alert.getByRole("button", { name: "Try again" }).click();
  await chooser;
  await expect(page.getByTestId("branding-storage-error")).toHaveCount(0);
});

test("unsaved color changes are protected on in-app links, reload, tab close and browser Back/Forward; Cancel clears them", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAs(page, admin);
  await page.goto("/admin/contacts");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Organization Profile" }).click();
  await expect(page).toHaveURL(/\/admin\/organization$/);
  await expect(page.getByTestId("branding-primary-hex")).toHaveValue(PRIMARY);
  await expect(page.getByTestId("branding-section")).toHaveAttribute("data-dirty", "false");
  const orgUrl = page.url();
  const lengthBefore = await page.evaluate(() => history.length);
  const armed = () =>
    page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
  expect(await armed()).toBe(false);

  await page.getByTestId("branding-primary-hex").click();
  await page.getByTestId("branding-primary-hex").fill("#1D4ED8");
  await expect(page.getByTestId("branding-dirty")).toBeVisible();
  await expect(page.getByTestId("branding-section")).toHaveAttribute("data-dirty", "true");
  expect(await armed()).toBe(true);

  // In-app link → dialog → Stay keeps URL and draft.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Contacts" }).click();
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  expect(page.url()).toBe(orgUrl);
  await page.getByTestId("unsaved-stay").click();
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
  await expect(page.getByTestId("branding-primary-hex")).toHaveValue("#1D4ED8");

  // Browser Back → dialog; nothing moves while it is open; Stay cancels the traversal cleanly.
  await page.goBack({ waitUntil: "commit" });
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  expect(page.url()).toBe(orgUrl);
  await expect(page.getByTestId("branding-primary-hex")).toHaveValue("#1D4ED8");
  expect(await page.evaluate(() => history.length)).toBe(lengthBefore);
  await page.getByTestId("unsaved-stay").click();
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
  expect(page.url()).toBe(orgUrl);
  await expect(page.getByTestId("branding-dirty")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);

  // Back again → Discard completes the Back exactly once; the server never saw the draft.
  await page.goBack({ waitUntil: "commit" });
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  await page.getByTestId("unsaved-discard").click();
  await expect(page).toHaveURL(/\/admin\/contacts$/);
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
  expect(await page.evaluate(() => history.length)).toBe(lengthBefore);
  expect((await api("GET", "/organization/branding")).json.primaryColor).toBe(PRIMARY);
  await expectBrandedLook(page);

  // Forward → clean section with the saved values, no dialog; Forward on a dirty section is guarded too.
  await page.goForward({ waitUntil: "commit" });
  await expect(page).toHaveURL(/\/admin\/organization$/);
  await expect(page.getByTestId("branding-primary-hex")).toHaveValue(PRIMARY);
  await expect(page.getByTestId("branding-section")).toHaveAttribute("data-dirty", "false");
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
  await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(/\/admin\/contacts$/);
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
  await page.goForward({ waitUntil: "commit" });
  await expect(page).toHaveURL(/\/admin\/organization$/);
  await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(/\/admin\/contacts$/);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Organization Profile" }).click();
  await expect(page).toHaveURL(/\/admin\/organization$/);
  await page.getByTestId("branding-sidebar-hex").click();
  await page.getByTestId("branding-sidebar-hex").fill("#0F172A");
  await expect(page.getByTestId("branding-dirty")).toBeVisible();

  // Cancel clears the draft; Back then traverses freely.
  await page.getByTestId("branding-cancel").click();
  await expect(page.getByTestId("branding-dirty")).toHaveCount(0);
  await expect(page.getByTestId("branding-sidebar-hex")).toHaveValue(SIDEBAR);
  expect(await armed()).toBe(false);
  await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(/\/admin\/contacts$/);
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);

  // Real browser beforeunload prompt on tab close (user activation from the click).
  const second = await page.context().newPage();
  await seedAs(second, admin);
  await second.goto("/admin/organization");
  await second.getByTestId("branding-primary-hex").click();
  await second.getByTestId("branding-primary-hex").fill("#1D4ED8");
  await expect(second.getByTestId("branding-dirty")).toBeVisible();
  const dialog = second.waitForEvent("dialog");
  await second.close({ runBeforeUnload: true });
  const d = await dialog;
  expect(d.type()).toBe("beforeunload");
  await d.accept();
  expect((await api("GET", "/organization/branding")).json.sidebarColor).toBe(SIDEBAR);
});

test("branded surfaces stay readable in dark and light mode, on tablet and mobile widths and in RTL", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAs(page, admin, "dark");
  await gotoBranding(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectBrandedLook(page);
  expect(await pageOverflow(page)).toBe(0);

  const readable = async () => {
    const aside = await styleOf(page, '[data-testid="admin-sidebar"]');
    expectColorClose(aside.background, SIDEBAR_RGB);
    const link = await styleOf(page, 'nav[aria-label="Primary"] a:not([aria-current="page"])');
    expect(contrast(link.color, aside.background)).toBeGreaterThanOrEqual(4.5);
    const active = await styleOf(page, 'nav[aria-label="Primary"] a[aria-current="page"]');
    expectColorClose(active.background, PRIMARY_RGB);
    expect(contrast(active.color, active.background)).toBeGreaterThanOrEqual(4.5);
    const brand = await styleOf(page, '[data-testid="brand-name"]');
    expect(contrast(brand.color, SIDEBAR_RGB)).toBeGreaterThanOrEqual(4.5);
    const button = await styleOf(page, "button.bg-primary");
    expect(contrast(button.color, button.background)).toBeGreaterThanOrEqual(4.5);
    const companyText = await styleOf(page, '[data-testid="text-sidebar-company"]');
    expect(contrast(companyText.color, aside.background)).toBeGreaterThanOrEqual(4.5);
  };
  await readable();

  // Light mode via the member's own choice.
  await page.getByTestId("theme-toggle").click();
  await page.getByTestId("theme-option-light").click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expectBrandedLook(page);
  await readable();

  // Tablet: sidebar still branded, no horizontal overflow.
  await page.setViewportSize(TABLET);
  await expect(page.getByTestId("admin-sidebar")).toBeVisible();
  expect(await pageOverflow(page)).toBe(0);
  await readable();

  // Mobile: branded header with the logo, branded drawer.
  await page.setViewportSize(MOBILE);
  expect(await pageOverflow(page)).toBe(0);
  expectColorClose((await styleOf(page, "header")).background, SIDEBAR_RGB);
  await expect(page.getByTestId("brand-logo")).toBeVisible();
  await page.getByTestId("button-mobile-nav").click();
  const drawer = page.locator('[role="dialog"].tenant-sidebar, [role="dialog"] .tenant-sidebar').first();
  await expect(drawer).toBeVisible();
  expectColorClose(await drawer.evaluate((el) => getComputedStyle(el).backgroundColor), SIDEBAR_RGB);
  await expect(page.locator('[role="dialog"]').getByRole("link", { name: "Contacts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await expect(page.getByTestId("branding-section")).toBeVisible();
  await expect(page.getByTestId("branding-preview-light")).toBeVisible();

  // RTL: mirrored layout, same branded surfaces, no overflow.
  await page.setViewportSize(DESKTOP);
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
  });
  expect(await pageOverflow(page)).toBe(0);
  await expectBrandedLook(page);
  await readable();
  await expect(page.getByTestId("branding-preview-dark")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dir = "ltr";
  });
});

test("the public digital business card carries the tenant's public branding and nothing private", async ({ browser }) => {
  const card = await api("PUT", "/cards/me", { fullName: `${RUN_TAG} Card Owner`, designation: "Head of Partnerships", companyName, email: `${RUN_TAG.toLowerCase()}.card@example.test`, primaryPhone: "+971500001122" });
  expect(card.status, card.text).toBe(200);
  cardToken = card.json.publicToken;
  expect(cardToken).toBeTruthy();

  const pub = await fetch(`${API_BASE}/cards/public/${cardToken}`);
  expect(pub.status).toBe(200);
  const text = await pub.text();
  const json = JSON.parse(text);
  expect(Object.keys(json.branding).sort()).toEqual(["defaultTheme", "logoUrl", "primaryColor", "primaryForeground", "sidebarColor", "sidebarForeground"]);
  expect(json.branding.primaryColor).toBe(PRIMARY);
  expect(json.branding.sidebarColor).toBe(SIDEBAR);
  expect(json.branding.logoUrl).toBe(currentLogoUrl);
  // No storage paths, object keys, company ids or bucket names on the public surface.
  expect(text).not.toMatch(/storage\.googleapis|gs:\/\/|\.private|brandLogoKey|brand_logo_key|bucket/i);
  expect(text).not.toMatch(/branding\/\d+\/[0-9a-f]{32}\.(png|jpe?g|webp)/);
  const logo = await fetch(`${API_BASE}/cards/public/${cardToken}/logo`);
  expect(logo.status).toBe(200);
  expect(logo.headers.get("content-type")).toBe("image/png");

  const context = await browser.newContext({ viewport: MOBILE });
  const page = await context.newPage();
  await page.goto(`/c/${cardToken}`);
  const cardEl = page.getByTestId("public-card");
  await expect(cardEl).toBeVisible();
  await expect(cardEl).toHaveAttribute("data-branded", "true");
  expectColorClose(await cardEl.evaluate((el) => getComputedStyle(el).backgroundColor), SIDEBAR_RGB);
  expectColorClose(await page.getByTestId("public-card-band").evaluate((el) => getComputedStyle(el).backgroundColor), PRIMARY_RGB);
  const logoImg = page.getByTestId("public-card-logo");
  await expect(logoImg).toBeVisible();
  await expect(logoImg).toHaveAttribute("src", currentLogoUrl!);
  await expect.poll(() => logoImg.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText(`${RUN_TAG} Card Owner`)).toBeVisible();
  await expect(page.getByText(/Powered by/)).toBeVisible(); // platform attribution kept
  expect(await pageOverflow(page)).toBe(0);
  // The public card is not a portal: no tenant sheet, no auth surfaces.
  expect(await hasSheet(page)).toBe(false);
  await expect(page.getByTestId("theme-toggle")).toHaveCount(0);
  await context.close();
});

test("the shared login page and the platform-owner portal keep the platform branding", async ({ page, browser }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/login");
  await expect(page.locator("#email")).toBeVisible();
  await expectPlatformLook(page);
  await expect(page.getByTestId("brand-logo")).toHaveCount(0);

  const owner = await login("admin@cardscannerpro.com");
  const context = await browser.newContext({ viewport: DESKTOP });
  const platform = await context.newPage();
  await seedAs(platform, owner);
  await platform.goto("/platform");
  await expect(platform.getByTestId("brand-name")).toBeVisible();
  await expect(platform.getByTestId("brand-name")).toHaveText("Lead Capture Pro");
  await expect(platform.getByTestId("link-brand")).toHaveAttribute("data-brand", "platform");
  await expect(platform.getByTestId("brand-logo")).toHaveCount(0);
  await expectPlatformLook(platform);
  await platform.getByTestId("theme-toggle").click();
  await expect(platform.getByTestId("theme-option-default")).toHaveCount(0);
  await platform.keyboard.press("Escape");
  // Platform operators never receive the tenant self-service branding endpoint.
  expect((await api("GET", "/organization/branding", undefined, owner.token)).status).toBe(403);
  await context.close();
});

test("two tenants never display each other's branding; logout and a tenant switch drop the branding at once", async ({ page, browser }) => {
  await page.setViewportSize(DESKTOP);
  await seedAs(page, nexus);
  await page.goto("/admin");
  await expect(page.getByTestId("brand-name")).toBeVisible();
  await expect(page.getByTestId("brand-name")).not.toHaveText(companyName);
  await expect(page.getByTestId("link-brand")).toHaveAttribute("data-brand", "tenant");
  await expect(page.getByTestId("brand-mark")).toBeVisible();
  await expect(page.getByTestId("brand-logo")).toHaveCount(0);
  await expectPlatformLook(page);
  await expect(page.getByTestId("admin-sidebar")).not.toHaveClass(/tenant-sidebar/);
  const own = await api("GET", "/organization/branding", undefined, nexus.token);
  expect(own.status).toBe(200);
  expect(own.json.isCustomized).toBe(false);
  expect(own.json.logoUrl).toBeNull();
  // The other tenant's branding is not reachable through the tenant surface by id.
  expect((await api("GET", `/companies/${admin.user.companyId}/branding`, undefined, nexus.token)).status).toBeGreaterThanOrEqual(403);

  // A separate real session for TechCorp so signing out here revokes nothing shared.
  const techcorp = await login(admin.user.email);
  const context = await browser.newContext({ viewport: DESKTOP });
  const tc = await context.newPage();
  await seedAs(tc, techcorp);
  await tc.goto("/admin");
  await expect(tc.getByTestId("brand-name")).toHaveText(companyName);
  await expectBrandedLook(tc);
  await expect(tc.getByTestId("brand-logo")).toBeVisible();

  // Sign out → platform look immediately, no leftover sheet on the login page.
  await tc.getByTestId("button-user-menu").click();
  await tc.getByText("Sign Out").click();
  await tc.waitForURL("**/login");
  await expectPlatformLook(tc);
  await expect(tc.getByTestId("brand-logo")).toHaveCount(0);

  // Switching the signed-in tenant in the same tab (no reload) resets the branding as well.
  const swap = await context.newPage();
  await swap.goto("/login");
  await swap.evaluate(
    ([t, u, cid]) => {
      localStorage.setItem("csp_token", t);
      localStorage.setItem("csp_user", u);
      localStorage.setItem("csp_company_id", cid);
    },
    [nexus.token, JSON.stringify(nexus.user), String(nexus.user.companyId)] as const,
  );
  await swap.goto("/admin");
  await expect(swap.getByTestId("brand-name")).not.toHaveText(companyName);
  await expectPlatformLook(swap);
  await context.close();
});

test("Reset to platform default clears colors, theme and logo for the portal and the public card", async ({ page, browser }) => {
  await page.setViewportSize(DESKTOP);
  await seedAs(page, admin);
  await gotoBranding(page);
  await expectBrandedLook(page);
  await expect(page.getByTestId("branding-logo-image")).toBeVisible();

  await page.getByTestId("branding-reset").click();
  await expect(page.getByTestId("branding-confirm-dialog")).toBeVisible();
  await page.getByTestId("branding-confirm-reset").click();
  await expect(page.getByText("Branding reset to the platform default").first()).toBeVisible();

  await expectPlatformLook(page);
  await expect(page.getByTestId("branding-customized")).toHaveCount(0);
  await expect(page.getByTestId("branding-reset")).toBeDisabled();
  await expect(page.getByTestId("branding-primary-hex")).toHaveValue("");
  await expect(page.getByTestId("branding-sidebar-hex")).toHaveValue("");
  await expect(page.getByTestId("branding-theme-default")).toBeChecked();
  await expect(page.getByTestId("branding-logo-image")).toHaveCount(0);
  await expect(page.getByTestId("brand-mark")).toBeVisible();
  await expect(page.getByTestId("brand-logo")).toHaveCount(0);
  await expect(page.getByTestId("admin-sidebar")).not.toHaveClass(/tenant-sidebar/);
  expect((await styleOf(page, "header")).background).not.toBe(SIDEBAR_RGB);
  const after = await api("GET", "/organization/branding");
  expect(after.json.isCustomized).toBe(false);
  expect(after.json.logoUrl).toBeNull();
  expect(after.json.defaultTheme).toBe("system");
  expect((await fetch(`${API_BASE.replace(/\/api$/, "")}${currentLogoUrl}`)).status).toBe(404);

  // Public card falls back to the platform card look with no logo.
  const pub = await api("GET", `/cards/public/${cardToken}`, undefined, null);
  expect(pub.status).toBe(200);
  expect(pub.json.branding).toBeNull();
  expect((await fetch(`${API_BASE}/cards/public/${cardToken}/logo`)).status).toBe(404);
  const context = await browser.newContext({ viewport: MOBILE });
  const pc = await context.newPage();
  await pc.goto(`/c/${cardToken}`);
  await expect(pc.getByTestId("public-card")).toHaveAttribute("data-branded", "false");
  await expect(pc.getByTestId("public-card-logo")).toHaveCount(0);
  expect(await pc.getByTestId("public-card-band").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(249, 115, 22)");
  await expect(pc.getByText(/Powered by/)).toBeVisible();
  await context.close();
});

test("a view-only member sees the branding but cannot change it", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAs(page, viewer);
  await gotoBranding(page);
  await expect(page.getByTestId("branding-readonly")).toBeVisible();
  await expect(page.getByTestId("branding-primary-hex")).toBeDisabled();
  await expect(page.getByTestId("branding-sidebar-picker")).toBeDisabled();
  await expect(page.getByTestId("branding-theme-dark")).toBeDisabled();
  await expect(page.getByTestId("branding-logo-replace")).toBeDisabled();
  await expect(page.getByTestId("branding-save")).toBeDisabled();
  await expect(page.getByTestId("branding-reset")).toBeDisabled();
  await expect(page.getByTestId("branding-preview-light")).toBeVisible();
  expect((await api("PUT", "/organization/branding", { primaryColor: PRIMARY }, viewer.token)).status).toBe(403);
  expect((await api("GET", "/organization/branding", undefined, viewer.token)).status).toBe(200);
});
