// B22 Correction 1 — POST /scans without a provider credential must answer a
// truthful 503 AI_NOT_CONFIGURED: no provider call, no ledger row, no stranded scan
// reservation, no stored image — while genuine image / provider / OCR failures keep
// their existing contract (400 SCAN_* codes, 502 "could not read the card",
// 422 SCAN_NO_CARD, 403 AI_DISABLED) and the success path is untouched.
//
// Integration-against-live-API like the other suites (http://localhost:80). The
// "unconfigured" cases exercise the tenant's DEFAULT provider (gemini) and are
// SKIPPED when the running API actually holds a Gemini credential — they can only
// be proven without a key, and a live key must never be spent by the normal suite.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import {
  db,
  companiesTable,
  usersTable,
  scansTable,
  aiSettingsTable,
  aiInvocationsTable,
  aiUsageReservationsTable,
  subscriptionUsageReservationsTable,
} from "@workspace/db";

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const ADMIN_EMAIL = `qa-b22c1-admin@b22c1-${SUFFIX}.test`;

let companyId = 0;
let platformToken = "";
let adminToken = "";
let liveProviderConfigured = false;
// Distinct images per case: the AI result cache and the scan reservation are keyed
// by image content, so every case must use bytes the tenant has never scanned.
const img: Record<string, string> = {};

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}
async function loginToken(creds: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creds) });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (await res.json()).token;
}
async function api(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${BASE}${path}`, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body) });
}
async function settings(body: Record<string, unknown>) {
  const res = await api("PATCH", "/ai/settings", adminToken, body);
  expect(res.status, `PATCH /ai/settings ${JSON.stringify(body)}`).toBe(200);
}
async function postScan(imageData: string) {
  return api("POST", "/scans", adminToken, { imageData, appLanguage: "en" });
}
async function jpeg(seed: number): Promise<string> {
  const buf = await sharp({ create: { width: 96 + seed, height: 64, channels: 3, background: { r: (seed * 37) % 256, g: (seed * 91) % 256, b: (seed * 53) % 256 } } })
    .jpeg({ quality: 80 })
    .toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}
const scanRows = () => db.select().from(scansTable).where(eq(scansTable.companyId, companyId));
const ledgerRows = () => db.select().from(aiInvocationsTable).where(and(eq(aiInvocationsTable.companyId, companyId), eq(aiInvocationsTable.feature, "card_extraction")));
const scanReservations = () => db.select().from(subscriptionUsageReservationsTable).where(eq(subscriptionUsageReservationsTable.companyId, companyId));
async function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

beforeAll(async () => {
  const health = await fetch(`${BASE}/healthz`);
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);
  platformToken = await loginToken(PLATFORM);
  const createCo = await api("POST", "/companies", platformToken, { name: `QA B22C1 ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));
  const cu = await api("POST", "/users", platformToken, { email: ADMIN_EMAIL, name: "QA B22C1 Admin", role: "primary_admin", password: PW, companyId });
  expect(cu.status).toBe(201);
  adminToken = await loginToken({ email: ADMIN_EMAIL, password: PW });
  // Default tenant settings = provider gemini / gemini-2.5-flash. Whether that
  // provider holds a credential in THIS environment decides the unconfigured cases.
  const hl = await api("GET", "/ai/health", adminToken);
  expect(hl.status).toBe(200);
  const h = await hl.json();
  expect(h.provider).toBe("gemini");
  liveProviderConfigured = h.configured === true;
  for (const k of ["a", "b", "c", "d", "e", "f"]) img[k] = await jpeg(k.charCodeAt(0));
});

afterAll(async () => {
  if (!companyId) return;
  await db.delete(aiInvocationsTable).where(eq(aiInvocationsTable.companyId, companyId));
  await db.delete(aiUsageReservationsTable).where(eq(aiUsageReservationsTable.companyId, companyId));
  await db.delete(subscriptionUsageReservationsTable).where(eq(subscriptionUsageReservationsTable.companyId, companyId));
  await db.delete(aiSettingsTable).where(eq(aiSettingsTable.companyId, companyId));
  await db.delete(scansTable).where(eq(scansTable.companyId, companyId));
  await db.delete(usersTable).where(eq(usersTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
});

describe("B22 Correction 1 — unconfigured provider through POST /scans (gemini without a credential)", () => {
  it("answers 503 AI_NOT_CONFIGURED with a provider-agnostic message; the scan is failed, nothing was reserved, called, recorded or stored", async (ctx) => {
    if (liveProviderConfigured) ctx.skip("the running API holds a Gemini credential — the unconfigured case cannot be exercised without a billable call");
    const beforeLedger = (await ledgerRows()).length;
    const beforeScans = (await scanRows()).length;
    const res = await postScan(img.a);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("AI_NOT_CONFIGURED");
    expect(typeof body.error).toBe("string");
    expect(body.error).not.toMatch(/gemini|google|api[_ -]?key|GEMINI|AI_INTEGRATIONS|retake/i);
    expect(body.extractedData).toBeUndefined();

    // Scan/reservation consistency: one honest failed row, none stuck in processing,
    // the scan-capacity reservation released (a refused scan costs no quota).
    const rows = await scanRows();
    expect(rows.length).toBe(beforeScans + 1);
    expect(rows.filter((r) => r.status === "processing").length).toBe(0);
    const failed = rows.find((r) => r.status === "failed");
    expect(failed).toBeDefined();
    expect(failed!.extractedData).toBeNull();
    expect(failed!.imageUrl).toBeNull(); // the route never uploaded the image
    const reservations = await scanReservations();
    expect(reservations.filter((r) => r.status !== "released").length).toBe(0);

    // AI-ledger consistency: no provider call happened, so no row of any status was written.
    await new Promise((r) => setTimeout(r, 400));
    expect((await ledgerRows()).length).toBe(beforeLedger);
    const usage = await api("GET", "/ai/usage", adminToken);
    expect(usage.status).toBe(200);
    expect((await usage.json()).totals.requests).toBe(0);

    // The failed scan reads back honestly and has no stored image to serve.
    const detail = await api("GET", `/scans/${failed!.id}`, adminToken);
    expect(detail.status).toBe(200);
    expect((await detail.json()).status).toBe("failed");
    const image = await api("GET", `/scans/${failed!.id}/image`, adminToken);
    expect(image.status).toBe(404);
  });

  it("AI health keeps reporting the honest state alongside the 503 (configured=false, status=unconfigured)", async (ctx) => {
    if (liveProviderConfigured) ctx.skip("the running API holds a Gemini credential");
    const hl = await api("GET", "/ai/health", adminToken);
    const h = await hl.json();
    expect(h.configured).toBe(false);
    expect(h.status).toBe("unconfigured");
    expect(h.model).toBe("gemini-2.5-flash");
  });
});

describe("B22 Correction 1 — genuine failures and the success path keep their existing contract (stub provider)", () => {
  it("invalid image bytes → 400 SCAN_* before any provider work (no scan row)", async () => {
    await settings({ provider: "stub", model: "stub-model" });
    const before = (await scanRows()).length;
    const res = await postScan("data:image/jpeg;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.code).toBe("string");
    expect(body.code.startsWith("SCAN_")).toBe(true);
    expect((await scanRows()).length).toBe(before);
  });

  it("genuine provider failure → 502 'Could not read the card…', scan failed, error ledger row (unchanged)", async () => {
    await settings({ provider: "stub", model: "stub-fail" });
    const before = (await ledgerRows()).filter((r) => r.status === "error").length;
    const res = await postScan(img.b);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/could not read the card/i);
    expect(body.code).toBeUndefined();
    expect(body.status).toBe("failed");
    await waitFor(async () => (await ledgerRows()).filter((r) => r.status === "error").length === before + 1, "error ledger row");
  });

  it("genuine provider timeout → 502, timeout ledger row (unchanged)", async () => {
    await settings({ provider: "stub", model: "stub-timeout" });
    const before = (await ledgerRows()).filter((r) => r.status === "timeout").length;
    const res = await postScan(img.c);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/could not read the card/i);
    await waitFor(async () => (await ledgerRows()).filter((r) => r.status === "timeout").length === before + 1, "timeout ledger row");
  });

  it("no readable card → 422 SCAN_NO_CARD, scan failed (unchanged)", async () => {
    await settings({ provider: "stub", model: "stub-nocard" });
    const res = await postScan(img.d);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("SCAN_NO_CARD");
    expect(body.status).toBe("failed");
  });

  it("AI disabled by the tenant → 403 AI_DISABLED before any provider work (unchanged)", async () => {
    await settings({ provider: "stub", model: "stub-model", enabled: false });
    const before = (await ledgerRows()).length;
    const res = await postScan(img.e);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("AI_DISABLED");
    expect((await ledgerRows()).length).toBe(before);
    await settings({ enabled: true });
  });

  it("successful extraction → 201 with extracted fields and a success ledger row (unchanged)", async () => {
    await settings({ provider: "stub", model: "stub-model", enabled: true });
    const res = await postScan(img.f);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.extractedData && typeof body.extractedData === "object").toBe(true);
    await waitFor(async () => (await ledgerRows()).some((r) => r.status === "success"), "success ledger row");
  });
});
