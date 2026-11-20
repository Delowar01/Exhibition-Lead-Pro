/**
 * Batch 7 — REAL vision OCR verification against a LIVE AI provider (NOT part of the
 * automated suite; it is BILLABLE and is run only deliberately, by the operator).
 *
 * Sends the 8 generated fixture images (scripts/ocr-fixtures/) through the real
 * POST /api/scans pipeline under a throwaway tenant, records per-image acceptance /
 * extraction / field accuracy / token usage from the ai_invocations ledger, prints a
 * report, and writes scripts/ocr-live-report.json. The throwaway tenant is deleted at the
 * end; the report file is the evidence.
 *
 * WHICH PROVIDER. Since the platform AI provider policy, a tenant setting no longer
 * selects the provider — the policy does. This script therefore has to be TOLD which
 * provider it is verifying, and refuses to make a single provider call otherwise:
 *
 *   VERIFY_AI_PROVIDER=anthropic   (Claude)   or   VERIFY_AI_PROVIDER=gemini
 *
 * It pins its throwaway company to that provider through a company override in the
 * policy (removed again at the end), confirms from GET /ai/health that this provider —
 * with a key on the server — is what will serve the tenant, and only then scans. The
 * report names the provider and model taken from the ledger rows, never from an
 * assumption, and says so if any row was served by another provider (a fallback).
 *
 * Run (dev server must be up):
 *   VERIFY_AI_PROVIDER=anthropic npx tsx scripts/verify-ocr-live.ts
 *
 * Written with the provider policy and NOT YET EXECUTED against a live provider.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  scansTable,
  aiSettingsTable,
  aiInvocationsTable,
  aiUsageReservationsTable,
} from "@workspace/db";
import { ENGLISH_CARD, ARABIC_CARD } from "./generate-ocr-fixtures";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "ocr-fixtures");
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();

type Fields = Record<string, unknown> & { original?: Record<string, unknown> | null };

interface ImageResult {
  fixture: string;
  appLanguage: string;
  httpStatus: number;
  scanStatus: string | null;
  code: string | null;
  confidence: number | null;
  extracted: Fields | null;
  fieldReport: Record<string, string> | null;
  arabicPreserved: boolean | null;
  notes: string[];
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

async function api(method: string, p: string, token: string, body?: unknown) {
  return fetch(`${BASE}${p}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const norm = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/[\s\-()]/g, "");

function compareFields(extracted: Fields, truth: Record<string, string>): Record<string, string> {
  const report: Record<string, string> = {};
  for (const [key, expected] of Object.entries(truth)) {
    const got = extracted[key];
    if (got == null || got === "") {
      report[key] = `MISSED (expected "${expected}")`;
    } else if (norm(got) === norm(expected) || norm(String(got)).includes(norm(expected)) || norm(expected).includes(norm(String(got)))) {
      report[key] = "OK";
    } else {
      report[key] = `DIFF (expected "${expected}", got "${String(got)}")`;
    }
  }
  return report;
}

/** Fields the model returned non-null that are NOT on the printed card at all. */
function inventedFields(extracted: Fields, truthKeys: string[]): string[] {
  const allowed = new Set([...truthKeys, "arabicName", "original", "officePhone", "linkedin", "address", "postalCode", "city", "country", "website"]);
  return Object.entries(extracted)
    .filter(([k, v]) => v != null && v !== "" && !allowed.has(k))
    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`);
}

type Wanted = "anthropic" | "gemini";

interface PolicyStatus {
  version: number;
  policy: {
    primary: string;
    fallbackEnabled: boolean;
    alertThresholdPct: number;
    providers: { anthropic: Record<string, unknown>; gemini: Record<string, unknown> };
    tenantOverrides: Array<{ companyId: number; provider: string; model: string | null }>;
  };
}

/** The policy as the API takes it back: the company names of the status are for reading only. */
function policyOf(status: PolicyStatus) {
  const p = status.policy;
  return {
    primary: p.primary,
    fallbackEnabled: p.fallbackEnabled,
    alertThresholdPct: p.alertThresholdPct,
    providers: { anthropic: { ...p.providers.anthropic }, gemini: { ...p.providers.gemini } },
    tenantOverrides: p.tenantOverrides.map((o) => ({ companyId: o.companyId, provider: o.provider, model: o.model })),
  };
}

/** Adds (provider given) or removes (null) the throwaway company's override. Throws unless the API accepts it. */
async function setOverride(platformToken: string, companyId: number, provider: Wanted | null): Promise<void> {
  const current = await api("GET", "/platform/ai/providers", platformToken);
  if (current.status !== 200) throw new Error(`could not read the AI provider policy: ${current.status}`);
  const status = (await current.json()) as PolicyStatus;
  const policy = policyOf(status);
  policy.tenantOverrides = policy.tenantOverrides.filter((o) => o.companyId !== companyId);
  if (provider) policy.tenantOverrides.push({ companyId, provider, model: null });
  // No `confirm`: if the server holds the change back, this script stops rather than confirm for the operator.
  const res = await api("PUT", "/platform/ai/providers", platformToken, { policy, expectedVersion: status.version });
  if (res.status !== 200) throw new Error(`the AI provider policy was not changed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function main() {
  const wanted = (process.env.VERIFY_AI_PROVIDER ?? "").trim().toLowerCase();
  if (wanted !== "anthropic" && wanted !== "gemini") {
    console.error("Set VERIFY_AI_PROVIDER=anthropic or VERIFY_AI_PROVIDER=gemini. Nothing was called.");
    process.exit(2);
  }
  console.log(`== Live OCR verification — provider under test: ${wanted} (billable) ==`);
  const platformToken = await loginToken(PLATFORM);

  // Throwaway tenant with no budget constraints.
  const createCo = await api("POST", "/companies", platformToken, { name: `QA OCR Live ${SUFFIX}`, plan: "professional" });
  if (createCo.status !== 201) throw new Error(`company create failed: ${createCo.status}`);
  const companyId = (await createCo.json()).id as number;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));
  const adminEmail = `qa-ocr-live@ocrlive-${SUFFIX}.test`;
  const cu = await api("POST", "/users", platformToken, {
    email: adminEmail, name: "QA OCR Live", role: "primary_admin", password: PW, companyId,
  });
  if (cu.status !== 201) throw new Error(`user create failed: ${cu.status}`);
  const adminToken = await loginToken({ email: adminEmail, password: PW });
  const cleanup = async () => {
    await db.delete(aiInvocationsTable).where(eq(aiInvocationsTable.companyId, companyId));
    await db.delete(aiUsageReservationsTable).where(eq(aiUsageReservationsTable.companyId, companyId));
    await db.delete(aiSettingsTable).where(eq(aiSettingsTable.companyId, companyId));
    await db.delete(scansTable).where(eq(scansTable.companyId, companyId));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, companyId));
    await db.delete(usersTable).where(eq(usersTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  };

  // BEFORE any provider call: pin the throwaway company to the provider under test and
  // confirm that it — with a key on the server — is what will serve it.
  let pinned = false;
  try {
    const st = await api("PATCH", "/ai/settings", adminToken, { enabled: true, monthlyTokenBudget: null, monthlyCostBudgetUsd: null });
    if (st.status !== 200) throw new Error(`ai settings failed: ${st.status} ${await st.text()}`);
    await setOverride(platformToken, companyId, wanted);
    pinned = true;
    const health = (await (await api("GET", "/ai/health", adminToken)).json()) as { provider?: string; model?: string; configured?: boolean };
    if (health.provider !== wanted || health.configured !== true) {
      throw new Error(`the tenant would be served by "${health.provider}" (configured: ${health.configured}), not by "${wanted}" — is ${wanted} enabled in Settings → AI Providers, and is its key on the server?`);
    }
    console.log(`Serving provider confirmed: ${health.provider} · ${health.model}`);
  } catch (err) {
    console.error(`Aborted before any provider call: ${err instanceof Error ? err.message : String(err)}`);
    if (pinned) await setOverride(platformToken, companyId, null).catch(() => console.error("WARNING: remove the override of the throwaway company in Settings → AI Providers."));
    await cleanup();
    process.exit(2);
  }

  const plan: Array<{ file: string; appLanguage: "en" | "ar"; truth: Record<string, string> | null }> = [
    { file: "english-clean.jpg", appLanguage: "en", truth: ENGLISH_CARD as unknown as Record<string, string> },
    { file: "arabic-bilingual.jpg", appLanguage: "ar", truth: {
      firstName: ARABIC_CARD.firstName, lastName: ARABIC_CARD.lastName, jobTitle: ARABIC_CARD.jobTitle,
      company: ARABIC_CARD.company, email: ARABIC_CARD.email, mobile: ARABIC_CARD.mobile,
    } },
    { file: "rotated.jpg", appLanguage: "en", truth: ENGLISH_CARD as unknown as Record<string, string> },
    { file: "perspective.jpg", appLanguage: "en", truth: ENGLISH_CARD as unknown as Record<string, string> },
    { file: "low-light.jpg", appLanguage: "en", truth: ENGLISH_CARD as unknown as Record<string, string> },
    { file: "low-res.jpg", appLanguage: "en", truth: ENGLISH_CARD as unknown as Record<string, string> },
    { file: "cropped.jpg", appLanguage: "en", truth: {
      firstName: ENGLISH_CARD.firstName, lastName: ENGLISH_CARD.lastName,
      jobTitle: ENGLISH_CARD.jobTitle, company: ENGLISH_CARD.company, mobile: ENGLISH_CARD.mobile,
    } },
    { file: "non-card.jpg", appLanguage: "en", truth: null },
  ];

  const results: ImageResult[] = [];
  for (const item of plan) {
    const buf = await fs.readFile(path.join(FIXTURES, item.file));
    const started = Date.now();
    const res = await api("POST", "/scans", adminToken, {
      imageData: `data:image/jpeg;base64,${buf.toString("base64")}`,
      appLanguage: item.appLanguage,
    });
    const ms = Date.now() - started;
    let body: Record<string, unknown> = {};
    try { body = await res.json(); } catch { /* non-JSON */ }
    const extracted = (body.extractedData ?? null) as Fields | null;

    const r: ImageResult = {
      fixture: item.file,
      appLanguage: item.appLanguage,
      httpStatus: res.status,
      scanStatus: typeof body.status === "string" ? body.status : null,
      code: typeof body.code === "string" ? body.code : null,
      confidence: typeof body.confidence === "number" ? body.confidence : null,
      extracted,
      fieldReport: extracted && item.truth ? compareFields(extracted, item.truth) : null,
      arabicPreserved: null,
      notes: [`latency ${ms}ms`],
    };
    if (item.file === "arabic-bilingual.jpg" && extracted) {
      const flat = JSON.stringify(extracted);
      r.arabicPreserved = flat.includes("خالد") || flat.includes("المنصوري") || flat.includes("النور");
    }
    if (extracted && item.truth) {
      const invented = inventedFields(extracted, Object.keys(item.truth));
      if (invented.length) r.notes.push(`unexpected non-null fields: ${invented.join("; ")}`);
    }
    results.push(r);
    console.log(`\n--- ${item.file} (${item.appLanguage}) → HTTP ${res.status}, scan=${r.scanStatus}, code=${r.code}, conf=${r.confidence}, ${ms}ms`);
    if (r.fieldReport) for (const [k, v] of Object.entries(r.fieldReport)) console.log(`    ${k}: ${v}`);
    if (r.arabicPreserved != null) console.log(`    arabicPreserved: ${r.arabicPreserved}`);
    if (!extracted && res.status >= 400) console.log(`    error: ${String(body.error ?? "").slice(0, 160)}`);
  }

  // Ledger: token usage per invocation (proves the REAL provider was used, and which one).
  const rows = await db
    .select()
    .from(aiInvocationsTable)
    .where(and(eq(aiInvocationsTable.companyId, companyId), eq(aiInvocationsTable.feature, "card_extraction")));
  const ledger = rows.map((row) => ({
    status: row.status, provider: row.provider, model: row.model, promptVersion: row.promptVersion,
    inputTokens: row.inputTokens, outputTokens: row.outputTokens, totalTokens: row.totalTokens,
    usageSource: (row as Record<string, unknown>).usageSource ?? null, latencyMs: row.latencyMs,
  }));
  console.log("\n== card_extraction ledger rows ==");
  for (const l of ledger) console.log(JSON.stringify(l));

  // The provider and model come from the ledger — what actually ran — never from an assumption.
  const servedBy = [...new Set(ledger.filter((l) => ["success", "error", "timeout"].includes(l.status)).map((l) => `${l.provider}/${l.model}`))];
  const otherProviders = [...new Set(ledger.map((l) => l.provider).filter((prov) => prov !== wanted))];
  if (otherProviders.length > 0) console.log(`\nNOTE: some rows were served by another provider (${otherProviders.join(", ")}) — a fallback happened; this run is not a clean verification of ${wanted}.`);
  const report = { ranAt: new Date().toISOString(), providerUnderTest: wanted, servedBy, cleanRun: otherProviders.length === 0, results, ledger };
  await fs.writeFile(path.join(__dirname, "ocr-live-report.json"), JSON.stringify(report, null, 2));
  console.log(`\nReport written to scripts/ocr-live-report.json`);

  // Remove the override, then the throwaway tenant (the report file is the persistent evidence).
  await setOverride(platformToken, companyId, null).catch((err) => console.error(`WARNING: the override of company ${companyId} was not removed (${err instanceof Error ? err.message : String(err)}) — remove it in Settings → AI Providers.`));
  await cleanup();
  console.log("Override removed; throwaway tenant cleaned up.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
