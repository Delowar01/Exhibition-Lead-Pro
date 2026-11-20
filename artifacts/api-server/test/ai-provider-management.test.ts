import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  leadsTable,
  scansTable,
  aiSettingsTable,
  aiInvocationsTable,
  aiUsageReservationsTable,
  auditLogsTable,
  notificationsTable,
  platformSettingsTable,
} from "@workspace/db";

// Platform AI provider management — Claude + Gemini under the Platform Owner's policy.
//
// End to end against the LIVE local API, with NO provider ever contacted: outside
// production a provider may be given a deterministic test model ("stub-…"), which the
// stub engine serves UNDER THAT PROVIDER'S NAME. So "Claude answers", "Claude is down and
// Gemini takes over", "Claude refuses" are all real requests through the real execution
// seam, the real ledger and the real budget code — and no key exists in this environment
// (asserted below), so a billable call is impossible.
//
// The platform policy is global state: every change here goes through the API, and
// afterAll puts back the policy this file found — unless what it found carried test
// models (the leftover of an interrupted run), in which case the shipped default is
// restored, so one broken run can never poison the next.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();

type Provider = "anthropic" | "gemini";
interface ProviderPolicy {
  enabled: boolean;
  model: string;
  monthlyLimitMicroUsd: number | null;
}
interface Policy {
  primary: Provider;
  fallbackEnabled: boolean;
  alertThresholdPct: number;
  providers: Record<Provider, ProviderPolicy>;
  tenantOverrides: Array<{ companyId: number; provider: Provider; model: string | null }>;
}
interface Tenant {
  companyId: number;
  token: string;
  userId: number;
  contactId: number;
}

let platformToken = "";
let platformUserId = 0;
let originalPolicy: Policy | null = null;
const companyIds: number[] = [];
let imageSeq = 0;

function headers(token?: string) {
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
async function api(method: string, path: string, token?: string, body?: unknown) {
  return fetch(`${BASE}${path}`, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body) });
}
async function login(creds: { email: string; password: string }) {
  const res = await api("POST", "/auth/login", undefined, creds);
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (await res.json()) as { token: string; user: { id: number } };
}
async function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// ── The platform policy ──────────────────────────────────────────────────────────────────

async function status() {
  const res = await api("GET", "/platform/ai/providers", platformToken);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}
function plain(s: any): Policy {
  return {
    primary: s.policy.primary,
    fallbackEnabled: s.policy.fallbackEnabled,
    alertThresholdPct: s.policy.alertThresholdPct,
    providers: { anthropic: { ...s.policy.providers.anthropic }, gemini: { ...s.policy.providers.gemini } },
    tenantOverrides: s.policy.tenantOverrides.map((o: any) => ({ companyId: o.companyId, provider: o.provider, model: o.model })),
  };
}
async function put(policy: unknown, expectedVersion: number, confirm?: boolean) {
  return api("PUT", "/platform/ai/providers", platformToken, { policy, expectedVersion, ...(confirm === undefined ? {} : { confirm }) });
}
/** Stores a complete policy (confirmed) and returns the fresh status. */
async function setPolicy(policy: Policy) {
  const current = await status();
  const res = await put(policy, current.version, true);
  expect(res.status, `set policy: ${await res.clone().text()}`).toBe(200);
  return (await res.json()) as any;
}
/** A policy on deterministic test models: each provider "has credentials" and answers as its model says. */
function sim(over: { primary?: Provider; fallback?: boolean; claude?: string | false; gemini?: string | false; claudeLimit?: number | null; geminiLimit?: number | null; alert?: number; overrides?: Policy["tenantOverrides"] } = {}): Policy {
  return {
    primary: over.primary ?? "anthropic",
    fallbackEnabled: over.fallback ?? true,
    alertThresholdPct: over.alert ?? 80,
    providers: {
      anthropic: { enabled: over.claude !== false, model: over.claude === false || over.claude === undefined ? "stub-model" : over.claude, monthlyLimitMicroUsd: over.claudeLimit ?? null },
      gemini: { enabled: over.gemini !== false, model: over.gemini === false || over.gemini === undefined ? "stub-model" : over.gemini, monthlyLimitMicroUsd: over.geminiLimit ?? null },
    },
    tenantOverrides: over.overrides ?? [],
  };
}

/** The real, documented models (no provider has a key here, so nothing can be served on them). */
function shippedModels(over: { primary?: Provider } = {}): Policy {
  return { ...SHIPPED, primary: over.primary ?? "anthropic", providers: { anthropic: { ...SHIPPED.providers.anthropic }, gemini: { ...SHIPPED.providers.gemini } }, tenantOverrides: [] };
}

// ── Tenants and requests ─────────────────────────────────────────────────────────────────

async function makeTenant(label: string): Promise<Tenant> {
  const created = await api("POST", "/companies", platformToken, { name: `QA AIProv ${label} ${SUFFIX}`, plan: "professional" });
  expect(created.status).toBe(201);
  const companyId = (await created.json()).id as number;
  companyIds.push(companyId);
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));
  const email = `qa-${label.toLowerCase()}@aiprov-${label.toLowerCase()}-${SUFFIX}.test`;
  const user = await api("POST", "/users", platformToken, { email, name: `QA ${label}`, role: "primary_admin", password: PW, companyId });
  expect(user.status).toBe(201);
  const auth = await login({ email, password: PW });
  const contact = await api("POST", "/contacts", auth.token, { firstName: "Probe", lastName: label, email: `probe-${label.toLowerCase()}-${SUFFIX}@example.test`, company: "Acme Trading" });
  expect(contact.status, await contact.clone().text()).toBe(201);
  // Creating a contact starts a background lead-scoring call. Let it finish, so its
  // ledger row can never land in the middle of a test that measures provider totals.
  await settled(companyId);
  return { companyId, token: auth.token, userId: auth.user.id, contactId: (await contact.json()).id };
}

/** Resolves once the company's ledger has stopped growing. */
async function settled(companyId: number): Promise<void> {
  const count = async () => (await db.select({ id: aiInvocationsTable.id }).from(aiInvocationsTable).where(eq(aiInvocationsTable.companyId, companyId))).length;
  let last = -1;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const now = await count();
    if (now === last) return;
    last = now;
  }
}

const SHIPPED: Policy = {
  primary: "anthropic",
  fallbackEnabled: true,
  alertThresholdPct: 80,
  providers: { anthropic: { enabled: true, model: "claude-opus-5-5", monthlyLimitMicroUsd: null }, gemini: { enabled: true, model: "gemini-2.5-flash", monthlyLimitMicroUsd: null } },
  tenantOverrides: [],
};
const hasTestModels = (pol: Policy) => pol.providers.anthropic.model.startsWith("stub-") || pol.providers.gemini.model.startsWith("stub-") || pol.tenantOverrides.some((o) => (o.model ?? "").startsWith("stub-"));

/** A distinct, valid JPEG per call, so no request is ever answered from the duplicate cache. */
async function freshImage(): Promise<string> {
  imageSeq += 1;
  const jpeg = await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: (imageSeq * 37) % 256, g: (imageSeq * 91) % 256, b: (SUFFIX + imageSeq) % 256 } } })
    .jpeg({ quality: 80 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

async function lastLedgerId(): Promise<number> {
  const [row] = await db.select({ id: aiInvocationsTable.id }).from(aiInvocationsTable).orderBy(desc(aiInvocationsTable.id)).limit(1);
  return row?.id ?? 0;
}
async function ledgerSince(companyId: number, afterId: number, feature?: string) {
  const rows = await db
    .select()
    .from(aiInvocationsTable)
    .where(and(eq(aiInvocationsTable.companyId, companyId), gt(aiInvocationsTable.id, afterId), ...(feature ? [eq(aiInvocationsTable.feature, feature)] : [])))
    .orderBy(aiInvocationsTable.id);
  return rows;
}

/** One card scan = one card_extraction request. Returns the HTTP answer and the ledger rows it wrote. */
async function scan(t: Tenant, expectRows?: number) {
  const before = await lastLedgerId();
  const res = await api("POST", "/scans", t.token, { imageData: await freshImage(), appLanguage: "en" });
  const body = (await res.json()) as any;
  if (expectRows !== undefined) {
    await waitFor(async () => (await ledgerSince(t.companyId, before, "card_extraction")).length >= expectRows, `${expectRows} ledger row(s)`);
  }
  const rows = await ledgerSince(t.companyId, before, "card_extraction");
  return { status: res.status, body, rows };
}
const brief = (rows: Array<{ provider: string; model: string; status: string; errorCategory: string | null }>) => rows.map((r) => `${r.provider}/${r.model}/${r.status}${r.errorCategory ? `/${r.errorCategory}` : ""}`);

beforeAll(async () => {
  const health = await fetch(`${BASE}/healthz`);
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);
  const auth = await login(PLATFORM);
  platformToken = auth.token;
  platformUserId = auth.user.id;
  const found = plain(await status());
  originalPolicy = hasTestModels(found) ? SHIPPED : found;
  // Platform spend alerts are sent once per provider per day: start from none.
  await db.delete(notificationsTable).where(sql`${notificationsTable.metadata} ->> 'kind' = 'ai_platform_spend'`);
});

afterAll(async () => {
  // Put the policy back (through the API, so the server applies it at once).
  if (originalPolicy && platformToken) {
    const current = await status();
    const res = await put(originalPolicy, current.version, true);
    if (res.status !== 200) throw new Error(`could not restore the AI provider policy: ${res.status} ${await res.text()}`);
  }
  await db.delete(notificationsTable).where(sql`${notificationsTable.metadata} ->> 'kind' = 'ai_platform_spend'`);
  for (const cid of companyIds) {
    await db.delete(aiInvocationsTable).where(eq(aiInvocationsTable.companyId, cid));
    await db.delete(aiUsageReservationsTable).where(eq(aiUsageReservationsTable.companyId, cid));
    await db.delete(aiSettingsTable).where(eq(aiSettingsTable.companyId, cid));
    await db.delete(scansTable).where(eq(scansTable.companyId, cid));
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════

describe("A — only the Platform Owner reaches the AI provider settings, and no key ever leaves the server", () => {
  let tenant: Tenant;
  beforeAll(async () => {
    tenant = await makeTenant("Access");
  });

  it("refuses an anonymous caller (401) and every tenant role (403) on read and on write", async () => {
    expect((await api("GET", "/platform/ai/providers")).status).toBe(401);
    expect((await api("PUT", "/platform/ai/providers", undefined, { policy: sim(), expectedVersion: 0 })).status).toBe(401);
    expect((await api("GET", "/platform/ai/providers", tenant.token)).status).toBe(403);
    const before = await status();
    const write = await api("PUT", "/platform/ai/providers", tenant.token, { policy: sim({ claude: false }), expectedVersion: before.version, confirm: true });
    expect(write.status).toBe(403);
    expect((await status()).version).toBe(before.version);
  });

  it("no provider has a key in this environment — a billable call is impossible — and the status says so without revealing anything", async () => {
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GEMINI_API_KEY", "GOOGLE_API_KEY", "AI_INTEGRATIONS_GEMINI_API_KEY"]) {
      expect(process.env[name] ?? "", name).toBe("");
    }
    const s = await status();
    expect(s.providers.map((p: any) => p.provider)).toEqual(["anthropic", "gemini"]);
    for (const p of s.providers) {
      expect(p.credentials).toEqual({ configured: false, state: "missing", checkedAt: null, envVar: p.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY" });
    }
    // The response names the variable that holds a key; it never carries a key-shaped value or field.
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/sk-ant-|AIza[0-9A-Za-z_-]{10,}|"apiKey"|"api_key"|"secret"|"token"/);
  });

  it("offers the documented Claude models with their prices and a single Gemini model; test models are flagged as such", async () => {
    const s = await status();
    const claude = s.providers.find((p: any) => p.provider === "anthropic");
    const gemini = s.providers.find((p: any) => p.provider === "gemini");
    const real = (p: any) => p.models.filter((m: any) => !m.simulated);
    expect(real(claude).map((m: any) => [m.id, m.inputMicroUsdPerMTok, m.outputMicroUsdPerMTok])).toEqual([
      ["claude-opus-5-5", 4_000_000, 20_000_000],
      ["claude-sonnet-5-5", 2_000_000, 10_000_000],
      ["claude-haiku-5-5", 100_000, 500_000],
    ]);
    expect(real(claude)[2].longContext).toEqual({ aboveInputTokens: 100_000, inputMicroUsdPerMTok: 500_000, outputMicroUsdPerMTok: 2_500_000 });
    expect(real(gemini).map((m: any) => m.id)).toEqual(["gemini-2.5-flash"]);
    expect(real(claude).every((m: any) => m.priced) && real(gemini).every((m: any) => m.priced)).toBe(true);
    expect(s.simulationAvailable).toBe(true); // this is not a production server
    expect(claude.models.filter((m: any) => m.simulated).every((m: any) => m.id.startsWith("stub-"))).toBe(true);
  });
});

describe("B — the policy is validated, confirmed, versioned and audited on the server", () => {
  beforeAll(async () => {
    await setPolicy(sim());
  });

  it("refuses a model that is not selectable, naming the field, and stores nothing", async () => {
    const before = await status();
    const bad = sim();
    bad.providers.anthropic.model = "claude-unlisted-model";
    const res = await put(bad, before.version, true);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("AI_POLICY_INVALID");
    expect(body.context.issues.map((i: any) => `${i.field}:${i.code}`)).toContain("providers.anthropic.model:POLICY_MODEL_NOT_SUPPORTED");
    expect((await status()).version).toBe(before.version);
  });

  it("refuses unknown keys anywhere in the policy — a credential can never be smuggled into it", async () => {
    const before = await status();
    for (const mutate of [(p: any) => (p.apiKey = "x"), (p: any) => (p.providers.anthropic.apiKey = "x"), (p: any) => (p.providers.openai = { enabled: true, model: "gpt", monthlyLimitMicroUsd: null })]) {
      const bad: any = sim();
      mutate(bad);
      const res = await put(bad, before.version, true);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("AI_POLICY_INVALID");
    }
    const row = await db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "ai_providers"));
    expect(JSON.stringify(row[0]?.value ?? {})).not.toMatch(/apiKey|openai/);
    expect((await status()).version).toBe(before.version);
  });

  it("refuses a malformed body, a missing version and an override for a company that does not exist", async () => {
    const before = await status();
    expect((await api("PUT", "/platform/ai/providers", platformToken, { policy: sim() })).status).toBe(400);
    expect((await api("PUT", "/platform/ai/providers", platformToken, { expectedVersion: before.version })).status).toBe(400);
    expect((await api("PUT", "/platform/ai/providers", platformToken, { policy: { ...sim(), primary: "stub" }, expectedVersion: before.version })).status).toBe(400);
    const ghost = await put(sim({ overrides: [{ companyId: 2_000_000_000, provider: "gemini", model: null }] }), before.version, true);
    expect(ghost.status).toBe(400);
    expect((await ghost.json()).context.issues[0].code).toBe("POLICY_OVERRIDE_COMPANY_UNKNOWN");
    expect((await status()).version).toBe(before.version);
  });

  it("a change that reduces AI availability is held back until confirmed — the server decides, not the client", async () => {
    const before = await status();
    const off = sim({ gemini: false });
    const held = await put(off, before.version);
    expect(held.status).toBe(409);
    const body = await held.json();
    expect(body.code).toBe("AI_POLICY_CONFIRMATION_REQUIRED");
    expect(body.context.disablesAllAi).toBe(false);
    expect(body.context.warnings.join(" ")).toMatch(/Gemini will be disabled/);
    expect(body.context.warnings.join(" ")).toMatch(/Only Claude will be able to serve requests/);
    expect((await status()).policy.providers.gemini.enabled).toBe(true); // nothing changed
    // confirm:false is not a confirmation either.
    expect((await put(off, before.version, false)).status).toBe(409);

    const applied = await put(off, before.version, true);
    expect(applied.status).toBe(200);
    const after = await applied.json();
    expect(after.version).toBe(before.version + 1);
    expect(after.policy.providers.gemini.enabled).toBe(false);
  });

  it("turning AI off for everyone is announced as such", async () => {
    const before = await status();
    const held = await put(sim({ gemini: false, claude: false }), before.version);
    expect(held.status).toBe(409);
    const body = await held.json();
    expect(body.context.disablesAllAi).toBe(true);
    expect(body.context.warnings[0]).toMatch(/every AI feature stops for every tenant/);
    expect(body.context.warnings[0]).toMatch(/Manual, QR and NFC capture keep working/);
    expect((await status()).version).toBe(before.version);
  });

  it("switching the primary, turning fallback off and adding a spending limit each need confirmation; a harmless change does not", async () => {
    await setPolicy(sim());
    let v = (await status()).version;
    for (const [policy, pattern] of [
      [sim({ primary: "gemini" }), /will go to Gemini/],
      [sim({ fallback: false }), /Automatic fallback will be off/],
      [sim({ claudeLimit: 5_000_000 }), /Claude gets a monthly spending limit/],
    ] as Array<[Policy, RegExp]>) {
      const held = await put(policy, v);
      expect(held.status).toBe(409);
      expect((await held.json()).context.warnings.join(" ")).toMatch(pattern);
    }
    expect((await status()).version).toBe(v);

    // The alert threshold, a model and a company pin do not reduce availability: saved at once.
    const harmless = await put(sim({ alert: 65 }), v);
    expect(harmless.status).toBe(200);
    v = (await harmless.json()).version;
    expect((await put(sim({ alert: 65, claude: "stub-nousage" }), v)).status).toBe(200);
  });

  it("a stale version is refused and two simultaneous saves cannot both win", async () => {
    await setPolicy(sim());
    const s = await status();
    const stale = await put(sim({ alert: 70 }), s.version - 1);
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.code).toBe("AI_POLICY_VERSION_CONFLICT");
    expect(body.context.currentVersion).toBe(s.version);

    const [a, b] = await Promise.all([put(sim({ alert: 71 }), s.version), put(sim({ alert: 72 }), s.version)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const after = await status();
    expect(after.version).toBe(s.version + 1);
    expect([71, 72]).toContain(after.policy.alertThresholdPct);
  });

  it("saving the same policy again changes nothing: no new version, no audit row", async () => {
    const s = await status();
    const audits = async () => (await db.select({ id: auditLogsTable.id }).from(auditLogsTable).where(eq(auditLogsTable.action, "platform.ai_providers.update"))).length;
    const n = await audits();
    const res = await put(plain(s), s.version);
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(s.version);
    expect(await audits()).toBe(n);
  });

  it("a company that was pinned and has since been deleted is dropped by the next save instead of blocking it", async () => {
    await setPolicy(sim());
    const GONE = 1_999_999_999;
    // The stale pin, as a deleted company leaves it behind (written directly: the API refuses a pin for an unknown company).
    await db.execute(sql`update platform_settings set value = jsonb_set(value, '{tenantOverrides}', ${JSON.stringify([{ companyId: GONE, provider: "gemini", model: null }])}::jsonb) where key = 'ai_providers'`);
    const s = await status();
    expect(s.policy.tenantOverrides).toEqual([{ companyId: GONE, companyName: null, provider: "gemini", model: null }]);

    // The page sends the complete policy back, stale pin included, with an unrelated change.
    const res = await put({ ...plain(s), alertThresholdPct: 77 }, s.version);
    expect(res.status, await res.clone().text()).toBe(200);
    const after = await res.json();
    expect(after.policy.alertThresholdPct).toBe(77);
    expect(after.policy.tenantOverrides).toEqual([]);
    const [audit] = await db.select().from(auditLogsTable).where(eq(auditLogsTable.action, "platform.ai_providers.update")).orderBy(desc(auditLogsTable.id)).limit(1);
    expect((audit.metadata as any).droppedOverrides).toEqual([GONE]);
    // A NEW pin for an unknown company is still refused.
    const fresh = await status();
    expect((await put(sim({ overrides: [{ companyId: GONE, provider: "gemini", model: null }] }), fresh.version, true)).status).toBe(400);
  });

  it("every change is audited in the same transaction: who, what changed, before and after — and never a credential", async () => {
    await setPolicy(sim());
    const s = await status();
    const res = await put(sim({ primary: "gemini", claudeLimit: 250_000_000 }), s.version, true);
    expect(res.status).toBe(200);
    const [audit] = await db.select().from(auditLogsTable).where(eq(auditLogsTable.action, "platform.ai_providers.update")).orderBy(desc(auditLogsTable.id)).limit(1);
    expect(audit.companyId).toBeNull(); // a platform event, not a tenant's
    expect(audit.userId).toBe(platformUserId);
    expect(audit.userName).toBe(PLATFORM.email);
    expect(audit.entityType).toBe("platform_setting");
    expect(audit.entityId).toBe("ai_providers");
    const meta = audit.metadata as any;
    expect(meta.version).toBe(s.version + 1);
    expect(meta.confirmed).toBe(true);
    expect([...meta.changed].sort()).toEqual(["primary", "providers.anthropic.monthlyLimitMicroUsd"]);
    expect(meta.before.primary).toBe("anthropic");
    expect(meta.after.primary).toBe("gemini");
    expect(meta.after.providers.anthropic.monthlyLimitMicroUsd).toBe(250_000_000);
    expect(meta.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(meta)).not.toMatch(/sk-ant-|apiKey|api_key/i);

    const fresh = await status();
    expect(fresh.updatedByName).toBeTruthy();
    expect(new Date(fresh.updatedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(fresh.persisted).toBe(true);
  });
});

describe("C — Claude and Gemini each serve requests, and the Platform Owner switches between them without a deployment", () => {
  let t: Tenant;
  beforeAll(async () => {
    t = await makeTenant("Routing");
  });

  it("Claude as primary: the card scan is served by Claude and attributed to it", async () => {
    await setPolicy(sim({ primary: "anthropic" }));
    const r = await scan(t, 1);
    expect([200, 201]).toContain(r.status);
    expect(r.body.extractedData).toBeTruthy();
    expect(brief(r.rows)).toEqual(["anthropic/stub-model/success"]);
    expect(r.rows[0].totalTokens).toBeGreaterThan(0);
    expect(r.rows[0].estimatedCostMicroUsd).toBeGreaterThan(0);
    expect(r.rows[0].requestId).not.toMatch(/-fb\d$/);
    // The tenant sees the provider that serves it, and that it is ready.
    const settings = await (await api("GET", "/ai/settings", t.token)).json();
    expect([settings.provider, settings.model]).toEqual(["anthropic", "stub-model"]);
    const health = await (await api("GET", "/ai/health", t.token)).json();
    expect(health).toMatchObject({ provider: "anthropic", model: "stub-model", configured: true, status: "ok" });
  });

  it("switching the primary to Gemini takes effect on the very next request — no restart, no deployment", async () => {
    await setPolicy(sim({ primary: "gemini" }));
    const r = await scan(t, 1);
    expect([200, 201]).toContain(r.status);
    expect(brief(r.rows)).toEqual(["gemini/stub-model/success"]);
    const settings = await (await api("GET", "/ai/settings", t.token)).json();
    expect(settings.provider).toBe("gemini");
    // …and back.
    await setPolicy(sim({ primary: "anthropic" }));
    expect(brief((await scan(t, 1)).rows)).toEqual(["anthropic/stub-model/success"]);
  });

  it("Gemini alone (Claude disabled) and Claude alone (Gemini disabled) both work", async () => {
    await setPolicy(sim({ primary: "anthropic", claude: false }));
    let s = await status();
    expect(s.effective).toMatchObject({ provider: "gemini", fallbackProvider: null, unavailable: null });
    expect(brief((await scan(t, 1)).rows)).toEqual(["gemini/stub-model/success"]);
    let settings = await (await api("GET", "/ai/settings", t.token)).json();
    expect(settings.availableProviders).toEqual(["gemini", "stub"]);

    await setPolicy(sim({ primary: "gemini", gemini: false }));
    s = await status();
    expect(s.effective).toMatchObject({ provider: "anthropic", fallbackProvider: null, unavailable: null });
    expect(brief((await scan(t, 1)).rows)).toEqual(["anthropic/stub-model/success"]);
    settings = await (await api("GET", "/ai/settings", t.token)).json();
    expect(settings.availableProviders).toEqual(["anthropic", "stub"]);
  });

  it("a tenant cannot name a provider the Platform Owner disabled, nor a model of another provider", async () => {
    await setPolicy(sim({ gemini: false }));
    const disabled = await api("PATCH", "/ai/settings", t.token, { provider: "gemini", model: "gemini-2.5-flash" });
    expect(disabled.status).toBe(400);
    await setPolicy(sim());
    const wrongModel = await api("PATCH", "/ai/settings", t.token, { provider: "anthropic", model: "gemini-2.5-flash" });
    expect(wrongModel.status).toBe(400);
    expect((await wrongModel.json()).code).toBe("AI_MODEL_NOT_SUPPORTED");
    const unpriced = await api("PATCH", "/ai/settings", t.token, { provider: "gemini", model: "some-unpriced-model" });
    expect(unpriced.status).toBe(400);
    expect((await unpriced.json()).code).toBe("AI_MODEL_NOT_SUPPORTED");
  });

  it("a client that sends back the pair it was shown is accepted, and a tenant row never names a provider earlier releases cannot resolve", async () => {
    await setPolicy(shippedModels({ primary: "anthropic" }));
    // GET shows the pair that would serve (none has a key here, so the pre-policy default is reported).
    const shown = await (await api("GET", "/ai/settings", t.token)).json();
    expect((await api("PATCH", "/ai/settings", t.token, { model: shown.model })).status).toBe(200);
    const [before] = await db.select().from(aiSettingsTable).where(eq(aiSettingsTable.companyId, t.companyId));
    expect(before.provider).toBe("gemini");
    // A Claude model sent alone, while the stored provider is still Gemini: valid, so accepted — and NOT stored.
    // The stored pair selects nothing for a real provider, and the releases before the platform policy resolve
    // it directly: a row naming Claude would fail every AI call of that tenant after an application rollback.
    const res = await api("PATCH", "/ai/settings", t.token, { model: "claude-sonnet-5-5" });
    expect(res.status, await res.clone().text()).toBe(200);
    // The whole pair, as a page of an earlier release echoes it back when Claude serves, together with a real change.
    const echoed = await api("PATCH", "/ai/settings", t.token, { provider: "anthropic", model: "claude-opus-5-5", monthlyTokenBudget: 123456 });
    expect(echoed.status, await echoed.clone().text()).toBe(200);
    const [row] = await db.select().from(aiSettingsTable).where(eq(aiSettingsTable.companyId, t.companyId));
    expect([row.provider, row.model]).toEqual([before.provider, before.model]);
    expect(row.monthlyTokenBudget).toBe(123456); // the rest of the request is stored
    expect((await api("PATCH", "/ai/settings", t.token, { monthlyTokenBudget: null })).status).toBe(200);
    // No tenant row anywhere names a provider other than the earlier one or the test provider.
    const named = await db.select({ provider: aiSettingsTable.provider }).from(aiSettingsTable);
    expect(named.filter((r) => r.provider !== "gemini" && r.provider !== "stub")).toEqual([]);
    // A model no enabled provider offers is still refused.
    const bad = await api("PATCH", "/ai/settings", t.token, { model: "claude-unlisted-model" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("AI_MODEL_NOT_SUPPORTED");
    await setPolicy(sim());
  });

  it("a tenant's own stored provider never selects the vendor: the platform primary serves it", async () => {
    await setPolicy(sim({ primary: "anthropic" }));
    const stored = await api("PATCH", "/ai/settings", t.token, { provider: "gemini", model: "gemini-2.5-flash" });
    expect(stored.status).toBe(200);
    const [row] = await db.select().from(aiSettingsTable).where(eq(aiSettingsTable.companyId, t.companyId));
    expect([row.provider, row.model]).toEqual(["gemini", "gemini-2.5-flash"]); // the tenant's configuration is preserved as stored
    expect(brief((await scan(t, 1)).rows)).toEqual(["anthropic/stub-model/success"]);
    // Its own controls keep working: the tenant master switch still turns AI off for that tenant only.
    expect((await api("PATCH", "/ai/settings", t.token, { enabled: false })).status).toBe(200);
    const off = await scan(t);
    expect(off.status).toBe(403);
    expect(off.body.code).toBe("AI_DISABLED");
    expect(off.rows).toEqual([]);
    expect((await api("PATCH", "/ai/settings", t.token, { enabled: true })).status).toBe(200);
  });

  it("a tenant on the test provider keeps using it (outside production only), whatever the policy says", async () => {
    await setPolicy(sim({ primary: "anthropic" }));
    expect((await api("PATCH", "/ai/settings", t.token, { provider: "stub", model: "stub-model" })).status).toBe(200);
    expect(brief((await scan(t, 1)).rows)).toEqual(["stub/stub-model/success"]);
    const health = await (await api("GET", "/ai/health", t.token)).json();
    expect(health.provider).toBe("stub");
    // Back off the test provider — through the API, which also refreshes the server's cached settings.
    expect((await api("PATCH", "/ai/settings", t.token, { provider: "anthropic", model: "stub-model" })).status).toBe(200);
    expect(brief((await scan(t, 1)).rows)).toEqual(["anthropic/stub-model/success"]);
  });

  it("both providers disabled: a clear 503, nothing reserved or recorded, and manual, QR and NFC capture keep working", async () => {
    await setPolicy(sim({ claude: false, gemini: false }));
    const s = await status();
    expect(s.effective).toMatchObject({ provider: null, unavailable: "none_enabled" });
    // A fresh tenant, so no cached settings row of the earlier tests is in play.
    const fresh = await makeTenant("AllOff");
    const r = await scan(fresh);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("AI_NOT_CONFIGURED");
    expect(r.body.error).toMatch(/not configured/i);
    expect(r.rows).toEqual([]);
    expect(await db.select().from(aiUsageReservationsTable).where(eq(aiUsageReservationsTable.companyId, fresh.companyId))).toEqual([]);
    const health = await (await api("GET", "/ai/health", fresh.token)).json();
    expect(health).toMatchObject({ configured: false, status: "unconfigured" });

    for (const source of ["manual", "qr", "nfc"]) {
      const c = await api("POST", "/contacts", fresh.token, { firstName: "No", lastName: `AI ${source}`, email: `noai-${source}-${SUFFIX}@example.test`, source });
      expect(c.status, `${source} capture`).toBe(201);
    }
    await setPolicy(sim());
  });

  it("a company the Platform Owner pinned uses its provider and model; other companies keep the primary", async () => {
    const pinned = await makeTenant("Pinned");
    const s = await setPolicy(sim({ primary: "anthropic", overrides: [{ companyId: pinned.companyId, provider: "gemini", model: "stub-nousage" }] }));
    expect(s.policy.tenantOverrides).toEqual([{ companyId: pinned.companyId, companyName: `QA AIProv Pinned ${SUFFIX}`, provider: "gemini", model: "stub-nousage" }]);
    expect(brief((await scan(pinned, 1)).rows)).toEqual(["gemini/stub-nousage/success"]);
    expect(brief((await scan(t, 1)).rows)).toEqual(["anthropic/stub-model/success"]);
    const settings = await (await api("GET", "/ai/settings", pinned.token)).json();
    expect([settings.provider, settings.model]).toEqual(["gemini", "stub-nousage"]);

    // The pin cannot bring back a provider the owner disables: the primary applies.
    await setPolicy(sim({ primary: "anthropic", gemini: false, overrides: [{ companyId: pinned.companyId, provider: "gemini", model: "stub-nousage" }] }));
    expect(brief((await scan(pinned, 1)).rows)).toEqual(["anthropic/stub-model/success"]);
    await setPolicy(sim());
  });
});

describe("D — automatic fallback: once, for an outage only, never around a decision", () => {
  let t: Tenant;
  beforeAll(async () => {
    t = await makeTenant("Fallback");
  });

  for (const [model, category] of [
    ["stub-unavailable", "provider_unavailable"],
    ["stub-ratelimit", "provider_rate_limited"],
    ["stub-auth", "provider_auth"],
    ["stub-timeout", "timeout"],
  ] as const) {
    it(`Claude fails with ${category}: Gemini is tried once and serves — both attempts are recorded under their own provider`, async () => {
      await setPolicy(sim({ primary: "anthropic", claude: model }));
      const before = (await status()).providers.find((p: any) => p.provider === "gemini").month.servedAsFallback;
      const r = await scan(t, 2);
      expect([200, 201]).toContain(r.status);
      expect(r.body.extractedData).toBeTruthy();
      expect(brief(r.rows)).toEqual([`anthropic/${model}/${category === "timeout" ? "timeout" : "error"}/${category}`, "gemini/stub-model/success"]);
      const [first, second] = r.rows;
      expect(second.requestId).toBe(`${first.requestId}-fb1`);
      // The failed attempt cost nothing; the fallback's tokens and cost are Gemini's.
      expect([first.totalTokens, first.estimatedCostMicroUsd]).toEqual([0, 0]);
      expect(second.totalTokens).toBeGreaterThan(0);
      expect(second.estimatedCostMicroUsd).toBeGreaterThan(0);
      // The scan records the model that actually produced the extraction.
      const [row] = await db.select().from(scansTable).where(eq(scansTable.id, r.body.id));
      expect(row.aiModel).toBe("stub-model");
      expect((await status()).providers.find((p: any) => p.provider === "gemini").month.servedAsFallback).toBe(before + 1);
    });
  }

  it("works in the other direction too: Gemini primary down, Claude serves", async () => {
    await setPolicy(sim({ primary: "gemini", gemini: "stub-unavailable" }));
    const r = await scan(t, 2);
    expect([200, 201]).toContain(r.status);
    expect(brief(r.rows)).toEqual(["gemini/stub-unavailable/error/provider_unavailable", "anthropic/stub-model/success"]);
  });

  for (const [model, category] of [
    ["stub-refusal", "provider_refusal"],
    ["stub-rejected", "provider_rejected"],
    ["stub-fail", "other"],
    ["stub-null", "invalid_response"],
  ] as const) {
    it(`a ${category} failure is final: the other provider is NOT tried`, async () => {
      await setPolicy(sim({ primary: "anthropic", claude: model }));
      const r = await scan(t, 1);
      expect(r.status).toBe(502);
      expect(r.body.code).toBeUndefined();
      expect(brief(r.rows)).toEqual([`anthropic/${model}/error/${category}`]);
      await new Promise((res) => setTimeout(res, 300));
      expect((await ledgerSince(t.companyId, r.rows[0].id - 1, "card_extraction")).length).toBe(1);
    });
  }

  it("a stopped provider account (billing, spend cap) is final too — and is reported as 'AI unavailable', not as an unreadable card", async () => {
    await setPolicy(sim({ primary: "anthropic", claude: "stub-quota" }));
    const r = await scan(t, 1);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(r.body.error).toMatch(/temporarily unavailable/i);
    expect(r.body.error).not.toMatch(/retake/i);
    // Gemini is enabled and healthy, and is NOT used: a provider's spending stop is not routed around.
    expect(brief(r.rows)).toEqual(["anthropic/stub-quota/error/provider_quota"]);
    await new Promise((res) => setTimeout(res, 300));
    expect((await ledgerSince(t.companyId, r.rows[0].id - 1, "card_extraction")).length).toBe(1);
  });

  it("input the primary cannot take (an image it does not accept) is served by the other provider; with no other provider it is a plain failure, not an outage", async () => {
    await setPolicy(sim({ primary: "anthropic", claude: "stub-unsupported" }));
    const served = await scan(t, 2);
    expect([200, 201]).toContain(served.status);
    expect(brief(served.rows)).toEqual(["anthropic/stub-unsupported/error/provider_unsupported_input", "gemini/stub-model/success"]);
    expect(served.rows[1].requestId).toBe(`${served.rows[0].requestId}-fb1`);

    await setPolicy(sim({ primary: "anthropic", claude: "stub-unsupported", fallback: false }));
    const alone = await scan(t, 1);
    expect(alone.status).toBe(502);
    expect(alone.body.code).toBeUndefined();
    expect(brief(alone.rows)).toEqual(["anthropic/stub-unsupported/error/provider_unsupported_input"]);
  });

  it("an answer that is valid JSON but not an object is recorded as an unusable answer, with the tokens it cost", async () => {
    await setPolicy(sim({ primary: "anthropic", claude: "stub-null" }));
    const r = await scan(t, 1);
    expect(r.status).toBe(502);
    expect(brief(r.rows)).toEqual(["anthropic/stub-null/error/invalid_response"]);
    expect(r.rows[0].totalTokens).toBeGreaterThan(0);
    expect(r.rows[0].estimatedCostMicroUsd).toBeGreaterThan(0);
    await waitFor(async () => (await db.select().from(aiUsageReservationsTable).where(eq(aiUsageReservationsTable.companyId, t.companyId))).length === 0, "no reservation left");
  });

  it("a refusal is accounted with the tokens it consumed and is never retried on the other provider", async () => {
    await setPolicy(sim({ primary: "anthropic", claude: "stub-refusal" }));
    const r = await scan(t, 1);
    expect(brief(r.rows)).toEqual(["anthropic/stub-refusal/error/provider_refusal"]);
    expect(r.rows[0].totalTokens).toBeGreaterThan(0);
    expect(r.rows[0].estimatedCostMicroUsd).toBeGreaterThan(0);
  });

  it("automatic fallback OFF: the outage is reported clearly — and capture without AI is offered — with one attempt only", async () => {
    await setPolicy(sim({ primary: "anthropic", claude: "stub-unavailable", fallback: false }));
    const r = await scan(t, 1);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(r.body.error).toMatch(/temporarily unavailable/i);
    expect(r.body.error).toMatch(/manually/i);
    expect(r.body.error).toMatch(/QR/);
    expect(r.body.error).toMatch(/NFC/);
    expect(brief(r.rows)).toEqual(["anthropic/stub-unavailable/error/provider_unavailable"]);
    // The scan and its image are kept (failed), so it can be reprocessed when a provider is back.
    const [row] = await db.select().from(scansTable).where(eq(scansTable.id, r.body.id));
    expect(row.status).toBe("failed");
  });

  it("both providers down: exactly two attempts, never a third, and the same clear 503", async () => {
    await setPolicy(sim({ primary: "anthropic", claude: "stub-unavailable", gemini: "stub-ratelimit" }));
    const r = await scan(t, 2);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("AI_PROVIDER_UNAVAILABLE");
    await new Promise((res) => setTimeout(res, 400));
    const rows = await ledgerSince(t.companyId, r.rows[0].id - 1, "card_extraction");
    expect(brief(rows)).toEqual(["anthropic/stub-unavailable/error/provider_unavailable", "gemini/stub-ratelimit/error/provider_rate_limited"]);
    expect(rows[1].requestId).toBe(`${rows[0].requestId}-fb1`);
    // A failed scan consumed no scan quota and created no contact.
    const failedScan = await db.select().from(scansTable).where(eq(scansTable.id, r.body.id));
    expect(failedScan[0].status).toBe("failed");
    expect(failedScan[0].contactId ?? null).toBeNull();
  });

  it("the fallback's own refusal is final too (no loop back to the primary)", async () => {
    await setPolicy(sim({ primary: "anthropic", claude: "stub-unavailable", gemini: "stub-refusal" }));
    const r = await scan(t, 2);
    expect(r.status).toBe(502);
    expect(brief(r.rows)).toEqual(["anthropic/stub-unavailable/error/provider_unavailable", "gemini/stub-refusal/error/provider_refusal"]);
  });

  it("reprocessing a failed scan answers with the same clear 503 while no provider can serve", async () => {
    await setPolicy(sim({ primary: "anthropic", claude: "stub-unavailable", fallback: false }));
    const failed = await scan(t, 1);
    expect(failed.status).toBe(503);
    // The image is stored after the response (fire-and-forget): wait for it.
    await waitFor(async () => Boolean((await db.select().from(scansTable).where(eq(scansTable.id, failed.body.id)))[0]?.imageUrl), "the scan image to be stored");
    const again = await api("POST", `/scans/${failed.body.id}/reprocess`, t.token, { appLanguage: "en" });
    expect(again.status).toBe(503);
    expect((await again.json()).code).toBe("AI_PROVIDER_UNAVAILABLE");
    // …and succeeds once a provider is back.
    await setPolicy(sim({ primary: "anthropic" }));
    const ok = await api("POST", `/scans/${failed.body.id}/reprocess`, t.token, { appLanguage: "en" });
    expect(ok.status).toBe(200);
  });
});

describe("E — budgets, allowances and spending limits hold across both providers", () => {
  let t: Tenant;
  beforeAll(async () => {
    t = await makeTenant("Budget");
  });

  it("an exhausted tenant budget stops the request before ANY provider is called — fallback is not a way around it", async () => {
    await setPolicy(sim({ primary: "anthropic", claude: "stub-unavailable" }));
    expect((await api("PATCH", "/ai/settings", t.token, { monthlyTokenBudget: 100 })).status).toBe(200); // below one reservation
    const r = await scan(t, 1);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe("AI_BUDGET_EXCEEDED");
    expect(brief(r.rows)).toEqual(["anthropic/stub-unavailable/budget_denied/budget_denied"]);
    await new Promise((res) => setTimeout(res, 300));
    expect((await ledgerSince(t.companyId, r.rows[0].id - 1, "card_extraction")).length).toBe(1); // Gemini never saw it
    expect((await api("PATCH", "/ai/settings", t.token, { monthlyTokenBudget: null })).status).toBe(200);
  });

  it("with budget available, each attempt reserves and releases on its own, and only what was actually used is counted", async () => {
    await setPolicy(sim({ primary: "anthropic", claude: "stub-unavailable" }));
    expect((await api("PATCH", "/ai/settings", t.token, { monthlyTokenBudget: 1_000_000, monthlyCostBudgetUsd: 50 })).status).toBe(200);
    const usageBefore = await (await api("GET", "/ai/usage", t.token)).json();
    const r = await scan(t, 2);
    expect([200, 201]).toContain(r.status);
    expect(brief(r.rows)).toEqual(["anthropic/stub-unavailable/error/provider_unavailable", "gemini/stub-model/success"]);
    // No reservation is left behind by either attempt.
    await waitFor(async () => (await db.select().from(aiUsageReservationsTable).where(eq(aiUsageReservationsTable.companyId, t.companyId))).length === 0, "reservations released");
    const usageAfter = await (await api("GET", "/ai/usage", t.token)).json();
    const used = (u: any) => u.totals?.totalTokens ?? u.totalTokens ?? 0;
    expect(used(usageAfter) - used(usageBefore)).toBe(r.rows[1].totalTokens);
  });

  it("a model without a price is refused wherever a cost is enforced — it could never be budgeted", async () => {
    // A tenant cost budget is in force (set above).
    await setPolicy(sim({ primary: "anthropic", claude: "stub-unpriced" }));
    const r = await scan(t);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("AI_MODEL_UNPRICED");
    expect(r.rows).toEqual([]); // refused before the provider; not rerouted to Gemini
    // With no cost budget and no spending limit nothing is enforced on cost, so the model runs (cost recorded as 0).
    expect((await api("PATCH", "/ai/settings", t.token, { monthlyTokenBudget: null, monthlyCostBudgetUsd: null })).status).toBe(200);
    const free = await makeTenant("NoBudget");
    const ok = await scan(free, 1);
    if ([200, 201].includes(ok.status)) {
      expect(brief(ok.rows)).toEqual(["anthropic/stub-unpriced/success"]);
      expect(ok.rows[0].estimatedCostMicroUsd).toBe(0);
    } else {
      // The plan of this tenant carries a cost allowance, which is an enforced cost: refused as well.
      expect(ok.body.code).toBe("AI_MODEL_UNPRICED");
    }
    // A platform spending limit on the provider is an enforced cost too.
    await setPolicy(sim({ primary: "anthropic", claude: "stub-unpriced", claudeLimit: 900_000_000 }));
    const limited = await scan(free);
    expect(limited.status).toBe(503);
    expect(limited.body.code).toBe("AI_MODEL_UNPRICED");
    expect(limited.rows).toEqual([]);
  });

  it("a platform spending limit refuses requests for that provider once reached — and they are not moved to the other provider", async () => {
    const fresh = await makeTenant("Limit");
    await setPolicy(sim({ primary: "anthropic", alert: 50 }));
    const first = await scan(fresh, 1);
    expect(brief(first.rows)).toEqual(["anthropic/stub-model/success"]);
    const spent = (await status()).providers.find((p: any) => p.provider === "anthropic").month.costMicroUsd as number;
    expect(spent).toBeGreaterThan(0);

    // Room for one more call: it is admitted, and what it costs takes Claude over its limit.
    const s = await setPolicy(sim({ primary: "anthropic", alert: 50, claudeLimit: spent + 1 }));
    expect(s.providers.find((p: any) => p.provider === "anthropic").limit).toMatchObject({ monthlyLimitMicroUsd: spent + 1, state: "approaching" });
    const second = await scan(fresh, 1);
    expect(brief(second.rows)).toEqual(["anthropic/stub-model/success"]);

    const third = await scan(fresh, 1);
    expect(third.status).toBe(503);
    expect(third.body.code).toBe("AI_PLATFORM_LIMIT_REACHED");
    expect(third.body.error).toMatch(/manually, by QR code or by NFC/);
    expect(brief(third.rows)).toEqual(["anthropic/stub-model/budget_denied/platform_limit"]);
    await new Promise((res) => setTimeout(res, 300));
    expect((await ledgerSince(fresh.companyId, third.rows[0].id - 1, "card_extraction")).map((x) => x.provider)).toEqual(["anthropic"]); // Gemini is healthy and enabled, and was not used

    const after = await status();
    expect(after.providers.find((p: any) => p.provider === "anthropic").limit.state).toBe("reached");

    // Off the capture paths the refusal says nothing about capture: a Copilot draft that
    // could not be generated keeps the neutral sentence.
    const draft = await api("POST", `/ai/copilot/contact/${fresh.contactId}/email`, fresh.token, { language: "en", instructions: "at the limit", regenerate: true });
    expect(draft.status).toBe(200);
    const note = JSON.stringify((await draft.json()).content);
    expect(note).toMatch(/monthly AI spending limit has been reached/);
    expect(note).not.toMatch(/QR code|NFC/);
    // It is the PLATFORM's limit, so it is not counted as this company's own budget being exhausted.
    const usage = await (await api("GET", "/ai/usage", fresh.token)).json();
    expect(usage.totals.budgetDenied).toBe(0);
    const denied = (await ledgerSince(fresh.companyId, 0)).filter((x) => x.status === "budget_denied");
    expect(denied.length).toBeGreaterThanOrEqual(2);
    expect(denied.every((x) => x.errorCategory === "platform_limit")).toBe(true);
    // Gemini has no limit: a company pinned to Gemini is still served.
    await setPolicy(sim({ primary: "anthropic", alert: 50, claudeLimit: spent + 1, overrides: [{ companyId: fresh.companyId, provider: "gemini", model: null }] }));
    expect(brief((await scan(fresh, 1)).rows)).toEqual(["gemini/stub-model/success"]);
  });

  it("platform owners are alerted when a provider reaches its limit — once, with a link to the settings, and nothing about any tenant", async () => {
    await waitFor(
      async () =>
        (
          await db
            .select({ id: notificationsTable.id })
            .from(notificationsTable)
            .where(and(sql`${notificationsTable.metadata} ->> 'kind' = 'ai_platform_spend'`, sql`${notificationsTable.metadata} ->> 'subkind' = 'reached'`, sql`${notificationsTable.metadata} ->> 'provider' = 'anthropic'`))
        ).length > 0,
      "the limit-reached alert",
    );
    const alerts = await db.select().from(notificationsTable).where(and(sql`${notificationsTable.metadata} ->> 'kind' = 'ai_platform_spend'`, sql`${notificationsTable.metadata} ->> 'provider' = 'anthropic'`));
    const owners = await db.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.role, "platform_owner"), eq(usersTable.isActive, true)));
    const reached = alerts.filter((a) => (a.metadata as any).subkind === "reached");
    expect(reached.length).toBe(owners.length); // one per owner, not one per refused request
    for (const a of reached) {
      expect(owners.map((o) => o.id)).toContain(a.userId);
      expect(a.companyId).toBeNull();
      expect(a.category).toBe("ai");
      expect(a.link).toBe("/platform/settings");
      expect(a.title).toMatch(/Claude monthly AI spending limit reached/);
    }
    await setPolicy(sim());
  });

  it("lowering a limit below what has already been spent is announced before it is applied", async () => {
    const s = await status();
    const spent = s.providers.find((p: any) => p.provider === "anthropic").month.costMicroUsd as number;
    const held = await put(sim({ claudeLimit: Math.max(1, spent - 1) }), s.version);
    expect(held.status).toBe(409);
    expect((await held.json()).context.warnings.join(" ")).toMatch(/Claude has already spent .* will be refused immediately/);
  });

  it("sending requests to a provider that is already at its limit is announced too: switching it back on, making it primary, pinning a company to it", async () => {
    const spent = (await status()).providers.find((p: any) => p.provider === "anthropic").month.costMicroUsd as number;
    const limit = Math.max(1, spent - 1);
    const refused = /Claude has already spent .* will be refused immediately, and are not moved to the other provider/;

    // Claude off, at its limit, Gemini primary: nothing is routed to Claude.
    await setPolicy(sim({ primary: "gemini", claude: false, claudeLimit: limit }));
    let v = (await status()).version;
    // Switching Claude back on (the limit itself is unchanged).
    let held = await put(sim({ primary: "gemini", claudeLimit: limit }), v);
    expect(held.status).toBe(409);
    expect((await held.json()).context.warnings.join(" ")).toMatch(refused);
    expect((await put(sim({ primary: "gemini", claudeLimit: limit }), v, true)).status).toBe(200);

    // Making it the primary.
    v = (await status()).version;
    held = await put(sim({ primary: "anthropic", claudeLimit: limit }), v);
    expect(held.status).toBe(409);
    expect((await held.json()).context.warnings.join(" ")).toMatch(refused);

    // Pinning a company to it.
    held = await put(sim({ primary: "gemini", claudeLimit: limit, overrides: [{ companyId: t.companyId, provider: "anthropic", model: null }] }), v);
    expect(held.status).toBe(409);
    expect((await held.json()).context.warnings.join(" ")).toMatch(refused);
    // Pinning a company to the provider that has room is not held back.
    expect((await put(sim({ primary: "gemini", claudeLimit: limit, overrides: [{ companyId: t.companyId, provider: "gemini", model: null }] }), v)).status).toBe(200);
    await setPolicy(sim());
  });

  it("a call that ends in an unusable answer does not keep its share of the limit held", async () => {
    const fresh = await makeTenant("Hold");
    // A limit is in force (so the call takes a hold), with plenty of room.
    await setPolicy(sim({ primary: "gemini", gemini: "stub-null", geminiLimit: 900_000_000 }));
    const bad = await scan(fresh, 1);
    expect(brief(bad.rows)).toEqual(["gemini/stub-null/error/invalid_response"]);
    // Room for LESS than one hold above what is spent: a hold left behind by the call above would refuse the next one.
    const spent = (await status()).providers.find((p: any) => p.provider === "gemini").month.costMicroUsd as number;
    await setPolicy(sim({ primary: "gemini", geminiLimit: spent + 1_000 }));
    const next = await scan(fresh, 1);
    expect([200, 201]).toContain(next.status);
    expect(brief(next.rows)).toEqual(["gemini/stub-model/success"]);
    await setPolicy(sim());
  });
});

describe("F — the existing AI features run on Claude and on Gemini unchanged", () => {
  for (const provider of ["anthropic", "gemini"] as const) {
    it(`${provider === "anthropic" ? "Claude" : "Gemini"}: card extraction, scoring, enrichment, insights, Copilot, workflow, executive and the Assistant all answer and are attributed to it`, async () => {
      const t = await makeTenant(provider === "anthropic" ? "FeatClaude" : "FeatGemini");
      await setPolicy(sim({ primary: provider, fallback: false }));
      const before = await lastLedgerId();

      // Image-based business-card extraction → structured fields.
      const scanned = await scan(t, 1);
      expect([200, 201]).toContain(scanned.status);
      expect(typeof scanned.body.extractedData).toBe("object");
      // Lead scoring over the extracted fields.
      expect((await api("POST", `/scans/${scanned.body.id}/score`, t.token, {})).status).toBe(200);
      // Enrichment.
      expect((await api("POST", `/contacts/${t.contactId}/enrich`, t.token, {})).status).toBe(200);
      // Lead / contact intelligence.
      expect((await api("POST", `/ai/insights/contact/${t.contactId}/analyze`, t.token, {})).status).toBe(200);
      // Sales Copilot (a draft — never sent).
      const draft = await api("POST", `/ai/copilot/contact/${t.contactId}/email`, t.token, { language: "en", instructions: "intro", regenerate: true });
      expect(draft.status).toBe(200);
      const draftBody = await draft.json();
      expect(draftBody.source).toBe("ai");
      expect([draftBody.provider, draftBody.model]).toEqual([provider, "stub-model"]);
      // Workflow intelligence on a lead.
      const lead = await api("POST", "/leads", t.token, { contactId: t.contactId, stage: "prospect", title: "Provider sweep" });
      expect(lead.status).toBe(201);
      const leadId = (await lead.json()).id;
      const wf = await api("POST", `/ai/workflow/lead/${leadId}/analyze`, t.token, {});
      expect(wf.status).toBe(200);
      const recs = (await wf.json()).recommendations as Array<{ source: string; provider: string | null; model: string | null }>;
      const aiRecs = recs.filter((r) => r.source === "ai");
      expect(aiRecs.length).toBeGreaterThan(0);
      expect(aiRecs.every((r) => r.provider === provider && r.model === "stub-model")).toBe(true);
      expect(recs.filter((r) => r.source !== "ai").every((r) => r.provider == null)).toBe(true); // deterministic rows never carry AI provenance
      // Executive intelligence.
      const exec = await api("POST", "/ai/executive/summaries", t.token, { period: "week" });
      expect([200, 201]).toContain(exec.status);
      // The Assistant.
      const conv = await api("POST", "/ai/assistant/conversations", t.token, {});
      expect([200, 201]).toContain(conv.status);
      const convId = (await conv.json()).id;
      const msg = await api("POST", `/ai/assistant/conversations/${convId}/messages`, t.token, { content: "Where are the bottlenecks in our pipeline?" });
      expect([200, 201]).toContain(msg.status);

      await new Promise((res) => setTimeout(res, 500));
      const rows = await ledgerSince(t.companyId, before);
      const served = rows.filter((r) => ["success", "error", "timeout"].includes(r.status));
      expect(served.length).toBeGreaterThanOrEqual(6);
      // Every request of every feature went to this provider, and none failed.
      expect([...new Set(served.map((r) => `${r.provider}/${r.model}/${r.status}`))]).toEqual([`${provider}/stub-model/success`]);
      const features = new Set(served.map((r) => r.feature));
      for (const f of ["card_extraction", "lead_scoring", "contact_enrichment", "email_composer"]) expect([...features], `feature ${f}`).toContain(f);
      expect([...features].some((f) => f.startsWith("workflow_"))).toBe(true);
      // Usage analytics never store prompt or answer content: the ledger has no such column,
      // and what it does store as text carries none of the request.
      for (const r of served) {
        for (const column of ["prompt", "response", "content", "input", "output", "text", "image"]) expect(Object.keys(r), column).not.toContain(column);
        expect(JSON.stringify(r)).not.toMatch(/Acme Trading|Probe|data:image/);
      }
    });
  }

  it("after a fallback, a stored AI draft is attributed to the provider that actually wrote it", async () => {
    const t = await makeTenant("Provenance");
    await setPolicy(sim({ primary: "anthropic", claude: "stub-unavailable", gemini: "stub-model" }));
    const draft = await api("POST", `/ai/copilot/contact/${t.contactId}/email`, t.token, { language: "en", instructions: "after fallback", regenerate: true });
    expect(draft.status).toBe(200);
    const body = await draft.json();
    expect(body.source).toBe("ai");
    expect([body.provider, body.model]).toEqual(["gemini", "stub-model"]);
    await setPolicy(sim());
  });
});

describe("G — the settings are durable: a new server process reads what was saved", () => {
  it("the saved policy is one row in platform_settings, and a separate process loads the same policy from it", async () => {
    const pinned = await makeTenant("Durable");
    const saved = await setPolicy(sim({ primary: "gemini", fallback: false, alert: 61, claude: "stub-nousage", geminiLimit: 123_456_789, overrides: [{ companyId: pinned.companyId, provider: "anthropic", model: null }] }));

    const rows = await db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "ai_providers"));
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(saved.version);
    expect(rows[0].updatedBy).toBe(platformUserId);
    expect(rows[0].value).toEqual({
      primary: "gemini",
      fallbackEnabled: false,
      alertThresholdPct: 61,
      providers: { anthropic: { enabled: true, model: "stub-nousage", monthlyLimitMicroUsd: null }, gemini: { enabled: true, model: "stub-model", monthlyLimitMicroUsd: 123_456_789 } },
      tenantOverrides: [{ companyId: pinned.companyId, provider: "anthropic", model: null }],
    });

    // THIS process is not the API server: loading the service here is what a restarted
    // server does — it has nothing in memory and reads the policy from the database.
    const service = await import("../src/services/platform-ai.service.js");
    service.invalidatePolicyCache();
    const state = await service.getPolicyState({ fresh: true });
    expect(state.persisted).toBe(true);
    expect(state.storage).toBe("ok");
    expect(state.version).toBe(saved.version);
    expect(state.policy).toEqual(plain(saved));
    const chain = await service.resolveChainFor({ companyId: null, tenant: null });
    expect(chain.candidates.map((c) => `${c.provider}:${c.model}`)).toEqual(["gemini:stub-model"]); // fallback is off
    const pinnedChain = await service.resolveChainFor({ companyId: pinned.companyId, tenant: null });
    expect(pinnedChain.candidates[0]).toMatchObject({ provider: "anthropic", model: "stub-nousage" });
    await setPolicy(sim());
  });

  it("a database without the settings table is recognised as such (the real driver error), and any other error is not", async () => {
    const { isUndefinedTable } = await import("../src/repositories/platform-settings.repository.js");
    const missing = await db.execute(sql`select 1 from platform_settings_table_that_does_not_exist`).then(
      () => null,
      (err: unknown) => err,
    );
    expect(missing).not.toBeNull();
    expect(isUndefinedTable(missing)).toBe(true);
    const other = await db.execute(sql`select 1 from`).then(
      () => null,
      (err: unknown) => err,
    );
    expect(other).not.toBeNull();
    expect(isUndefinedTable(other)).toBe(false);
    expect(isUndefinedTable(new Error("boom"))).toBe(false);
    expect(isUndefinedTable(null)).toBe(false);
  });

  it("the test tenants are still in place and no reservation was left behind by this file", async () => {
    const left = await db.select().from(aiUsageReservationsTable).where(inArray(aiUsageReservationsTable.companyId, companyIds));
    expect(left).toEqual([]);
    expect((await db.select({ id: contactsTable.id }).from(contactsTable).where(inArray(contactsTable.companyId, companyIds))).length).toBeGreaterThan(0);
    expect((await db.select({ id: leadsTable.id }).from(leadsTable).where(inArray(leadsTable.companyId, companyIds))).length).toBeGreaterThan(0);
  });
});
