// =============================================================================
// Batch 18 hosted activation — BROWSER + API smoke (runs on the GitHub runner with
// a real Chromium against the hosted web app; never on the VPS). Uses the
// disposable principals created by b18-hosted.sh seed: tenant A (primary_admin +
// view-only employee), tenant B (primary_admin) and a disposable platform_owner.
// Prints one PASS/FAIL line per check, saves screenshots, exits non-zero on the
// first failed hard check. Never prints the password or any session token.
//
// Real-bucket / database evidence is fetched through `ssh vps … b18-hosted.sh
// gcs-list|db-logo|tenant-status` (the same pinned SSH identity the workflow set up).
//
// Env: SMOKE_BASE, SMOKE_STAMP, SMOKE_CO_A, SMOKE_CO_B, SMOKE_U_A, SMOKE_U_V,
//      SMOKE_U_B, SMOKE_U_P, SMOKE_EMAIL_A/V/B/P, SMOKE_PASSWORD_FILE, SMOKE_OUT,
//      SMOKE_PW_MODULE, SMOKE_VPS_ENV (env prefix for the VPS script).
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const env = (k, d) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`missing env ${k}`);
  return v;
};
const BASE = env("SMOKE_BASE").replace(/\/$/, "");
const API = `${BASE}/api`;
// Split portal hosts: platform_owner logins are only accepted on the Platform Owner
// portal host (elite.kaptnow.com), never on the customer portal host.
const PLATFORM_BASE = (process.env.SMOKE_PLATFORM_BASE || BASE).replace(/\/$/, "");
const PLATFORM_API = `${PLATFORM_BASE}/api`;
const STAMP = env("SMOKE_STAMP");
const CO_A = Number(env("SMOKE_CO_A")), CO_B = Number(env("SMOKE_CO_B"));
const U_A = Number(env("SMOKE_U_A")), U_V = Number(env("SMOKE_U_V")), U_B = Number(env("SMOKE_U_B")), U_P = Number(env("SMOKE_U_P"));
const EMAIL_A = env("SMOKE_EMAIL_A"), EMAIL_V = env("SMOKE_EMAIL_V"), EMAIL_B = env("SMOKE_EMAIL_B"), EMAIL_P = env("SMOKE_EMAIL_P");
const PASSWORD = fs.readFileSync(env("SMOKE_PASSWORD_FILE"), "utf8").trim();
const OUT = env("SMOKE_OUT", "b18-smoke-shots");
const VPS_ENV = env("SMOKE_VPS_ENV");
fs.mkdirSync(OUT, { recursive: true });
const pwMod = await import(pathToFileURL(path.resolve(env("SMOKE_PW_MODULE"))).href);
const chromium = (pwMod.default ?? pwMod).chromium;

const CO_A_NAME = `B18 SMOKE A ${STAMP}`;
const PRIMARY = "#0E7C86", SIDEBAR = "#12213A";
const PRIMARY_RGB = [14, 124, 134], SIDEBAR_RGB = [18, 33, 59];
const PLATFORM_PRIMARY = "24 100% 50%";
const LEGACY_ORIGIN = "https://legacy-logo.example";
const LEGACY = `${LEGACY_ORIGIN}/brand/logo.png`;
const T = 30_000;

const results = [];
let failed = 0;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failed += 1;
    throw new Error(`check failed: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function vps(cmd) {
  const out = execFileSync("ssh", ["vps", `${VPS_ENV} bash "$HOME/b18-hosted.sh" ${cmd}`], { input: "", encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
  return out.trim();
}
const vpsJson = (cmd) => JSON.parse(vps(cmd).split("\n").filter(Boolean).pop());

const tokens = {};
async function login(email, apiBase = API) {
  const res = await fetch(`${apiBase}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  const json = await res.json().catch(() => null);
  if (res.status !== 200 || !json?.token || json?.mfaRequired) throw new Error(`login failed for ${email}: HTTP ${res.status}`);
  return { token: json.token, user: json.user };
}
async function api(method, p, body, token, extraHeaders = {}, apiBase = API) {
  const res = await fetch(`${apiBase}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}
async function upload(token, bytes, contentType = "image/png") {
  const res = await fetch(`${API}/organization/branding/logo`, { method: "POST", headers: { "Content-Type": contentType, Authorization: `Bearer ${token}` }, body: new Uint8Array(bytes) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}
async function fetchLogo(url) {
  const res = await fetch(`${BASE}${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), length: buf.length };
}
const consoleErrors = [];
let shotN = 0;
async function shot(page, name) {
  shotN += 1;
  await page.screenshot({ path: path.join(OUT, `${String(shotN).padStart(2, "0")}-${name}.png`), fullPage: false });
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const cssVar = (page, n) => page.evaluate((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(), n);
const hasSheet = (page) => page.evaluate(() => !!document.getElementById("tenant-branding"));
const isDark = (page) => page.evaluate(() => document.documentElement.classList.contains("dark"));
const themeKeys = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("csp_theme")).sort());
const styleOf = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error(`no element for ${s}`); const cs = getComputedStyle(el); return { color: cs.color, background: cs.backgroundColor }; }, sel);
function rgb(s) { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) throw new Error(`not rgb: ${s}`); return m[1].split(",").slice(0, 3).map((x) => parseFloat(x)); }
const close = (s, e, tol = 2) => { const a = rgb(s); return Math.max(...a.map((v, i) => Math.abs(v - e[i]))) <= tol; };
function luminance(s) { const [r, g, b] = rgb(s).map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
const contrast = (fg, bg) => { const a = luminance(fg), b = luminance(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
async function waitFor(fn, ms = T) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
const waitCount = (locator, n) => waitFor(async () => (await locator.count()) === n);
// Branded surfaces animate (transition-colors): poll until the background settles on the
// expected color (returns the last observed value either way).
async function settle(pg, sel, expected) {
  let b = "";
  await waitFor(async () => { b = (await styleOf(pg, sel)).background; return close(b, expected); }, 10_000);
  return b;
}
// Minimal dependency-free RGBA PNG encoder (solid color) — a real, decodable image.
function makePng(width, height, rgba) {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
  const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const body = Buffer.concat([Buffer.from(type, "ascii"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { const row = y * (width * 4 + 1); raw[row] = 0; for (let x = 0; x < width; x++) { const o = row + 1 + x * 4; raw[o] = rgba[0]; raw[o + 1] = rgba[1]; raw[o + 2] = rgba[2]; raw[o + 3] = rgba[3]; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const LOGO_ROUTE = new RegExp(`^/api/branding/logos/${CO_A}/[0-9a-f]{32}$`);
const noLeak = (text) => !/storage\.googleapis|gs:\/\/|\.private|brandLogoKey|brand_logo_key|bucket|service-account|credential/i.test(text) && !new RegExp(`branding/${CO_A}/[0-9a-f]{32}\\.(png|jpe?g|webp)`).test(text);

// ── logins through the real API ────────────────────────────────────────────
const A = await login(EMAIL_A); tokens.A = A.token;
check("API login: tenant A primary_admin", A.user?.id === U_A && A.user?.role === "primary_admin" && A.user?.companyId === CO_A, `user ${A.user?.id} company ${A.user?.companyId}`);
const V = await login(EMAIL_V); tokens.V = V.token;
check("API login: tenant A view-only employee", V.user?.id === U_V && V.user?.role === "employee" && V.user?.companyId === CO_A);
const B = await login(EMAIL_B); tokens.B = B.token;
check("API login: tenant B primary_admin", B.user?.id === U_B && B.user?.companyId === CO_B);
const P = await login(EMAIL_P, PLATFORM_API); tokens.P = P.token;
check("API login: disposable platform_owner", P.user?.id === U_P && P.user?.role === "platform_owner");

// SMOKE_CHROMIUM_PATH: optional explicit Chromium binary (the runner uses the Playwright-installed one).
const browser = await chromium.launch(process.env.SMOKE_CHROMIUM_PATH ? { executablePath: process.env.SMOKE_CHROMIUM_PATH } : {});
function attach(page) {
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|legacy-logo\.example/.test(m.location()?.url ?? "") && !/legacy-logo\.example/.test(m.text())) consoleErrors.push(`${m.text().slice(0, 200)} @ ${m.location()?.url ?? ""}`); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror ${String(e).slice(0, 200)}`));
}
// The seed runs on ONE page (page-level init script, like the e2e fixture) so other
// pages of the same context can switch principal without being re-seeded.
async function seededContext(auth, theme, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const pg = await ctx.newPage();
  await pg.addInitScript(([t, u, cid, th]) => {
    localStorage.setItem("csp_token", t); localStorage.setItem("csp_user", u); localStorage.setItem("csp_company_id", cid);
    if (th) localStorage.setItem("csp_theme", th);
  }, [auth.token, JSON.stringify(auth.user), String(auth.user.companyId ?? ""), theme ?? ""]);
  attach(pg);
  return { ctx, page: pg };
}
let cardToken = "";
const { ctx: ctxA, page } = await seededContext(A, null);
try {
  // 1. fresh tenant = platform defaults, no injected stylesheet
  await page.goto(`${BASE}/admin/organization`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("branding-primary-hex").waitFor({ timeout: T });
  check("1a. fresh tenant: platform tokens, no #tenant-branding sheet", (await cssVar(page, "--primary")) === PLATFORM_PRIMARY && !(await hasSheet(page)) && !(await page.locator("html").getAttribute("data-tenant-branded")));
  check("1b. header shows the tenant identity with the platform mark (no logo)", (await page.getByTestId("brand-name").innerText()) === CO_A_NAME && (await page.getByTestId("link-brand").getAttribute("data-brand")) === "tenant" && (await page.getByTestId("brand-mark").count()) === 1 && (await page.getByTestId("brand-logo").count()) === 0);
  check("1c. Branding section shows defaults (empty hex, default theme, no logo, reset disabled)", (await page.getByTestId("branding-primary-hex").inputValue()) === "" && (await page.getByTestId("branding-theme-default").isChecked()) && (await page.getByTestId("branding-logo-preview").getAttribute("data-logo-source")) === "none" && (await page.getByTestId("branding-reset").isDisabled()) && (await page.getByTestId("branding-customized").count()) === 0);
  const mine0 = await api("GET", "/organization/branding", undefined, tokens.A);
  check("1d. API resolved defaults for the fresh tenant", mine0.status === 200 && mine0.json?.isCustomized === false && mine0.json?.primaryColor === "#FF6B00" && mine0.json?.logoUrl === null && noLeak(mine0.text));
  await shot(page, "fresh-tenant-defaults");

  // 2. update colors + default theme through the UI → immediate application
  await page.getByTestId("branding-primary-hex").fill("#7A7A7A");
  check("2a. unreadable color rejected inline; save blocked", (await waitCount(page.getByTestId("branding-primary-error"), 1)) && (await page.getByTestId("branding-save").isDisabled()));
  await page.getByTestId("branding-primary-hex").fill(PRIMARY);
  await page.getByTestId("branding-sidebar-hex").fill(SIDEBAR);
  await page.getByTestId("branding-theme-dark").check();
  check("2b. live preview mirrors the draft before saving", close((await styleOf(page, '[data-testid="branding-preview-light-header"]')).background, SIDEBAR_RGB) && close((await styleOf(page, '[data-testid="branding-preview-light-button"]')).background, PRIMARY_RGB) && (await cssVar(page, "--primary")) === PLATFORM_PRIMARY);
  await page.getByTestId("branding-save").click();
  await page.getByText("Branding saved").first().waitFor({ timeout: T });
  await page.locator('html[data-tenant-branded="true"]').waitFor({ timeout: T });
  await page.locator("html.dark").waitFor({ timeout: T }); // tenant default theme applies one effect after the sheet
  const m2 = { primary: await cssVar(page, "--primary"), sheet: await hasSheet(page), header: await settle(page, "header", SIDEBAR_RGB), sidebar: await settle(page, '[data-testid="admin-sidebar"]', SIDEBAR_RGB), nav: await settle(page, 'nav[aria-label="Primary"] a[aria-current="page"]', PRIMARY_RGB), button: await settle(page, "button.bg-primary", PRIMARY_RGB), dark: await isDark(page) };
  const activeNav = await styleOf(page, 'nav[aria-label="Primary"] a[aria-current="page"]');
  const btn = await styleOf(page, "button.bg-primary");
  check("2c. saved branding applies immediately: tokens, header, sidebar, active nav, primary button, dark default theme", /^18[456] 8[012]% 29%$/.test(m2.primary) && m2.sheet && close(m2.header, SIDEBAR_RGB) && close(m2.sidebar, SIDEBAR_RGB) && close(m2.nav, PRIMARY_RGB) && close(m2.button, PRIMARY_RGB) && m2.dark, JSON.stringify(m2));
  check("2d. contrast on branded surfaces ≥ 4.5:1 (active nav, primary button, header text)", contrast(activeNav.color, activeNav.background) >= 4.5 && contrast(btn.color, btn.background) >= 4.5 && contrast((await styleOf(page, '[data-testid="brand-name"]')).color, `rgb(${SIDEBAR_RGB.join(",")})`) >= 4.5);
  check("2e. no page-level horizontal overflow", (await overflow(page)) <= 1);
  const saved = await api("GET", "/organization/branding", undefined, tokens.A);
  check("2f. API persisted the normalized colors/theme", saved.json?.primaryColor === PRIMARY && saved.json?.sidebarColor === SIDEBAR && saved.json?.defaultTheme === "dark" && saved.json?.isCustomized === true && noLeak(saved.text));
  await shot(page, "branded-after-save");

  // 3. persistence across reload and a brand-new login through the shared login page
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("branding-primary-hex").waitFor({ timeout: T });
  await page.locator('html[data-tenant-branded="true"]').waitFor({ timeout: T });
  check("3a. branding survives a reload (tokens + editor values)", (await hasSheet(page)) && (await page.getByTestId("branding-primary-hex").inputValue()) === PRIMARY && (await page.getByTestId("branding-theme-dark").isChecked()) && (await page.getByTestId("branding-customized").count()) === 1);
  const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fp = await fresh.newPage(); attach(fp);
  await fp.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await fp.locator("#email").waitFor({ timeout: T });
  check("3b. shared login page keeps the platform branding", (await cssVar(fp, "--primary")) === PLATFORM_PRIMARY && !(await hasSheet(fp)) && (await fp.getByTestId("brand-logo").count()) === 0);
  await shot(fp, "login-platform-brand");
  await fp.locator("#email").fill(EMAIL_A);
  await fp.locator("#password").fill(PASSWORD);
  await fp.locator('button[type="submit"]').click();
  await fp.waitForURL(/\/admin(\?.*)?$/, { timeout: T });
  await fp.locator('html[data-tenant-branded="true"]').waitFor({ timeout: T });
  check("3c. a brand-new login lands branded (header identity + colors)", (await fp.getByTestId("brand-name").innerText()) === CO_A_NAME && close(await settle(fp, "header", SIDEBAR_RGB), SIDEBAR_RGB) && /^18[456] /.test(await cssVar(fp, "--primary")));
  await fresh.close();

  // 4. user theme preference overrides the tenant default; scoped per user + company
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("theme-toggle").waitFor({ timeout: T });
  await page.locator("html.dark").waitFor({ timeout: T });
  check("4a. no stored preference → tenant default (dark) applies", (await page.getByTestId("theme-toggle").getAttribute("data-theme-preference")) === "default" && (await themeKeys(page)).length === 0);
  await page.getByTestId("theme-toggle").click();
  await page.getByTestId("theme-option-default").waitFor({ timeout: T });
  const orgLabel = await page.getByTestId("theme-option-default").innerText();
  await page.getByTestId("theme-option-light").click();
  await page.locator("html:not(.dark)").waitFor({ timeout: T });
  const scopedKey = `csp_theme:u${U_A}c${CO_A}`;
  check("4b. explicit Light overrides the tenant default and is stored per user + company", orgLabel.includes("Organization default (Dark)") && JSON.stringify(await themeKeys(page)) === JSON.stringify([scopedKey]) && (await page.getByTestId("theme-toggle").getAttribute("data-theme-preference")) === "light");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("theme-toggle").waitFor({ timeout: T });
  await page.locator('html[data-tenant-branded="true"]').waitFor({ timeout: T });
  check("4c. the preference persists across reload while branding stays applied", !(await isDark(page)) && (await hasSheet(page)));
  await shot(page, "user-light-override");
  await page.getByTestId("theme-toggle").click();
  await page.getByTestId("theme-option-default").click();
  await page.locator("html.dark").waitFor({ timeout: T });
  check("4d. 'Organization default' returns to dark and removes the stored choice", (await themeKeys(page)).length === 0);
  await page.getByTestId("theme-toggle").click();
  await page.getByTestId("theme-option-light").click();
  await page.locator("html:not(.dark)").waitFor({ timeout: T });
  // Same browser storage, different member of the same company: no leaked preference.
  const vp = await ctxA.newPage(); attach(vp);
  await vp.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await vp.evaluate(([t, u, cid]) => { localStorage.setItem("csp_token", t); localStorage.setItem("csp_user", u); localStorage.setItem("csp_company_id", cid); }, [tokens.V, JSON.stringify(V.user), String(CO_A)]);
  await vp.goto(`${BASE}/admin/organization`, { waitUntil: "domcontentloaded" });
  await vp.getByTestId("theme-toggle").waitFor({ timeout: T });
  await vp.locator("html.dark").waitFor({ timeout: T });
  check("4e. another member in the same browser gets the tenant default (dark), not the admin's Light", (await vp.getByTestId("theme-toggle").getAttribute("data-theme-preference")) === "default" && JSON.stringify(await themeKeys(vp)) === JSON.stringify([scopedKey]));

  // 5. view-only member: reads branding, cannot mutate
  await vp.getByTestId("branding-readonly").waitFor({ timeout: T });
  check("5a. view-only member sees the read-only state with disabled controls", (await vp.getByTestId("branding-primary-hex").isDisabled()) && (await vp.getByTestId("branding-logo-replace").isDisabled()) && (await vp.getByTestId("branding-save").isDisabled()) && (await vp.getByTestId("branding-reset").isDisabled()) && (await hasSheet(vp)));
  await shot(vp, "view-only-member");
  const vGet = await api("GET", "/organization/branding", undefined, tokens.V);
  const vPut = await api("PUT", "/organization/branding", { primaryColor: "#1D4ED8" }, tokens.V);
  const vUp = await upload(tokens.V, makePng(64, 64, [0, 0, 0, 255]));
  const vDel = await api("DELETE", "/organization/branding/logo", undefined, tokens.V);
  check("5b. API: view-only member GET 200, PUT/upload/remove 403", vGet.status === 200 && vGet.json?.primaryColor === PRIMARY && vPut.status === 403 && vUp.status === 403 && vDel.status === 403, `${vGet.status}/${vPut.status}/${vUp.status}/${vDel.status}`);
  await vp.close();

  // 6. second tenant cannot read or change tenant A's branding
  const bOwn = await api("GET", "/organization/branding", undefined, tokens.B);
  const bCross = await api("GET", `/companies/${CO_A}/branding`, undefined, tokens.B);
  const bCrossPut = await api("PUT", `/companies/${CO_A}/branding`, { primaryColor: "#1D4ED8" }, tokens.B);
  const bCrossReset = await api("POST", `/companies/${CO_A}/branding/reset`, undefined, tokens.B);
  const bPut = await api("PUT", "/organization/branding", { primaryColor: "#1D4ED8", defaultTheme: "light" }, tokens.B);
  const aAfterB = await api("GET", "/organization/branding", undefined, tokens.A);
  check("6a. tenant B: own defaults; cross-tenant read/update/reset of A denied; B's own change never touches A", bOwn.status === 200 && bOwn.json?.isCustomized === false && bCross.status >= 403 && bCrossPut.status >= 403 && bCrossReset.status >= 403 && bPut.status === 200 && bPut.json?.primaryColor === "#1D4ED8" && aAfterB.json?.primaryColor === PRIMARY && aAfterB.json?.sidebarColor === SIDEBAR, `cross ${bCross.status}/${bCrossPut.status}/${bCrossReset.status}`);
  const { ctx: ctxB, page: bp } = await seededContext(B, "light");
  await bp.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  await bp.getByTestId("brand-name").waitFor({ timeout: T });
  await bp.locator('html[data-tenant-branded="true"]').waitFor({ timeout: T });
  check("6b. tenant B's portal shows only B's branding (blue primary, platform sidebar, own name)", (await bp.getByTestId("brand-name").innerText()) === `B18 SMOKE B ${STAMP}` && /^22[0-9] /.test(await cssVar(bp, "--primary")) && !close((await styleOf(bp, "header")).background, SIDEBAR_RGB) && (await bp.getByTestId("brand-logo").count()) === 0, `--primary ${await cssVar(bp, "--primary")}`);
  await shot(bp, "tenant-b-own-branding");
  const bReset = await api("POST", "/organization/branding/reset", undefined, tokens.B);
  await bp.reload({ waitUntil: "domcontentloaded" });
  await bp.getByTestId("brand-name").waitFor({ timeout: T });
  await waitFor(async () => !(await hasSheet(bp)));
  check("6c. tenant B reset → platform look again; A unchanged", bReset.status === 200 && bReset.json?.isCustomized === false && !(await hasSheet(bp)) && (await cssVar(bp, "--primary")) === PLATFORM_PRIMARY && (await api("GET", "/organization/branding", undefined, tokens.A)).json?.primaryColor === PRIMARY);
  await ctxB.close();

  // 7. platform owner: explicit-company routes only; platform portal keeps platform branding
  const pSelf = await api("GET", "/organization/branding", undefined, tokens.P, {}, PLATFORM_API);
  const pRead = await api("GET", `/companies/${CO_A}/branding`, undefined, tokens.P, {}, PLATFORM_API);
  const pPut = await api("PUT", `/companies/${CO_A}/branding`, { defaultTheme: "system" }, tokens.P, {}, PLATFORM_API);
  const pRestore = await api("PUT", `/companies/${CO_A}/branding`, { defaultTheme: "dark" }, tokens.P, {}, PLATFORM_API);
  check("7a. platform owner: tenant route 403; explicit-company read/update 200 (theme system → dark restored)", pSelf.status === 403 && pRead.status === 200 && pRead.json?.primaryColor === PRIMARY && pRead.json?.companyId === CO_A && pPut.status === 200 && pPut.json?.defaultTheme === "system" && pRestore.status === 200 && pRestore.json?.defaultTheme === "dark" && noLeak(pRead.text), `${pSelf.status}/${pRead.status}/${pPut.status}/${pRestore.status}`);
  const { ctx: ctxP, page: pp } = await seededContext(P, "light");
  await pp.goto(`${PLATFORM_BASE}/platform`, { waitUntil: "domcontentloaded" });
  await pp.getByTestId("brand-name").waitFor({ timeout: T });
  await pp.getByTestId("theme-toggle").click();
  await pp.getByTestId("theme-option-light").waitFor({ timeout: T });
  check("7b. platform-owner portal keeps the platform branding (name, mark, tokens, no org-default theme option)", (await pp.getByTestId("brand-name").innerText()) === "Lead Capture Pro" && (await pp.getByTestId("link-brand").getAttribute("data-brand")) === "platform" && (await cssVar(pp, "--primary")) === PLATFORM_PRIMARY && !(await hasSheet(pp)) && (await pp.getByTestId("theme-option-default").count()) === 0);
  await pp.keyboard.press("Escape");
  await shot(pp, "platform-portal");
  await ctxP.close();

  // 8. cancelled tenant: read yes, mutate no; restored before cleanup
  const st1 = vps("tenant-status cancelled");
  const cGet = await api("GET", "/organization/branding", undefined, tokens.A);
  const cPut = await api("PUT", "/organization/branding", { primaryColor: PRIMARY }, tokens.A);
  const cUp = await upload(tokens.A, makePng(64, 64, [0, 0, 0, 255]));
  const cReset = await api("POST", "/organization/branding/reset", undefined, tokens.A);
  const st2 = vps("tenant-status active");
  const rPut = await api("PUT", "/organization/branding", { primaryColor: PRIMARY }, tokens.A);
  check("8. cancelled tenant: GET 200, PUT/upload/reset 403; restored to active → PUT 200", st1.includes("STATUS=cancelled") && cGet.status === 200 && cPut.status === 403 && cUp.status === 403 && cReset.status === 403 && st2.includes("STATUS=active") && rPut.status === 200 && rPut.json?.primaryColor === PRIMARY, `${cGet.status}/${cPut.status}/${cUp.status}/${cReset.status} then ${rPut.status}`);

  // 9. managed logo through the real bucket: upload → serve → replace → remove
  await page.goto(`${BASE}/admin/organization`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("branding-logo-upload").waitFor({ state: "attached", timeout: T });
  await page.getByTestId("branding-logo-upload").setInputFiles({ name: "logo-a.png", mimeType: "image/png", buffer: makePng(240, 96, [14, 124, 134, 230]) });
  await page.getByText("Logo uploaded").first().waitFor({ timeout: T });
  await page.getByTestId("branding-logo-image").waitFor({ timeout: T });
  const logo1 = await page.getByTestId("branding-logo-image").getAttribute("src");
  check("9a. UI upload → first-party randomized route; header + sidebar + editor render it", LOGO_ROUTE.test(logo1) && (await waitCount(page.getByTestId("brand-logo"), 1)) && (await page.getByTestId("brand-logo").getAttribute("src")) === logo1 && (await page.getByTestId("sidebar-company-logo").count()) === 1 && (await page.getByTestId("branding-logo-preview").getAttribute("data-logo-source")) === "managed", logo1);
  const served1 = await fetchLogo(logo1);
  check("9b. logo bytes served publicly with image/png, immutable caching", served1.status === 200 && served1.type === "image/png" && /immutable/.test(served1.cache ?? "") && served1.length > 100, `${served1.status} ${served1.type} ${served1.cache} ${served1.length}B`);
  const g1 = vpsJson(`gcs-list ${CO_A}`);
  const id1 = logo1.split("/").pop();
  check("9c. REAL bucket holds exactly one object for the tenant: branding/<companyId>/<random-id>.png, size = served bytes", g1.count === 1 && g1.objects[0].key === `branding/${CO_A}/${id1}.png` && g1.objects[0].size === served1.length && g1.objects[0].contentType === "image/png", JSON.stringify(g1));
  const db1 = vps(`db-logo ${CO_A}`).split("\n").pop();
  check("9d. database stores only the internal object key + content type (brand_logo_key ~ branding/<companyId>/<32 hex>.png)", db1.startsWith(`branding/${CO_A}/${id1}.png|image/png|<null>|true|`), db1);
  const mineL = await api("GET", "/organization/branding", undefined, tokens.A);
  check("9e. API responses expose only the /api/branding/logos route — no key, bucket, gs:// or credential", mineL.json?.logoUrl === logo1 && noLeak(mineL.text));
  const logoNatural = await page.getByTestId("branding-logo-image").evaluate((el) => el.naturalWidth);
  check("9f. logo image decoded in the browser (natural width)", logoNatural === 240, `${logoNatural}px`);
  await shot(page, "managed-logo-uploaded");
  await page.getByTestId("branding-logo-upload").setInputFiles({ name: "logo-b.png", mimeType: "image/png", buffer: makePng(300, 120, [249, 115, 22, 255]) });
  await page.getByText("Logo replaced").first().waitFor({ timeout: T });
  await waitFor(async () => (await page.getByTestId("branding-logo-image").getAttribute("src")) !== logo1);
  const logo2 = await page.getByTestId("branding-logo-image").getAttribute("src");
  const old1 = await fetchLogo(logo1), new2 = await fetchLogo(logo2);
  const g2 = vpsJson(`gcs-list ${CO_A}`);
  check("9g. replace → new random id served, old public route 404, bucket holds only the new object", LOGO_ROUTE.test(logo2) && logo2 !== logo1 && old1.status === 404 && new2.status === 200 && g2.count === 1 && g2.objects[0].key === `branding/${CO_A}/${logo2.split("/").pop()}.png` && g2.objects[0].size === new2.length, `old ${old1.status} new ${new2.status} ${JSON.stringify(g2)}`);
  await page.getByTestId("branding-logo-remove").click();
  await page.getByTestId("branding-confirm-remove").click();
  await page.getByText("Logo removed").first().waitFor({ timeout: T });
  await waitCount(page.getByTestId("branding-logo-image"), 0);
  const gone2 = await fetchLogo(logo2);
  const g3 = vpsJson(`gcs-list ${CO_A}`);
  check("9h. remove → route 404, fallback mark in header/sidebar, zero objects in the bucket prefix", gone2.status === 404 && (await page.getByTestId("brand-mark").count()) === 1 && (await page.getByTestId("brand-logo").count()) === 0 && (await page.getByTestId("sidebar-company-mark").count()) === 1 && g3.count === 0 && (await api("GET", "/organization/branding", undefined, tokens.A)).json?.logoUrl === null, JSON.stringify(g3));
  const rejected = await upload(tokens.A, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml");
  const disguised = await upload(tokens.A, Buffer.from("not an image at all"), "image/png");
  check("9i. unsupported / disguised uploads are rejected (4xx) and store nothing", rejected.status >= 400 && rejected.status < 500 && disguised.status === 400 && vpsJson(`gcs-list ${CO_A}`).count === 0, `${rejected.status}/${disguised.status}`);
  const up3 = await upload(tokens.A, makePng(200, 80, [14, 124, 134, 255]));
  const logo3 = up3.json?.logoUrl;
  check("9j. API upload for the public card → one object again", up3.status === 200 && LOGO_ROUTE.test(logo3 ?? "") && vpsJson(`gcs-list ${CO_A}`).count === 1, `${up3.status}`);

  // 10. public digital business card
  const card = await api("PUT", "/cards/me", { fullName: `B18 Smoke Card ${STAMP}`, designation: "Head of Partnerships", companyName: CO_A_NAME, email: EMAIL_A, primaryPhone: "+971500001122" }, tokens.A);
  cardToken = card.json?.publicToken ?? "";
  check("10a. disposable digital card created and published", card.status < 300 && cardToken.length > 0);
  const pub = await api("GET", `/cards/public/${cardToken}`);
  check("10b. public card API exposes exactly the documented public branding fields, nothing private", pub.status === 200 && JSON.stringify(Object.keys(pub.json.branding).sort()) === JSON.stringify(["defaultTheme", "logoUrl", "primaryColor", "primaryForeground", "sidebarColor", "sidebarForeground"]) && pub.json.branding.primaryColor === PRIMARY && pub.json.branding.logoUrl === logo3 && noLeak(pub.text) && !/vatNumber|registrationNumber|primaryContactEmail|"plan"|"status"|companyId/.test(pub.text));
  const cardLogo = await fetch(`${API}/cards/public/${cardToken}/logo`);
  check("10c. public card logo route serves the managed logo", cardLogo.status === 200 && cardLogo.headers.get("content-type") === "image/png");
  const ctxPub = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const cp = await ctxPub.newPage(); attach(cp);
  await cp.goto(`${BASE}/c/${cardToken}`, { waitUntil: "domcontentloaded" });
  await cp.getByTestId("public-card").waitFor({ timeout: T });
  await cp.getByTestId("public-card-logo").waitFor({ timeout: T });
  const natural = await waitFor(() => cp.getByTestId("public-card-logo").evaluate((el) => el.naturalWidth));
  check("10d. public page uses the tenant colors + managed logo, responsive, keeps 'Powered by Elite Marcom'", (await cp.getByTestId("public-card").getAttribute("data-branded")) === "true" && close(await cp.getByTestId("public-card").evaluate((el) => getComputedStyle(el).backgroundColor), SIDEBAR_RGB) && close(await cp.getByTestId("public-card-band").evaluate((el) => getComputedStyle(el).backgroundColor), PRIMARY_RGB) && natural > 0 && (await cp.getByText(/Powered by Elite Marcom/).count()) === 1 && (await overflow(cp)) <= 1 && (await cp.getByTestId("theme-toggle").count()) === 0 && !(await hasSheet(cp)));
  await shot(cp, "public-card-branded");
  await ctxPub.close();

  // 11. legacy logo boundary
  const rm = await api("DELETE", "/organization/branding/logo", undefined, tokens.A);
  const rs = await api("POST", "/organization/branding/reset", undefined, tokens.A);
  const lg = await api("PATCH", "/organization", { logoUrl: LEGACY }, tokens.A);
  const legacyOnly = await api("GET", "/organization/branding", undefined, tokens.A);
  const pubLegacyOnly = await api("GET", `/cards/public/${cardToken}`);
  check("11a. legacy-only: authenticated read shows the legacy fallback; public branding stays null; bucket empty", rm.status === 200 && rs.status === 200 && lg.status === 200 && legacyOnly.json?.logoSource === "legacy" && legacyOnly.json?.logoUrl === LEGACY && legacyOnly.json?.isCustomized === false && pubLegacyOnly.json?.branding === null && !pubLegacyOnly.text.includes("legacy-logo.example") && vpsJson(`gcs-list ${CO_A}`).count === 0);
  const lc = await api("PUT", "/organization/branding", { primaryColor: PRIMARY, sidebarColor: SIDEBAR }, tokens.A);
  const legacyColors = await api("GET", "/organization/branding", undefined, tokens.A);
  const pubLegacyColors = await api("GET", `/cards/public/${cardToken}`);
  const cardLogo404 = await fetch(`${API}/cards/public/${cardToken}/logo`);
  check("11b. legacy + colors: public colors returned with logoUrl null; no legacy URL anywhere public; logo route 404", lc.status === 200 && legacyColors.json?.logoSource === "legacy" && legacyColors.json?.logoUrl === LEGACY && pubLegacyColors.json?.branding?.logoUrl === null && pubLegacyColors.json?.branding?.primaryColor === PRIMARY && !pubLegacyColors.text.includes("legacy-logo.example") && cardLogo404.status === 404);
  const ctxV = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const legacyRequests = [];
  ctxV.on("request", (r) => { if (r.url().startsWith(LEGACY_ORIGIN)) legacyRequests.push(r.url()); });
  await ctxV.route(`${LEGACY_ORIGIN}/**`, (route) => route.abort());
  const lp = await ctxV.newPage(); attach(lp);
  await lp.goto(`${BASE}/c/${cardToken}`, { waitUntil: "networkidle" });
  await lp.getByTestId("public-card").waitFor({ timeout: T });
  const resources = await lp.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes("legacy-logo.example")));
  check("11c. public page: colors applied, no logo element, DOM/resources/requests contain nothing from the legacy origin", (await lp.getByTestId("public-card").getAttribute("data-branded")) === "true" && close(await lp.getByTestId("public-card-band").evaluate((el) => getComputedStyle(el).backgroundColor), PRIMARY_RGB) && (await lp.getByTestId("public-card-logo").count()) === 0 && (await lp.getByTestId("public-card-logo-strip").count()) === 0 && !(await lp.content()).includes("legacy-logo.example") && resources.length === 0 && legacyRequests.length === 0, `legacy requests: ${legacyRequests.length}`);
  await shot(lp, "public-card-legacy-boundary");
  await lp.close();
  const mp = await ctxV.newPage(); attach(mp);
  await mp.addInitScript(([t, u, cid]) => { localStorage.setItem("csp_token", t); localStorage.setItem("csp_user", u); localStorage.setItem("csp_company_id", cid); localStorage.setItem("csp_theme", "light"); }, [tokens.A, JSON.stringify(A.user), String(CO_A)]);
  await mp.goto(`${BASE}/admin/organization`, { waitUntil: "domcontentloaded" });
  await mp.getByTestId("branding-logo-preview").waitFor({ timeout: T });
  await waitFor(() => legacyRequests.length > 0);
  check("11d. authenticated shell still shows the legacy fallback (and requests it)", (await mp.getByTestId("branding-logo-preview").getAttribute("data-logo-source")) === "legacy" && (await mp.getByTestId("branding-logo-image").getAttribute("src")) === LEGACY && (await mp.getByTestId("brand-logo").getAttribute("src")) === LEGACY && legacyRequests.length > 0);
  await ctxV.close();
  const finalReset = await api("POST", "/organization/branding/reset", undefined, tokens.A);
  const pubFinal = await api("GET", `/cards/public/${cardToken}`);
  const ctxF = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const fpg = await ctxF.newPage(); attach(fpg);
  await fpg.goto(`${BASE}/c/${cardToken}`, { waitUntil: "domcontentloaded" });
  await fpg.getByTestId("public-card").waitFor({ timeout: T });
  check("11e. reset → public card back to the platform design (no branding, orange band, no logo, attribution kept)", finalReset.status === 200 && finalReset.json?.isCustomized === false && finalReset.json?.logoUrl === null && pubFinal.json?.branding === null && (await fpg.getByTestId("public-card").getAttribute("data-branded")) === "false" && close(await fpg.getByTestId("public-card-band").evaluate((el) => getComputedStyle(el).backgroundColor), [249, 115, 22]) && (await fpg.getByTestId("public-card-logo").count()) === 0 && (await fpg.getByText(/Powered by Elite Marcom/).count()) === 1);
  await shot(fpg, "public-card-platform-design");
  await ctxF.close();

  // 12. tenant portal after reset: platform look immediately (no leftover sheet)
  await page.goto(`${BASE}/admin/organization`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("branding-primary-hex").waitFor({ timeout: T });
  await waitFor(async () => !(await hasSheet(page)));
  check("12. after reset the tenant portal renders the platform defaults again (bucket prefix empty)", !(await hasSheet(page)) && (await cssVar(page, "--primary")) === PLATFORM_PRIMARY && (await page.getByTestId("brand-mark").count()) === 1 && vpsJson(`gcs-list ${CO_A}`).count === 0 && vpsJson(`gcs-list ${CO_B}`).count === 0);
  await shot(page, "tenant-after-reset");
  check("console: no unexpected browser errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
} catch (e) {
  try { await page.screenshot({ path: path.join(OUT, "99-failure.png"), fullPage: false }); console.log("failure screenshot saved; url:", page.url()); } catch { /* page gone */ }
  throw e;
} finally {
  await browser.close().catch(() => {});
  try { vps("tenant-status active"); } catch { /* best effort */ }
  if (cardToken) await api("DELETE", "/cards/me", undefined, tokens.A).catch(() => {});
  for (const k of Object.keys(tokens)) { await api("POST", "/auth/logout", {}, tokens[k], {}, k === "P" ? PLATFORM_API : API).catch(() => {}); tokens[k] = ""; }
  console.log(`\nSMOKE SUMMARY: ${results.filter((r) => r.ok).length} passed, ${failed} failed; tenant A=${CO_A} tenant B=${CO_B}; screenshots in ${OUT}`);
}
process.exit(failed === 0 ? 0 : 1);
