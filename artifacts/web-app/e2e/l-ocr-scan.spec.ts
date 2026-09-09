import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { test, expect, state, seedAuth } from "./fixtures/workspace";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { API_BASE } from "./fixtures/seed-values";

/**
 * L. OCR scan flow (Batch 7) — real upload → review → explicit save through the
 * browser, plus the honest failure path.
 *
 * Determinism: the tenant's AI settings are pinned to the STUB provider for the
 * whole file (stub-model = deterministic full extraction; stub-fail = provider
 * failure). Original settings are restored in afterAll. No live Gemini is hit.
 */

const FIXTURE_A = path.join(__dirname, "fixtures", "scan-card-a.jpg");
const FIXTURE_B = path.join(__dirname, "fixtures", "scan-card-b.jpg");

// Unique per run so the dedupe flow (409 existing_contact_found) never triggers
// against leftovers from an aborted earlier run.
const RUN_MOBILE = `+9715${String(Date.now()).slice(-8)}`;

async function api(pathname: string, method = "GET", body?: unknown) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.token}`,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

let originalSettings: { provider?: string | null; model?: string | null; enabled?: boolean } = {};
let savedContactId: number | null = null;

// B20 Correction 1 — test-data hygiene. Every upload below makes the API reserve
// scan capacity under a DETERMINISTIC key derived from (company, user, image):
//   scan:<companyId>:<userId>:<sha256("data:image/jpeg;base64,<file>")[:32]>
// (artifacts/api-server/src/services/scans.service.ts). The keys of the two
// fixtures are computed up-front, recorded, and afterAll deletes EXACTLY those
// rows — never a company-wide delete — so a focused or full run leaves no
// reservation behind even when a test fails midway.
function reservationKeyFor(fixture: string): string {
  const dataUrl = `data:image/jpeg;base64,${fs.readFileSync(fixture).toString("base64")}`;
  return `scan:${state.user.companyId}:${state.user.id}:${createHash("sha256").update(dataUrl).digest("hex").slice(0, 32)}`;
}
const reservationKeys: string[] = [];
function trackReservation(fixture: string) {
  const key = reservationKeyFor(fixture);
  if (!reservationKeys.includes(key)) reservationKeys.push(key);
}

test.beforeAll(async () => {
  const s = await api("/ai/settings");
  originalSettings = { provider: s?.provider ?? null, model: s?.model ?? null, enabled: s?.enabled ?? true };
  await api("/ai/settings", "PATCH", { enabled: true, provider: "stub", model: "stub-model" });
});

test.afterAll(async () => {
  await api("/ai/settings", "PATCH", {
    enabled: originalSettings.enabled ?? true,
    provider: originalSettings.provider ?? "gemini",
    model: originalSettings.model ?? "gemini-2.5-flash",
  });
  if (savedContactId != null) {
    await api(`/contacts/${savedContactId}`, "DELETE").catch(() => undefined);
  }
  // Remove only the reservations this spec created (by exact key), then prove none remain.
  if (process.env.DATABASE_URL && reservationKeys.length) {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await pg.connect();
      await pg.query("delete from subscription_usage_reservations where company_id = $1 and idempotency_key = any($2::text[])", [state.user.companyId, reservationKeys]);
      const left = await pg.query("select count(*)::int as n from subscription_usage_reservations where idempotency_key = any($1::text[])", [reservationKeys]);
      expect(left.rows[0].n).toBe(0);
    } finally {
      await pg.end().catch(() => undefined);
    }
  }
});

async function openScanPage(page: import("@playwright/test").Page) {
  await seedAuth(page);
  await page.goto("/admin/scan");
  await expect(page.getByText("Scan Business Card")).toBeVisible();
}

test("upload → OCR review populated → edit → Save to Contacts creates the contact once", async ({ page }) => {
  await openScanPage(page);

  trackReservation(FIXTURE_A);
  await page.getByTestId("input-scan-file").setInputFiles(FIXTURE_A);
  await expect(page.getByText("Card scanned successfully").first()).toBeVisible({ timeout: 30_000 });

  // Review form populated from extraction (stub card) — email domain lowercased.
  const first = page.getByTestId("input-scan-first-name");
  await expect(first).toHaveValue("Taylor");

  // User edits before saving (review is editable; save is explicit).
  await first.fill("Taylor-Edited");
  await page.getByTestId("input-scan-mobile").fill(RUN_MOBILE);

  await page.getByTestId("button-scan-save-contact").click();
  await expect(page.getByText("Contact saved").first()).toBeVisible({ timeout: 20_000 });
  // Success navigates into the CRM contact workspace.
  await page.waitForURL(/\/admin\/contacts\/\d+/);

  const contacts = await api(`/contacts?search=${encodeURIComponent("Taylor-Edited")}`);
  const list = Array.isArray(contacts) ? contacts : contacts?.data ?? contacts?.contacts ?? [];
  const found = list.filter(
    (c: { firstName?: string; mobile?: string }) => c.firstName === "Taylor-Edited" && c.mobile === RUN_MOBILE,
  );
  expect(found.length).toBe(1); // exactly one — no auto-creation, no duplicate
  savedContactId = found[0].id;
});

test("provider failure surfaces an honest error and never creates a contact", async ({ page }) => {
  await api("/ai/settings", "PATCH", { provider: "stub", model: "stub-fail" });
  try {
    await openScanPage(page);

    const before = await api(`/contacts?search=${encodeURIComponent("Taylor")}`);
    const beforeList = Array.isArray(before) ? before : before?.data ?? before?.contacts ?? [];

    trackReservation(FIXTURE_B);
    await page.getByTestId("input-scan-file").setInputFiles(FIXTURE_B);
    // 502 from the OCR provider → describeAiError copy, not a fake success.
    await expect(page.getByText("AI temporarily unavailable").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Card scanned successfully")).toHaveCount(0);

    const after = await api(`/contacts?search=${encodeURIComponent("Taylor")}`);
    const afterList = Array.isArray(after) ? after : after?.data ?? after?.contacts ?? [];
    expect(afterList.length).toBe(beforeList.length); // no contact from a failed scan
  } finally {
    await api("/ai/settings", "PATCH", { provider: "stub", model: "stub-model" });
  }
});
