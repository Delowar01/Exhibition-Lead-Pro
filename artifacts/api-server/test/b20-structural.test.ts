import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Batch 20 — structural guarantees that cannot be observed through HTTP alone.
// These read the SOURCE (not the build) so a regression is caught at review time:
//   • access is decided from the canonical subscriptions row only (no reads of
//     the legacy companies.status / trial_ends_at / plan columns on the gate paths);
//   • the raw-body webhook is mounted BEFORE the JSON parser;
//   • the official Stripe SDK is confined to the provider boundary;
//   • the tenant read routes never write;
//   • the web portals carry no simulated metrics.

const here = path.dirname(fileURLToPath(import.meta.url));
const apiSrc = path.resolve(here, "../src");
const webSrc = path.resolve(here, "../../web-app/src");
const read = (p: string) => fs.readFileSync(p, "utf8");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
};

describe("access gate reads the canonical subscription only", () => {
  const gateFiles = ["middlewares/requireAuth.ts", "lib/sessions.ts", "services/auth.service.ts", "lib/company-access.ts"];
  for (const f of gateFiles) {
    it(`${f} never consults companies.status / trial_ends_at / plan or the retired evaluateCompanyAccess`, () => {
      const src = read(path.join(apiSrc, f));
      expect(src).not.toMatch(/companiesTable\.(status|trialEndsAt|plan)\b/);
      expect(src).not.toMatch(/company\.(status|trialEndsAt)\b/);
      expect(src).not.toMatch(/evaluateCompanyAccess\(/);
      expect(src).not.toMatch(/\.trialEndsAt\b/);
    });
  }
  it("company-access resolves through the shared resolver from the subscriptions table", () => {
    const src = read(path.join(apiSrc, "lib/company-access.ts"));
    expect(src).toMatch(/from\(subscriptionsTable\)/);
    expect(src).toMatch(/resolveEntitlement\(/);
    expect(src).not.toMatch(/from\(companiesTable\)/);
  });
  it("the per-request gate, login and refresh all use loadTenantAccess", () => {
    for (const f of ["middlewares/requireAuth.ts", "lib/sessions.ts", "services/auth.service.ts"]) {
      expect(read(path.join(apiSrc, f))).toMatch(/loadTenantAccess\(/);
    }
  });
  it("the deprecated scans_used counter is no longer written anywhere", () => {
    for (const f of walk(apiSrc)) {
      expect(read(f), f).not.toMatch(/incrementScansUsed|scansUsed\s*:\s*sql/);
    }
  });
});

describe("Stripe boundary", () => {
  it("the raw-body webhook route is mounted before express.json()", () => {
    const app = read(path.join(apiSrc, "app.ts"));
    const webhookAt = app.indexOf("stripeWebhookHandler");
    const jsonAt = app.indexOf("express.json(");
    expect(webhookAt).toBeGreaterThan(-1);
    expect(jsonAt).toBeGreaterThan(-1);
    expect(webhookAt).toBeLessThan(jsonAt);
    expect(app).toMatch(/express\.raw\(/);
    expect(app).toMatch(/limit:\s*config\.billing\.webhookMaxBodyBytes/);
  });
  it("only the provider modules import the official SDK, and the secret key is read only by the provider factory", () => {
    const allowed = new Set(["lib/billing/stripe-provider.ts", "lib/billing/fake-provider.ts"]);
    for (const f of walk(apiSrc)) {
      const rel = path.relative(apiSrc, f);
      const src = read(f);
      if (/from\s+["']stripe["']/.test(src)) expect(allowed.has(rel), `${rel} imports stripe`).toBe(true);
      if (/stripeSecretKey/.test(src)) expect(["lib/billing/provider.ts", "config.ts"].includes(rel), `${rel} reads the secret key`).toBe(true);
      expect(src, `${rel} logs a secret`).not.toMatch(/logger\.[a-z]+\([^)]*(stripeSecretKey|stripeWebhookSecret|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)/);
    }
  });
  it("the webhook service never resolves a tenant by email", () => {
    const src = read(path.join(apiSrc, "services/billing-webhook.service.ts"));
    expect(src).not.toMatch(/customer_email|customer_details|\.email\b/);
  });
  it("no frontend code calls the provider directly", () => {
    for (const f of walk(webSrc)) {
      expect(read(f), f).not.toMatch(/api\.stripe\.com|from\s+["']stripe["']|@stripe\/stripe-js/);
    }
  });
});

describe("tenant reads never write", () => {
  it("routes/subscriptions.ts GET handlers only call read services; the retired upgrade route touches no state", () => {
    const src = read(path.join(apiSrc, "routes/subscriptions.ts"));
    const gets = src.match(/router\.get\([\s\S]*?\}\);/g) ?? [];
    expect(gets.length).toBeGreaterThanOrEqual(3);
    for (const g of gets) expect(g).not.toMatch(/insert|update|delete|transaction/i);
    const retired = src.slice(src.indexOf("function retired"), src.indexOf("router.post(\"/subscriptions/upgrade\""));
    expect(retired).toMatch(/410/);
    expect(retired).toMatch(/BILLING_UPGRADE_RETIRED/);
    expect(retired).not.toMatch(/subscriptions\.|repo\.|db\./);
  });
  it("the tenant read projections in subscriptions.service.ts contain no writes", () => {
    const src = read(path.join(apiSrc, "services/subscriptions.service.ts"));
    const start = src.indexOf("export async function projectSubscription");
    const end = src.indexOf("// ── Checkout");
    const reads = src.slice(start, end);
    expect(reads).not.toMatch(/repo\.(insert|update|delete)|db\.transaction|writeSubscriptionAudit/);
  });
});

describe("truthful web portals", () => {
  const pages = ["pages/platform/Dashboard.tsx", "pages/platform/Subscriptions.tsx", "pages/platform/Companies.tsx", "pages/platform/Users.tsx", "pages/admin/Subscription.tsx"];
  for (const p of pages) {
    it(`${p} has no random numbers, hard-coded revenue or percentage-derived counts`, () => {
      const src = read(path.join(webSrc, p));
      expect(src).not.toMatch(/Math\.random/);
      expect(src).not.toMatch(/monthlyRevenue/);
      expect(src).not.toMatch(/\*\s*0\.\d+\)/); // e.g. inactiveUsers * 0.7
      expect(src).not.toMatch(/\$\d+(\.\d+)?\s*\/\s*(mo|month)/i);
    });
  }
  it("the tenant page renders prices only from verified provider mappings", () => {
    const src = read(path.join(webSrc, "pages/admin/Subscription.tsx"));
    expect(src).toMatch(/unitAmountMinor/);
    expect(src).not.toMatch(/upgradeSubscription|useUpgradeSubscription/);
  });
});
