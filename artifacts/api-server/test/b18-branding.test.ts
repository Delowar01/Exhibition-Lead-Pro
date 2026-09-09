import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { eq, like, and, inArray } from "drizzle-orm";
import sharp from "sharp";
import { db, companiesTable, usersTable, auditLogsTable, loginAttemptsTable, businessCardsTable, subscriptionsTable } from "@workspace/db";

// Batch 18 — Tenant branding. Runs against the LIVE API (localhost:80) like the
// other integration suites. Logo storage is the in-process memory driver
// outside production (no bucket configured locally), so nothing touches GCS.
// Two REAL companies (A, B) prove isolation; everything is torn down in afterAll.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b18qa-${SUFFIX}.test`;
const ADMIN_A = `admin-a@${DOMAIN}`;
const ADMIN_B = `admin-b@${DOMAIN}`;
const EMP_VIEW = `emp-view@${DOMAIN}`;
const EMP_EDIT = `emp-edit@${DOMAIN}`;

let platformToken = "";
let tokenA = "";
let tokenB = "";
let tokenEmpView = "";
let tokenEmpEdit = "";
let companyA = 0;
let companyB = 0;
let adminAId = 0;
let tokenBCard = "";
const userIds: number[] = [];

const DEFAULTS = { primaryColor: "#FF6B00", sidebarColor: "#1A1C2E", defaultTheme: "system" };

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}
async function login(email: string, password = PW): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}
async function api(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${BASE}${path}`, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body) });
}
async function upload(path: string, token: string, bytes: Buffer, contentType: string, extraHeaders: Record<string, string> = {}) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType, Authorization: `Bearer ${token}`, ...extraHeaders },
    body: new Uint8Array(bytes),
  });
}
async function json(res: Response) {
  return res.json() as Promise<Record<string, any>>;
}
async function createUser(body: Record<string, unknown>) {
  const res = await api("POST", "/users", platformToken, { password: PW, ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  const u = await json(res);
  userIds.push(u.id);
  return u;
}

// ── image fixtures (generated in-process; no files, no network) ─────────────
const png = (w: number, h: number, alpha = true) =>
  sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: 30, g: 120, b: 200, alpha: 0.5 } : { r: 30, g: 120, b: 200 } } }).png().toBuffer();
const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg({ quality: 80 }).toBuffer();
const webp = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 10, g: 200, b: 90, alpha: 0.6 } } }).webp().toBuffer();
// Incompressible pixels at PNG compression level 0 → comfortably above 2 MB.
const hugePng = () => sharp(randomBytes(1000 * 1000 * 3), { raw: { width: 1000, height: 1000, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
const SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><script>alert(1)</script><rect width="200" height="200"/></svg>`);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40, 0)]);
const HTML = Buffer.from("<!doctype html><html><body><img src=x onerror=alert(1)></body></html>");

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  for (const [name, setter] of [
    [`QA B18 Branding A ${SUFFIX}`, (id: number) => (companyA = id)],
    [`QA B18 Branding B ${SUFFIX}`, (id: number) => (companyB = id)],
  ] as const) {
    const res = await api("POST", "/companies", platformToken, { name, plan: "professional" });
    expect(res.status, await res.clone().text()).toBe(201);
    const c = await json(res);
    setter(c.id);
    await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, c.id));
  }
  const a = await createUser({ email: ADMIN_A, name: "B18 Admin A", role: "primary_admin", companyId: companyA });
  adminAId = a.id;
  await createUser({ email: ADMIN_B, name: "B18 Admin B", role: "primary_admin", companyId: companyB });
  const empView = await createUser({ email: EMP_VIEW, name: "B18 Employee view", role: "employee", companyId: companyA });
  const empEdit = await createUser({ email: EMP_EDIT, name: "B18 Employee edit", role: "employee", companyId: companyA });
  await db.update(usersTable).set({ permissions: { organization: ["view"] } }).where(eq(usersTable.id, empView.id));
  await db.update(usersTable).set({ permissions: { organization: ["view", "edit"] } }).where(eq(usersTable.id, empEdit.id));
  tokenA = await login(ADMIN_A);
  tokenB = await login(ADMIN_B);
  tokenEmpView = await login(EMP_VIEW);
  tokenEmpEdit = await login(EMP_EDIT);
});

afterAll(async () => {
  for (const id of [companyA, companyB]) {
    if (!id) continue;
    await db.delete(auditLogsTable).where(eq(auditLogsTable.companyId, id));
    await api("DELETE", `/companies/${id}`, platformToken);
  }
  if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${DOMAIN}`));
});

async function branding(token: string) {
  const res = await api("GET", "/organization/branding", token);
  expect(res.status, await res.clone().text()).toBe(200);
  return json(res);
}
async function auditActions(companyId: number, action: string) {
  return db.select().from(auditLogsTable).where(and(eq(auditLogsTable.companyId, companyId), eq(auditLogsTable.action, action)));
}

describe("default resolution", () => {
  it("a fresh tenant resolves to the platform defaults with no overrides", async () => {
    const b = await branding(tokenA);
    expect(b).toMatchObject({
      companyId: companyA,
      logoUrl: null,
      logoSource: "none",
      ...DEFAULTS,
      overrides: { primaryColor: null, sidebarColor: null, defaultTheme: null, logo: false },
      defaults: DEFAULTS,
      isCustomized: false,
    });
    expect(b.derived.primaryForeground).toBe("#FFFFFF"); // the platform's own foreground for the platform default
    expect(b.derived.sidebarForeground).toBe("#FFFFFF");
    expect(b.derived.sidebarContrast).toBeGreaterThanOrEqual(4.5);
    expect(b.derived.tokens.primary).toMatch(/^2[45] 100% 50%$/); // hex→HSL rounding of #FF6B00
    expect(b.derived.tokens.sidebar).toMatch(/^23[34] 28% 14%$/); // hex→HSL rounding of the platform navy
  });

  it("any authenticated member can read branding; platform operators cannot use the tenant route", async () => {
    expect((await api("GET", "/organization/branding", tokenEmpView)).status).toBe(200);
    expect((await api("GET", "/organization/branding", tokenEmpEdit)).status).toBe(200);
    expect((await api("GET", "/organization/branding", platformToken)).status).toBe(403);
    expect((await fetch(`${BASE}/organization/branding`)).status).toBe(401);
  });

  it("a legacy https logoUrl is surfaced as a legacy logo; non-https values are ignored", async () => {
    let res = await api("PATCH", "/organization", tokenA, { logoUrl: "https://cdn.example.test/legacy-logo.png" });
    expect(res.status).toBe(200);
    let b = await branding(tokenA);
    expect(b.logoSource).toBe("legacy");
    expect(b.logoUrl).toBe("https://cdn.example.test/legacy-logo.png");
    expect(b.overrides.logo).toBe(false);
    res = await api("PATCH", "/organization", tokenA, { logoUrl: "http://insecure.example.test/logo.png" });
    expect(res.status).toBe(200);
    b = await branding(tokenA);
    expect(b.logoSource).toBe("none");
    expect(b.logoUrl).toBeNull();
    await api("PATCH", "/organization", tokenA, { logoUrl: null });
  });
});

describe("color and theme validation", () => {
  it("normalizes valid hex colors to #RRGGBB and stores nothing else", async () => {
    const res = await api("PUT", "/organization/branding", tokenA, { primaryColor: "1e3a8a", sidebarColor: "#0F172A", defaultTheme: "dark" });
    expect(res.status, await res.clone().text()).toBe(200);
    const b = await json(res);
    expect(b.primaryColor).toBe("#1E3A8A");
    expect(b.sidebarColor).toBe("#0F172A");
    expect(b.defaultTheme).toBe("dark");
    expect(b.overrides).toMatchObject({ primaryColor: "#1E3A8A", sidebarColor: "#0F172A", defaultTheme: "dark" });
    expect(b.isCustomized).toBe(true);
    const [row] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyA));
    expect(row.brandPrimaryColor).toBe("#1E3A8A");
    expect(row.brandSidebarColor).toBe("#0F172A");
    expect(row.brandDefaultTheme).toBe("dark");
  });

  it.each([
    ["3-digit shorthand", "#FFF"],
    ["css function", "rgb(255, 0, 0)"],
    ["gradient", "linear-gradient(90deg, #fff, #000)"],
    ["url", "url(https://evil.test/x.png)"],
    ["script", "javascript:alert(1)"],
    ["named color", "red"],
    ["8-digit with alpha", "#FF6B00CC"],
    ["hex with trailing junk", "#FF6B00;color:red"],
  ])("rejects %s", async (_label, value) => {
    const res = await api("PUT", "/organization/branding", tokenA, { primaryColor: value });
    expect(res.status).toBe(400);
    const b = await branding(tokenA);
    expect(b.primaryColor).toBe("#1E3A8A");
  });

  it("rejects a mid-tone that cannot carry readable text (WCAG AA)", async () => {
    const res = await api("PUT", "/organization/branding", tokenA, { sidebarColor: "#7A7A7A" });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe("BRANDING_INVALID");
    expect(JSON.stringify(body)).toContain("BRANDING_COLOR_CONTRAST");
    expect((await branding(tokenA)).sidebarColor).toBe("#0F172A");
  });

  it("rejects unsupported themes and unknown fields; null resets one field", async () => {
    expect((await api("PUT", "/organization/branding", tokenA, { defaultTheme: "blue" })).status).toBe(400);
    expect((await api("PUT", "/organization/branding", tokenA, { customCss: ".x{}" })).status).toBe(400);
    expect((await api("PUT", "/organization/branding", tokenA, {})).status).toBe(400);
    const res = await api("PUT", "/organization/branding", tokenA, { defaultTheme: null });
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.defaultTheme).toBe("system");
    expect(b.overrides.defaultTheme).toBeNull();
    expect(b.overrides.primaryColor).toBe("#1E3A8A");
  });

  it("derives contrast-safe foregrounds and link variants", async () => {
    const res = await api("PUT", "/organization/branding", tokenA, { primaryColor: "#FFD400" });
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.derived.primaryForeground).toBe("#111827"); // dark text on bright yellow
    expect(b.derived.primaryContrast).toBeGreaterThanOrEqual(4.5);
    expect(b.derived.primaryLinkLight).not.toBe("#FFD400"); // darkened for links on the light page
    expect(b.derived.tokens.primaryLinkLight).toMatch(/^\d+ \d+% \d+%$/);
    await api("PUT", "/organization/branding", tokenA, { primaryColor: "#1E3A8A" });
  });
});

describe("logo management", () => {
  let firstLogoUrl = "";

  it("rejects unsupported and disguised files before anything is stored", async () => {
    const cases: Array<[string, Buffer, string, string]> = [
      ["svg", SVG, "image/svg+xml", "BRANDING_LOGO_UNSUPPORTED"],
      ["svg declared as png", SVG, "image/png", "BRANDING_LOGO_UNSUPPORTED"],
      ["gif", GIF, "image/gif", "BRANDING_LOGO_UNSUPPORTED"],
      ["html", HTML, "text/html", "BRANDING_LOGO_UNSUPPORTED"],
      ["jpeg bytes declared as png", await jpeg(120, 120), "image/png", "BRANDING_LOGO_UNSUPPORTED"],
      ["empty", Buffer.alloc(0), "image/png", "BRANDING_LOGO_EMPTY"],
      ["garbage with png signature", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(600)]), "image/png", "BRANDING_LOGO_INVALID"],
      ["too small", await png(8, 8), "image/png", "BRANDING_LOGO_DIMENSIONS"],
      ["too wide", await png(5000, 100), "image/png", "BRANDING_LOGO_DIMENSIONS"],
      ["over 2 MB", await hugePng(), "image/png", "BRANDING_LOGO_TOO_LARGE"],
    ];
    for (const [label, bytes, type, code] of cases) {
      const res = await upload("/organization/branding/logo", tokenA, bytes, type);
      const body = await json(res);
      expect(res.status, `${label}: ${JSON.stringify(body)}`).toBe(400);
      expect(body.code, label).toBe(code);
    }
    const b = await branding(tokenA);
    expect(b.logoSource).toBe("none");
    expect(b.overrides.logo).toBe(false);
  });

  it("uploads a PNG (transparency preserved), exposes only an API route and serves the bytes", async () => {
    const res = await upload("/organization/branding/logo", tokenA, await png(300, 120), "image/png");
    expect(res.status, await res.clone().text()).toBe(200);
    const b = await json(res);
    expect(b.logoSource).toBe("managed");
    expect(b.overrides.logo).toBe(true);
    expect(b.logoUrl).toMatch(new RegExp(`^/api/branding/logos/${companyA}/[0-9a-f]{32}$`));
    expect(JSON.stringify(b)).not.toMatch(/branding\/\d+\/|storage\.googleapis|gs:\/\/|bucket/i);
    firstLogoUrl = b.logoUrl;
    const [row] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyA));
    expect(row.brandLogoKey).toMatch(new RegExp(`^branding/${companyA}/[0-9a-f]{32}\\.png$`));
    expect(row.brandLogoContentType).toBe("image/png");
    expect(row.brandLogoKey!.length).toBeLessThan(120); // a key, never image data

    const img = await fetch(`http://localhost:80${firstLogoUrl}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toContain("immutable");
    const bytes = Buffer.from(await img.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
    expect(meta.width).toBe(300);
    const own = await fetch(`${BASE}/organization/branding/logo`, { headers: headers(tokenA) });
    expect(own.status).toBe(200);
    expect(own.headers.get("content-type")).toBe("image/png");
  });

  it("downscales large images, keeps JPEG as JPEG, and replacing invalidates the previous route", async () => {
    const res = await upload("/organization/branding/logo", tokenA, await jpeg(3000, 1500), "image/jpeg");
    expect(res.status, await res.clone().text()).toBe(200);
    const b = await json(res);
    expect(b.logoUrl).not.toBe(firstLogoUrl);
    const img = await fetch(`http://localhost:80${b.logoUrl}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(512);
    expect((await fetch(`http://localhost:80${firstLogoUrl}`)).status).toBe(404);
    firstLogoUrl = b.logoUrl;
    const w = await upload("/organization/branding/logo", tokenA, await webp(200, 200), "image/webp");
    expect(w.status, await w.clone().text()).toBe(200);
    const wb = await json(w);
    const wimg = await fetch(`http://localhost:80${wb.logoUrl}`);
    expect(wimg.headers.get("content-type")).toBe("image/png"); // WebP alpha normalized to PNG
    firstLogoUrl = wb.logoUrl;
  });

  it("a storage failure leaves the previous branding unchanged (503)", async () => {
    const before = await branding(tokenA);
    const res = await upload("/organization/branding/logo", tokenA, await png(200, 200), "image/png", { "x-branding-test-storage-fail": "1" });
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe("BRANDING_STORAGE_UNAVAILABLE");
    const after = await branding(tokenA);
    expect(after.logoUrl).toBe(before.logoUrl);
    expect(after.primaryColor).toBe(before.primaryColor);
    expect((await fetch(`http://localhost:80${before.logoUrl}`)).status).toBe(200);
  });

  it("removes the logo (route dies) and records the audit trail", async () => {
    const res = await api("DELETE", "/organization/branding/logo", tokenA);
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.logoSource).toBe("none");
    expect(b.logoUrl).toBeNull();
    expect((await fetch(`http://localhost:80${firstLogoUrl}`)).status).toBe(404);
    expect((await fetch(`${BASE}/organization/branding/logo`, { headers: headers(tokenA) })).status).toBe(404);
    const updates = await auditActions(companyA, "branding.update");
    const replaces = await auditActions(companyA, "branding.logo.replace");
    const removes = await auditActions(companyA, "branding.logo.remove");
    expect(updates.length).toBeGreaterThanOrEqual(3);
    expect(replaces.length).toBe(3);
    expect(removes.length).toBe(1);
    const meta = replaces[0].metadata as Record<string, any>;
    expect(meta.contentType).toBe("image/png");
    expect(meta.width).toBe(300);
    expect(JSON.stringify(meta)).not.toMatch(/base64|data:image/);
    expect(updates[0].userId).toBe(adminAId);
  });
});

describe("permissions and lifecycle", () => {
  it("organization:edit is required to mutate; view-only members read but cannot change", async () => {
    expect((await api("PUT", "/organization/branding", tokenEmpView, { primaryColor: "#123456" })).status).toBe(403);
    expect((await upload("/organization/branding/logo", tokenEmpView, await png(100, 100), "image/png")).status).toBe(403);
    expect((await api("DELETE", "/organization/branding/logo", tokenEmpView)).status).toBe(403);
    expect((await api("POST", "/organization/branding/reset", tokenEmpView)).status).toBe(403);
    const ok = await api("PUT", "/organization/branding", tokenEmpEdit, { primaryColor: "#123456" });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await json(ok)).primaryColor).toBe("#123456");
  });

  it("a cancelled (read-only) tenant can read but not mutate branding", async () => {
    // Batch 20: access is resolved from the CANONICAL subscription row, not the legacy company column.
    await db.update(subscriptionsTable).set({ status: "cancelled" }).where(eq(subscriptionsTable.companyId, companyA));
    try {
      expect((await api("GET", "/organization/branding", tokenA)).status).toBe(200);
      expect((await api("PUT", "/organization/branding", tokenA, { primaryColor: "#654321" })).status).toBe(403);
      expect((await upload("/organization/branding/logo", tokenA, await png(100, 100), "image/png")).status).toBe(403);
      expect((await api("POST", "/organization/branding/reset", tokenA)).status).toBe(403);
    } finally {
      await db.update(subscriptionsTable).set({ status: "active" }).where(eq(subscriptionsTable.companyId, companyA));
    }
    expect((await branding(tokenA)).primaryColor).toBe("#123456");
  });

  it("reset returns everything to the platform default and is audited", async () => {
    await upload("/organization/branding/logo", tokenA, await png(100, 100), "image/png");
    const res = await api("POST", "/organization/branding/reset", tokenA);
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b).toMatchObject({ ...DEFAULTS, logoUrl: null, logoSource: "none", isCustomized: false, overrides: { primaryColor: null, sidebarColor: null, defaultTheme: null, logo: false } });
    expect((await auditActions(companyA, "branding.reset")).length).toBe(1);
  });
});

describe("tenant isolation (real second company)", () => {
  let logoA = "";
  it("company B never sees or affects company A's branding", async () => {
    let res = await api("PUT", "/organization/branding", tokenA, { primaryColor: "#AA0000", sidebarColor: "#001133" });
    expect(res.status).toBe(200);
    res = await upload("/organization/branding/logo", tokenA, await png(150, 150), "image/png");
    expect(res.status).toBe(200);
    logoA = (await json(res)).logoUrl;

    const b = await branding(tokenB);
    expect(b.companyId).toBe(companyB);
    expect(b).toMatchObject({ ...DEFAULTS, logoUrl: null, isCustomized: false });

    // B's own logo lands under B's key and does not touch A.
    res = await upload("/organization/branding/logo", tokenB, await jpeg(150, 150), "image/jpeg");
    expect(res.status).toBe(200);
    const logoB = (await json(res)).logoUrl as string;
    expect(logoB).toMatch(new RegExp(`^/api/branding/logos/${companyB}/`));
    expect(logoB).not.toBe(logoA);
    expect((await branding(tokenA)).logoUrl).toBe(logoA);

    // Removing B's logo removes only B's object.
    expect((await api("DELETE", "/organization/branding/logo", tokenB)).status).toBe(200);
    expect((await fetch(`http://localhost:80${logoB}`)).status).toBe(404);
    expect((await fetch(`http://localhost:80${logoA}`)).status).toBe(200);

    // Cross-tenant reads/mutations: the platform surface is 403 for tenant admins,
    // a guessed/foreign id on the public logo route is 404, and B's own logo
    // route never serves A's bytes.
    expect((await api("GET", `/companies/${companyA}/branding`, tokenB)).status).toBe(403);
    expect((await api("PUT", `/companies/${companyA}/branding`, tokenB, { primaryColor: "#000000" })).status).toBe(403);
    expect((await fetch(`http://localhost:80/api/branding/logos/${companyB}/${logoA.split("/").pop()}`)).status).toBe(404);
    expect((await fetch(`http://localhost:80/api/branding/logos/${companyA}/${"0".repeat(32)}`)).status).toBe(404);
    expect([401, 404]).toContain((await fetch(`http://localhost:80/api/branding/logos/${companyA}/../${companyB}`)).status);
    expect((await fetch(`${BASE}/organization/branding/logo`, { headers: headers(tokenB) })).status).toBe(404);
    expect((await branding(tokenA)).primaryColor).toBe("#AA0000");
    expect((await branding(tokenB)).primaryColor).toBe(DEFAULTS.primaryColor);
  });

  it("the platform operator reads and updates branding by explicit company id (audited)", async () => {
    let res = await api("GET", `/companies/${companyB}/branding`, platformToken);
    expect(res.status).toBe(200);
    expect((await json(res)).companyId).toBe(companyB);
    res = await api("PUT", `/companies/${companyB}/branding`, platformToken, { primaryColor: "#00695C", defaultTheme: "light" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await json(res)).primaryColor).toBe("#00695C");
    expect((await branding(tokenB)).primaryColor).toBe("#00695C");
    expect((await branding(tokenA)).primaryColor).toBe("#AA0000");
    res = await upload(`/companies/${companyB}/branding/logo`, platformToken, await png(120, 120), "image/png");
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await json(res)).logoUrl).toMatch(new RegExp(`^/api/branding/logos/${companyB}/`));
    expect((await fetch(`${BASE}/companies/${companyB}/branding/logo`, { headers: headers(platformToken) })).status).toBe(200);
    expect((await api("GET", `/companies/999999/branding`, platformToken)).status).toBe(404);
    res = await api("POST", `/companies/${companyB}/branding/reset`, platformToken);
    expect(res.status).toBe(200);
    expect((await branding(tokenB)).isCustomized).toBe(false);
    const audits = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.companyId, companyB), inArray(auditLogsTable.action, ["branding.update", "branding.logo.replace", "branding.reset"])));
    const byPlatform = audits.filter((a) => a.userName === PLATFORM.email);
    expect(byPlatform.map((a) => a.action).sort()).toEqual(["branding.logo.replace", "branding.reset", "branding.update"]);
    expect(byPlatform.every((a) => a.companyId === companyB)).toBe(true);
  });
});

describe("public digital business card", () => {
  it("includes only the tenant's public resolved branding and serves the logo for a published card", async () => {
    let res = await api("PUT", "/cards/me", tokenA, { fullName: "B18 Card Owner", designation: "QA", companyName: "QA B18 Branding A" });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const card = await json(res);
    const token = String(card.publicToken);
    const pub = await fetch(`${BASE}/cards/public/${token}`);
    expect(pub.status).toBe(200);
    const body = await json(pub);
    expect(body.branding).toMatchObject({ primaryColor: "#AA0000", sidebarColor: "#001133", primaryForeground: "#FFFFFF", sidebarForeground: "#FFFFFF" });
    expect(body.branding.logoUrl).toMatch(new RegExp(`^/api/branding/logos/${companyA}/`));
    expect(Object.keys(body.branding).sort()).toEqual(["defaultTheme", "logoUrl", "primaryColor", "primaryForeground", "sidebarColor", "sidebarForeground"]);
    expect(JSON.stringify(body)).not.toMatch(/brandLogoKey|vatNumber|registrationNumber|primaryContactEmail|plan"|status"|companyId|storage/);
    const logo = await fetch(`${BASE}/cards/public/${token}/logo`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");

    // Unbranded tenant → branding: null; unpublished card → 404 for card and logo.
    res = await api("PUT", "/cards/me", tokenB, { fullName: "B18 Card Owner B" });
    expect(res.status).toBeLessThan(300);
    tokenBCard = String((await json(res)).publicToken);
    const pubB = await json(await fetch(`${BASE}/cards/public/${tokenBCard}`));
    expect(pubB.branding).toBeNull();
    expect((await fetch(`${BASE}/cards/public/${tokenBCard}/logo`)).status).toBe(404);
    await db.update(businessCardsTable).set({ isPublished: false }).where(eq(businessCardsTable.publicToken, token));
    expect((await fetch(`${BASE}/cards/public/${token}`)).status).toBe(404);
    expect((await fetch(`${BASE}/cards/public/${token}/logo`)).status).toBe(404);
  });
});

// Correction 1 — a legacy external `companies.logo_url` never reaches a public surface.
// It stays an authenticated-only fallback; public cards get colors/theme and either the
// first-party managed logo route or null.
describe("public logo boundary (legacy logo_url stays authenticated-only)", () => {
  const HOST = "legacy-cdn.example.test";
  const LEGACY = `https://${HOST}/brand/logo.png`;

  it("legacy-only branding exposes no public logo (public branding stays null)", async () => {
    const res = await api("PATCH", "/organization", tokenB, { logoUrl: LEGACY });
    expect(res.status, await res.clone().text()).toBe(200);
    const mine = await branding(tokenB);
    expect(mine).toMatchObject({ logoSource: "legacy", logoUrl: LEGACY, isCustomized: false, overrides: { logo: false } });
    const pub = await fetch(`${BASE}/cards/public/${tokenBCard}`);
    expect(pub.status).toBe(200);
    const text = await pub.text();
    expect(JSON.parse(text).branding).toBeNull();
    expect(text).not.toContain(HOST);
    expect((await fetch(`${BASE}/cards/public/${tokenBCard}/logo`)).status).toBe(404);
  });

  it("legacy logo plus customized colors returns public colors but logoUrl: null", async () => {
    const res = await api("PUT", "/organization/branding", tokenB, { primaryColor: "#0E7C86", sidebarColor: "#12213A", defaultTheme: "dark" });
    expect(res.status, await res.clone().text()).toBe(200);
    // Authenticated surfaces (tenant self-service and the platform operator) still report the legacy fallback.
    const mine = await branding(tokenB);
    expect(mine).toMatchObject({ logoSource: "legacy", logoUrl: LEGACY, isCustomized: true, primaryColor: "#0E7C86", sidebarColor: "#12213A", defaultTheme: "dark" });
    const byPlatform = await json(await api("GET", `/companies/${companyB}/branding`, platformToken));
    expect(byPlatform).toMatchObject({ logoSource: "legacy", logoUrl: LEGACY });
    // The public card carries colors/theme and NO logo: not the legacy URL, not a proxy of it.
    const pub = await fetch(`${BASE}/cards/public/${tokenBCard}`);
    expect(pub.status).toBe(200);
    const text = await pub.text();
    expect(JSON.parse(text).branding).toEqual({ logoUrl: null, primaryColor: "#0E7C86", primaryForeground: "#FFFFFF", sidebarColor: "#12213A", sidebarForeground: "#FFFFFF", defaultTheme: "dark" });
    expect(text).not.toContain(HOST);
    expect((await fetch(`${BASE}/cards/public/${tokenBCard}/logo`)).status).toBe(404);
  });

  it("managed logos keep using and serving the first-party randomized route publicly", async () => {
    let res = await upload("/organization/branding/logo", tokenB, await png(120, 60), "image/png");
    expect(res.status, await res.clone().text()).toBe(200);
    const mine = await json(res);
    expect(mine.logoSource).toBe("managed");
    expect(mine.logoUrl).toMatch(new RegExp(`^/api/branding/logos/${companyB}/[0-9a-f]{32}$`));
    const pub = await fetch(`${BASE}/cards/public/${tokenBCard}`);
    const text = await pub.text();
    expect(JSON.parse(text).branding.logoUrl).toBe(mine.logoUrl);
    expect(text).not.toContain(HOST);
    expect((await fetch(`http://localhost:80${mine.logoUrl}`)).status).toBe(200);
    const viaCard = await fetch(`${BASE}/cards/public/${tokenBCard}/logo`);
    expect(viaCard.status).toBe(200);
    expect(viaCard.headers.get("content-type")).toBe("image/png");
    // Removing the managed logo also clears the legacy value: nothing public, nothing authenticated.
    res = await api("DELETE", "/organization/branding/logo", tokenB);
    expect(res.status).toBe(200);
    expect(await branding(tokenB)).toMatchObject({ logoSource: "none", logoUrl: null });
    expect((await json(await fetch(`${BASE}/cards/public/${tokenBCard}`))).branding.logoUrl).toBeNull();
    expect((await fetch(`http://localhost:80${mine.logoUrl}`)).status).toBe(404);
    res = await api("POST", "/organization/branding/reset", tokenB);
    expect(res.status).toBe(200);
    expect((await json(await fetch(`${BASE}/cards/public/${tokenBCard}`))).branding).toBeNull();
  });
});
