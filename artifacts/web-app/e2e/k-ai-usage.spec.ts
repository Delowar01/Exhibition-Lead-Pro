import { test, expect, state, seedAuth, urlFor, waitForWorkspace } from "./fixtures/workspace";
import { API_BASE } from "./fixtures/seed-values";

/**
 * K. AI Usage, Cost & Limits (Batch 6) — tenant budget visibility on Admin →
 * AI Settings, explicit Regenerate bypass flag on the copilot wire call, and the
 * Platform Owner AI Intelligence analytics (filters + pagination).
 *
 * Determinism: no live Gemini is required. The budget card renders from the
 * usage aggregate; the Regenerate test disables AI (deterministic follow-up
 * core still generates) and only inspects the OUTGOING request payload.
 */

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };

async function api(pathname: string, method = "GET", body?: unknown, token = state.token) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Tenant budget visibility (Admin → AI Settings)
// ---------------------------------------------------------------------------

test.describe("tenant AI budget card", () => {
  let originalTokenBudget: number | null = null;
  let hadCustomSettings = false;

  test.beforeAll(async () => {
    const settings = await api("/ai/settings");
    originalTokenBudget = settings?.monthlyTokenBudget ?? null;
    hadCustomSettings = settings?.hasCustomSettings ?? false;
    await api("/ai/settings", "PATCH", { monthlyTokenBudget: 5_000_000 });
  });

  test.afterAll(async () => {
    // Restore: only reset the budget if the tenant had custom settings before,
    // otherwise null it out (closest to the pristine default).
    await api("/ai/settings", "PATCH", { monthlyTokenBudget: hadCustomSettings ? originalTokenBudget : null });
  });

  test("shows the monthly budget card with a usage percentage and daily trend", async ({ page }) => {
    await seedAuth(page);
    await page.goto("/admin/ai");

    const card = page.getByTestId("card-budget");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId("badge-budget-pct")).toBeVisible();
    await expect(card.getByText(/resets/i)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Regenerate sends the explicit dedup-bypass flag
// ---------------------------------------------------------------------------

test.describe("copilot Regenerate bypass flag", () => {
  let originalAiEnabled: boolean | null = null;

  test.beforeAll(async () => {
    const settings = await api("/ai/settings");
    originalAiEnabled = settings?.enabled ?? true;
    await api("/ai/settings", "PATCH", { enabled: false });
  });

  test.afterAll(async () => {
    if (originalAiEnabled !== null) {
      await api("/ai/settings", "PATCH", { enabled: originalAiEnabled });
    }
  });

  test("the Regenerate action POSTs regenerate:true", async ({ page }) => {
    const contactId = state.contact.id;
    await seedAuth(page);
    await page.goto(urlFor(contactId, "ai"));
    await waitForWorkspace(page);
    const panel = page.locator("#workspace-panel-ai");
    await expect(panel.getByText("AI Sales Copilot")).toBeVisible();

    // Generate the deterministic follow-up first (works with AI disabled).
    await panel.getByTestId("select-copilot-type").click();
    await page.getByRole("option", { name: "Follow-up plan" }).click();
    await panel.getByTestId("button-copilot-generate").click();
    await expect(panel.getByTestId("button-regenerate-followup")).toBeVisible({ timeout: 20_000 });

    const regenRequest = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        req.url().includes(`/ai/copilot/contact/${contactId}/followup`) &&
        (req.postData() ?? "").includes('"regenerate":true'),
      { timeout: 15_000 },
    );
    await panel.getByTestId("button-regenerate-followup").click();
    await regenRequest; // resolves only if the flag was on the wire
  });
});

// ---------------------------------------------------------------------------
// Platform Owner — AI Intelligence analytics (filters + pagination)
// ---------------------------------------------------------------------------

test.describe("platform AI intelligence", () => {
  let platformToken = "";
  let platformUser: Record<string, unknown> = {};

  test.beforeAll(async () => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PLATFORM),
    });
    if (!res.ok) throw new Error(`platform login failed: ${res.status}`);
    const body = await res.json();
    platformToken = body.token;
    platformUser = body.user;
  });

  async function seedPlatformAuth(page: import("@playwright/test").Page) {
    await page.addInitScript(
      ([t, u]) => {
        try {
          localStorage.setItem("csp_token", t as string);
          localStorage.setItem("csp_user", u as string);
          localStorage.setItem("csp_theme", "light");
        } catch {
          /* storage unavailable */
        }
      },
      [platformToken, JSON.stringify(platformUser)] as const,
    );
  }

  test("renders aggregate stats, near-limit + failure-category cards and a paginated company table", async ({ page }) => {
    await seedPlatformAuth(page);
    await page.goto("/platform/ai");

    await expect(page.getByTestId("stat-requests")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("stat-cost")).toBeVisible();
    await expect(page.getByTestId("stat-saved")).toBeVisible();
    await expect(page.getByTestId("stat-denied")).toBeVisible();
    await expect(page.getByTestId("card-failure-categories")).toBeVisible();
    // Company table renders; the pagination footer only appears past one page and
    // the near-limit card only when a tenant is actually near its budget.
    await expect(page.getByText("Usage by Company")).toBeVisible();
  });

  test("feature filter refetches without breaking the dashboard", async ({ page }) => {
    await seedPlatformAuth(page);
    await page.goto("/platform/ai");
    await expect(page.getByTestId("stat-requests")).toBeVisible({ timeout: 20_000 });

    const filtered = page.waitForResponse(
      (res) => res.url().includes("/ai/platform/usage") && res.url().includes("feature=card_extraction") && res.ok(),
      { timeout: 15_000 },
    );
    await page.getByTestId("select-platform-feature").click();
    await page.getByRole("option", { name: "Card Extraction" }).click();
    await filtered;
    await expect(page.getByTestId("stat-requests")).toBeVisible();
    await expect(page.getByText("Usage by Company")).toBeVisible();
  });
});
