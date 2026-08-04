import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  scansTable,
  aiCopilotOutputsTable,
  aiSettingsTable,
  aiInvocationsTable,
  aiUsageReservationsTable,
} from "@workspace/db";

// Batch 6 — AI rate limiting + atomic budget enforcement (stub provider, no live
// Gemini). Exercises against the LIVE API: per-user AI rate limits (429 with
// machine-readable code + Retry-After), heavy-feature limits, budget denial with a
// safe context payload, and TRUE-CONCURRENCY budget atomicity (Promise.all against
// the real server; the advisory-locked reservation must never collectively
// overspend). Fresh throwaway tenant + dedicated users per section keep the
// fixed-window counters deterministic.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

// Server defaults (config.ai.rateLimits / budget) — env-overridable, asserted loosely.
const PER_USER_MAX = 30;
const HEAVY_PER_USER_MAX = 10;

const SUFFIX = Date.now();
const DOMAIN = `ailimit-${SUFFIX}.test`;
const ADMIN_EMAIL = `qa-admin@${DOMAIN}`;
const RATE_EMAIL = `qa-rate@${DOMAIN}`;
const HEAVY_EMAIL = `qa-heavy@${DOMAIN}`;
const BUDGET_EMAIL = `qa-budget@${DOMAIN}`;

let companyId = 0;
let platformToken = "";
let adminToken = "";
let rateToken = "";
let heavyToken = "";
let budgetToken = "";
let contactId = 0;

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function loginToken(creds: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (await res.json()).token;
}

async function api(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createUser(email: string, name: string, role: string): Promise<void> {
  const res = await api("POST", "/users", platformToken, { email, name, role, password: PW, companyId });
  expect(res.status, `create user ${email}`).toBe(201);
}

async function patchSettings(patch: Record<string, unknown>) {
  const res = await api("PATCH", "/ai/settings", adminToken, patch);
  expect(res.status, `PATCH /ai/settings ${JSON.stringify(patch)}`).toBe(200);
}

async function waitForRows(predicate: () => Promise<boolean>, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const genPath = (outputType: string) => `/ai/copilot/contact/${contactId}/${outputType}`;

beforeAll(async () => {
  const health = await fetch(`${BASE}/healthz`);
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);

  platformToken = await loginToken(PLATFORM);
  const createCo = await api("POST", "/companies", platformToken, { name: `QA AILimit ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  await createUser(ADMIN_EMAIL, "QA Limit Admin", "primary_admin");
  adminToken = await loginToken({ email: ADMIN_EMAIL, password: PW });
  await createUser(RATE_EMAIL, "QA Rate User", "admin");
  rateToken = await loginToken({ email: RATE_EMAIL, password: PW });
  await createUser(HEAVY_EMAIL, "QA Heavy User", "admin");
  heavyToken = await loginToken({ email: HEAVY_EMAIL, password: PW });
  await createUser(BUDGET_EMAIL, "QA Budget User", "admin");
  budgetToken = await loginToken({ email: BUDGET_EMAIL, password: PW });

  // Grant the copilot module to the admin-role fixtures (mirrors the production
  // permission backfill; new admins don't carry ai_copilot by default).
  await db
    .update(usersTable)
    .set({
      permissions: sql`coalesce(${usersTable.permissions}, '{}'::jsonb) || '{"ai_copilot":["view","generate","use"]}'::jsonb`,
    })
    .where(and(eq(usersTable.companyId, companyId), eq(usersTable.role, "admin")));

  // Stub provider BEFORE creating entities so background AI (auto-score) is stubbed.
  await patchSettings({ provider: "stub", model: "stub-model" });

  const c1 = await api("POST", "/contacts", adminToken, {
    firstName: "Limit",
    lastName: "Target",
    email: `limit-${SUFFIX}@example.com`,
    mobile: "+1 (555) 010-7411",
    jobTitle: "CFO",
    contactCompany: "Limit Corp",
    status: "new",
  });
  expect(c1.status).toBe(201);
  contactId = (await c1.json()).id;
});

afterAll(async () => {
  if (companyId) {
    await db.delete(aiCopilotOutputsTable).where(eq(aiCopilotOutputsTable.companyId, companyId));
    await db.delete(aiInvocationsTable).where(eq(aiInvocationsTable.companyId, companyId));
    await db.delete(aiUsageReservationsTable).where(eq(aiUsageReservationsTable.companyId, companyId));
    await db.delete(aiSettingsTable).where(eq(aiSettingsTable.companyId, companyId));
    await db.delete(scansTable).where(eq(scansTable.companyId, companyId));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, companyId));
    await db.delete(usersTable).where(eq(usersTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
});

describe("Test G — AI-specific rate limiting", () => {
  it("429s with AI_RATE_LIMITED + Retry-After once the per-user window is exhausted", async () => {
    let limited: Response | null = null;
    let okCount = 0;
    // regenerate:true bypasses dedup so every request is a real (stubbed) provider call.
    for (let i = 0; i < PER_USER_MAX + 5 && !limited; i++) {
      const res = await api("POST", genPath("email"), rateToken, {
        language: "en",
        instructions: `rate-${i}`,
        regenerate: true,
      });
      if (res.status === 429) limited = res;
      else {
        expect(res.status).toBe(200);
        okCount++;
      }
    }
    expect(limited, "expected a 429 within the attempt budget").not.toBeNull();
    expect(okCount).toBeGreaterThan(0);
    const body = await limited!.json();
    expect(body.code).toBe("AI_RATE_LIMITED");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited!.headers.get("retry-after")).toBeTruthy();

    // Denials are visible in analytics as zero-usage rate_limited rows.
    await waitForRows(
      async () =>
        (
          await db
            .select()
            .from(aiInvocationsTable)
            .where(and(eq(aiInvocationsTable.companyId, companyId), eq(aiInvocationsTable.status, "rate_limited")))
        ).length >= 1,
      "rate_limited ledger row",
    );
    const rows = await db
      .select()
      .from(aiInvocationsTable)
      .where(and(eq(aiInvocationsTable.companyId, companyId), eq(aiInvocationsTable.status, "rate_limited")));
    expect(rows[rows.length - 1].totalTokens).toBe(0);
    expect(rows[rows.length - 1].estimatedCostMicroUsd).toBe(0);
  });

  it("heavy features hit their stricter per-user limit first", async () => {
    let limited: Response | null = null;
    for (let i = 0; i < HEAVY_PER_USER_MAX + 3 && !limited; i++) {
      const res = await api("POST", genPath("meeting_prep"), heavyToken, {
        language: "en",
        instructions: `heavy-${i}`,
        regenerate: true,
      });
      if (res.status === 429) limited = res;
      else expect(res.status).toBe(200);
    }
    expect(limited, "expected a heavy-feature 429 within the attempt budget").not.toBeNull();
    const body = await limited!.json();
    expect(body.code).toBe("AI_RATE_LIMITED");
  });
});

describe("Test H — budget enforcement (single + true concurrency)", () => {
  it("denies with AI_BUDGET_EXCEEDED + safe context when the token budget is already exhausted", async () => {
    await patchSettings({ monthlyTokenBudget: 100 }); // < reservation size → immediate denial
    const res = await api("POST", genPath("email"), budgetToken, {
      language: "en",
      instructions: "budget-deny-1",
      regenerate: true,
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("AI_BUDGET_EXCEEDED");
    // Legacy message preserved (Stage 5.0 contract).
    expect(String(body.error)).toContain("budget exhausted");
    // Safe machine-readable context — numbers and dates only, never content.
    expect(body.context).toBeDefined();
    expect(body.context.kind).toBe("tokens");
    expect(typeof body.context.resetAt).toBe("string");
    expect(typeof body.context.usedTokens).toBe("number");
    expect(body.context.tokenBudget).toBe(100);

    await waitForRows(
      async () =>
        (
          await db
            .select()
            .from(aiInvocationsTable)
            .where(and(eq(aiInvocationsTable.companyId, companyId), eq(aiInvocationsTable.status, "budget_denied")))
        ).length >= 1,
      "budget_denied ledger row",
    );
  });

  it("never collectively overspends under real concurrency (advisory-locked reservation)", async () => {
    // Admission rule: a reservation is DENIED once ledger usage + active
    // reservations already meet the budget. One in-flight reservation (default
    // 2000 tokens) exceeds a 1500 budget, so exactly ONE concurrent call may win.
    await patchSettings({ monthlyTokenBudget: 1500 });
    // Zero out this tenant's month usage so the arithmetic below is exact.
    await db.delete(aiInvocationsTable).where(eq(aiInvocationsTable.companyId, companyId));
    await db.delete(aiUsageReservationsTable).where(eq(aiUsageReservationsTable.companyId, companyId));
    // stub-slow holds the provider call (and its reservation) for 1500ms so ALL
    // concurrent competitors overlap the reservation window.
    await patchSettings({ model: "stub-slow" });

    const results = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        api("POST", genPath("email"), budgetToken, {
          language: "en",
          instructions: `budget-conc-${i}`, // distinct prompts → no dedup sharing
          regenerate: true,
        }),
      ),
    );
    const okCount = results.filter((r) => r.status === 200).length;
    const deniedResults = results.filter((r) => r.status === 429);
    expect(okCount).toBe(1);
    expect(deniedResults.length).toBe(3);
    for (const denied of deniedResults) {
      const body = await denied.json();
      expect(body.code).toBe("AI_BUDGET_EXCEEDED");
    }

    // Ledger reflects the policy: exactly 1 success, 3 zero-usage budget_denied rows,
    // and the month total stays within budget.
    await waitForRows(
      async () =>
        (
          await db
            .select()
            .from(aiInvocationsTable)
            .where(and(eq(aiInvocationsTable.companyId, companyId), eq(aiInvocationsTable.status, "budget_denied")))
        ).length >= 3,
      "3 budget_denied rows",
    );
    const rows = await db.select().from(aiInvocationsTable).where(eq(aiInvocationsTable.companyId, companyId));
    expect(rows.filter((r) => r.status === "success").length).toBe(1);
    const totalTokens = rows.reduce((s, r) => s + r.totalTokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(1500);
    // No reservation may linger after settlement.
    const reservations = await db
      .select()
      .from(aiUsageReservationsTable)
      .where(and(eq(aiUsageReservationsTable.companyId, companyId), gte(aiUsageReservationsTable.expiresAt, new Date())));
    expect(reservations.length).toBe(0);

    // Restore an unconstrained budget for any later suites touching this tenant.
    await patchSettings({ model: "stub-model", monthlyTokenBudget: null });
  });
});
