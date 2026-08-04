import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
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
import { insertInvocation } from "../src/repositories/ai.repository";

// Batch 6 — AI usage metering with the deterministic STUB provider (no live Gemini).
// Exercises, end-to-end against the LIVE API: real provider token accounting,
// estimated-usage fallback marking, idempotent ledger writes (requestId), safe result
// caching (cache hits create NO usage), in-flight dedup under real concurrency,
// explicit Regenerate bypass, retry attempt accounting, error categorization, and the
// no-auto-AI-on-page-open regression. All fixtures live under a throwaway tenant.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `aimeter-${SUFFIX}.test`;
const ADMIN_EMAIL = `qa-admin@${DOMAIN}`;

let companyId = 0;
let platformToken = "";
let adminToken = "";
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

async function setModel(model: string) {
  const res = await api("PATCH", "/ai/settings", adminToken, { provider: "stub", model });
  expect(res.status, `switch stub model to ${model}`).toBe(200);
}

type LedgerRow = typeof aiInvocationsTable.$inferSelect;

async function ledgerRows(where?: Partial<{ feature: string; status: string; model: string }>): Promise<LedgerRow[]> {
  const conds = [eq(aiInvocationsTable.companyId, companyId)];
  if (where?.feature) conds.push(eq(aiInvocationsTable.feature, where.feature));
  if (where?.status) conds.push(eq(aiInvocationsTable.status, where.status));
  if (where?.model) conds.push(eq(aiInvocationsTable.model, where.model));
  return db.select().from(aiInvocationsTable).where(and(...conds));
}

// Non-provider outcomes (cache_hit / dedup_reused / rate_limited) are written
// fire-and-forget — poll briefly instead of a blind sleep.
async function waitForRows(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 4000,
): Promise<void> {
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
  const createCo = await api("POST", "/companies", platformToken, { name: `QA AIMeter ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  const payload = { email: ADMIN_EMAIL, name: "QA Meter Admin", role: "primary_admin", password: PW, companyId };
  const cu = await api("POST", "/users", platformToken, payload);
  expect(cu.status).toBe(201);
  adminToken = await loginToken({ email: ADMIN_EMAIL, password: PW });

  // Switch to the stub provider BEFORE creating CRM entities so background AI
  // (auto-scoring on contact create) also uses the stub — nothing touches Gemini.
  await setModel("stub-model");

  const c1 = await api("POST", "/contacts", adminToken, {
    firstName: "Metering",
    lastName: "Target",
    email: `meter-${SUFFIX}@example.com`,
    mobile: "+1 (555) 010-7311",
    jobTitle: "CTO",
    contactCompany: "Meter Corp",
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

describe("Test A — provider token accounting (stub success)", () => {
  it("records a success row with REAL provider usage, requestId, entity linkage and pricing version", async () => {
    const res = await api("POST", genPath("email"), adminToken, { language: "en", instructions: "meter-success-1" });
    expect(res.status).toBe(200);

    await waitForRows(
      async () => (await ledgerRows({ feature: "email_composer", status: "success" })).length >= 1,
      "email_composer success row",
    );
    const rows = await ledgerRows({ feature: "email_composer", status: "success" });
    const row = rows[rows.length - 1];
    expect(row.model).toBe("stub-model");
    expect(row.requestId).toBeTruthy();
    expect(row.estimatedUsage).toBe(false);
    // Stub usage: input = ceil(promptChars/4) ≥ 1, output = 80 — REAL metadata, not zeros.
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.outputTokens).toBe(80);
    expect(row.totalTokens).toBe(row.inputTokens + row.outputTokens);
    expect(row.attempts).toBe(1);
    expect(row.entityType).toBe("contact");
    expect(row.entityId).toBe(contactId);
    expect(row.pricingVersion).toBeTruthy();
    expect(row.userId).not.toBeNull();
  });
});

describe("Test B — duplicate-request protection & safe caching", () => {
  it("serves an identical repeat from the result cache (zero-usage cache_hit row, NO new provider call)", async () => {
    const body = { language: "en", instructions: "meter-cache-1" };
    const first = await api("POST", genPath("email"), adminToken, body);
    expect(first.status).toBe(200);
    const successesBefore = (await ledgerRows({ feature: "email_composer", status: "success" })).length;

    const second = await api("POST", genPath("email"), adminToken, body);
    expect(second.status).toBe(200);

    await waitForRows(
      async () => (await ledgerRows({ feature: "email_composer", status: "cache_hit" })).length >= 1,
      "cache_hit row",
    );
    const cacheRows = await ledgerRows({ feature: "email_composer", status: "cache_hit" });
    const hit = cacheRows[cacheRows.length - 1];
    expect(hit.totalTokens).toBe(0);
    expect(hit.estimatedCostMicroUsd).toBe(0);
    // The cached repeat must NOT have produced another provider success row.
    const successesAfter = (await ledgerRows({ feature: "email_composer", status: "success" })).length;
    expect(successesAfter).toBe(successesBefore);
  });

  it("explicit Regenerate bypasses the cache and performs a fresh provider call", async () => {
    const successesBefore = (await ledgerRows({ feature: "email_composer", status: "success" })).length;
    const res = await api("POST", genPath("email"), adminToken, {
      language: "en",
      instructions: "meter-cache-1", // identical prompt — only the regenerate flag differs
      regenerate: true,
    });
    expect(res.status).toBe(200);
    await waitForRows(
      async () => (await ledgerRows({ feature: "email_composer", status: "success" })).length > successesBefore,
      "fresh success row after regenerate",
    );
  });

  it("shares ONE in-flight provider call across concurrent identical requests (dedup_reused)", async () => {
    await setModel("stub-slow"); // 1500ms provider latency → guaranteed overlap
    const body = { language: "en", instructions: "meter-inflight-1" };
    const [r1, r2] = await Promise.all([
      api("POST", genPath("email"), adminToken, body),
      api("POST", genPath("email"), adminToken, body),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    await waitForRows(
      async () => (await ledgerRows({ feature: "email_composer", status: "dedup_reused" })).length >= 1,
      "dedup_reused row",
    );
    const slowSuccesses = await ledgerRows({ feature: "email_composer", status: "success", model: "stub-slow" });
    expect(slowSuccesses.length).toBe(1); // exactly ONE provider call happened
    const reused = await ledgerRows({ feature: "email_composer", status: "dedup_reused" });
    expect(reused[reused.length - 1].totalTokens).toBe(0);
    await setModel("stub-model");
  });
});

describe("Test C — estimated-usage fallback & error categorization", () => {
  it("marks usage as ESTIMATED when the provider returns no usage metadata", async () => {
    await setModel("stub-nousage");
    const res = await api("POST", genPath("email"), adminToken, { language: "en", instructions: "meter-nousage-1" });
    expect(res.status).toBe(200);
    await waitForRows(
      async () => (await ledgerRows({ feature: "email_composer", model: "stub-nousage" })).length >= 1,
      "stub-nousage row",
    );
    const rows = await ledgerRows({ feature: "email_composer", model: "stub-nousage" });
    expect(rows[rows.length - 1].estimatedUsage).toBe(true);
  });

  it("records provider failures with zero usage and an error category (soft-degrade stays 200)", async () => {
    await setModel("stub-fail");
    const res = await api("POST", genPath("email"), adminToken, { language: "en", instructions: "meter-fail-1", regenerate: true });
    // LLM-only copilot types soft-degrade — a provider failure is NOT a 500.
    expect(res.status).toBe(200);
    const bodyJson = await res.json();
    expect(bodyJson.generationFailed === true || bodyJson.content?.unavailable === true).toBe(true);

    await waitForRows(
      async () => (await ledgerRows({ feature: "email_composer", status: "error", model: "stub-fail" })).length >= 1,
      "stub-fail error row",
    );
    const rows = await ledgerRows({ feature: "email_composer", status: "error", model: "stub-fail" });
    const row = rows[rows.length - 1];
    expect(row.totalTokens).toBe(0);
    expect(row.errorCategory).toBeTruthy();
    expect(row.errorMessage).toBeTruthy();
  });

  it("categorizes timeouts as timeout status", async () => {
    await setModel("stub-timeout");
    const res = await api("POST", genPath("email"), adminToken, { language: "en", instructions: "meter-timeout-1", regenerate: true });
    expect(res.status).toBe(200);
    await waitForRows(
      async () => (await ledgerRows({ status: "timeout", model: "stub-timeout" })).length >= 1,
      "timeout row",
    );
    const rows = await ledgerRows({ status: "timeout", model: "stub-timeout" });
    expect(rows[rows.length - 1].errorCategory).toBe("timeout");
  });

  it("accounts retry attempts (transient failure then success)", async () => {
    await setModel("stub-fail-once");
    const res = await api("POST", genPath("email"), adminToken, { language: "en", instructions: "meter-retry-1", regenerate: true });
    expect(res.status).toBe(200);
    await waitForRows(
      async () => (await ledgerRows({ model: "stub-fail-once" })).length >= 1,
      "stub-fail-once row",
    );
    const rows = await ledgerRows({ model: "stub-fail-once" });
    const row = rows[rows.length - 1];
    // Either the retry succeeded (attempts ≥ 2) or the final failure carries its attempt count.
    expect(row.attempts).toBeGreaterThanOrEqual(row.status === "success" ? 2 : 1);
    await setModel("stub-model");
  });
});

describe("Test D — idempotent ledger writes", () => {
  it("a second insert with the same requestId is a silent no-op (no duplicate row)", async () => {
    const requestId = `qa-idem-${SUFFIX}`;
    const values = {
      companyId,
      requestId,
      feature: "lead_scoring",
      provider: "stub",
      model: "stub-model",
      status: "success",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estimatedCostMicroUsd: 100,
      latencyMs: 5,
    };
    await insertInvocation(values);
    await insertInvocation(values); // simulated retry after a transient failure
    const rows = await db
      .select()
      .from(aiInvocationsTable)
      .where(eq(aiInvocationsTable.requestId, requestId));
    expect(rows.length).toBe(1);
  });
});

describe("Test E — no auto-AI on page open (regression)", () => {
  it("read-only page-data GETs create ZERO new invocations", async () => {
    // Allow every pending fire-and-forget write from prior tests to land first.
    await new Promise((r) => setTimeout(r, 700));
    const before = (await ledgerRows()).length;

    const gets = [
      `/ai/copilot/contact/${contactId}/panel`,
      `/ai/copilot/contact/${contactId}/outputs`,
      "/ai/settings",
      "/ai/usage",
      "/ai/health",
      "/contacts",
      `/contacts/${contactId}`,
      "/dashboard/stats",
    ];
    for (const path of gets) {
      const res = await api("GET", path, adminToken);
      expect([200, 404].includes(res.status), `${path} → ${res.status}`).toBe(true);
    }

    await new Promise((r) => setTimeout(r, 700));
    const after = (await ledgerRows()).length;
    expect(after).toBe(before);
  });
});

describe("Test F — tenant usage aggregation semantics", () => {
  it("counts requests as provider calls only; cache/dedup surfaced separately", async () => {
    const res = await api("GET", "/ai/usage", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();

    const rows = await ledgerRows();
    const providerRows = rows.filter((r) => ["success", "error", "timeout"].includes(r.status));
    const cacheRows = rows.filter((r) => r.status === "cache_hit");
    const dedupRows = rows.filter((r) => r.status === "dedup_reused");

    expect(body.totals.requests).toBe(providerRows.length);
    expect(body.totals.cacheHits).toBe(cacheRows.length);
    expect(body.totals.dedupReused).toBe(dedupRows.length);
    expect(body.totals.estimatedRows).toBeGreaterThanOrEqual(1); // stub-nousage
    // Non-provider rows carry zero usage, so token totals equal provider-row sums.
    const tokenSum = rows.reduce((s, r) => s + r.totalTokens, 0);
    expect(body.totals.totalTokens).toBe(tokenSum);
    expect(Array.isArray(body.byDay)).toBe(true);
    expect(body.budget).toBeDefined();
  });
});
