// Platform AI provider management — how the policy service behaves when its storage is
// missing or unreadable (src/services/platform-ai.service.ts). The repository is replaced
// by a fake, so no database state is touched and nothing is written: this file is about
// the service's decisions only.
//
//   • The settings table does not exist yet (the application was deployed before the
//     reviewed schema change): the DEFAULT policy is served read-only, AI keeps resolving
//     through it, and a save is refused with a clear 503 — nothing is silently dropped.
//   • The policy cannot be read at all: the last policy known to the process stays in
//     effect; with none known, requests fail closed — a provider the owner disabled
//     never comes back because of a database error.
import { describe, it, expect, vi, beforeEach } from "vitest";

const repo = vi.hoisted(() => ({
  readSetting: vi.fn(),
  writeSetting: vi.fn(),
  userNames: vi.fn(async () => new Map<number, string>()),
  companyNames: vi.fn(async () => new Map<number, string>()),
  monthUsageByProvider: vi.fn(async () => []),
  monthSpendOfProvider: vi.fn(async () => 0),
  activePlatformOwnerIds: vi.fn(async () => [] as number[]),
  platformAlertSent: vi.fn(async () => false),
  isUndefinedTable: vi.fn(() => false),
}));
vi.mock("../src/repositories/platform-settings.repository.js", () => repo);
vi.mock("../src/services/notifications.service.js", () => ({ createNotification: vi.fn(async () => undefined) }));

import * as service from "../src/services/platform-ai.service.js";
import { defaultPolicy } from "../src/ai/policy.js";
import { AppError } from "../src/middlewares/errorHandler.js";
import { config } from "../src/config.js";

const ACTOR = { userId: 1, userName: "owner@example.test", ipAddress: null };
const DEFAULT = defaultPolicy(service.catalog);

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  vi.clearAllMocks();
  service.invalidatePolicyCache();
  service.resetPlatformSpendCache();
});

describe("the settings table has not been added to this database yet", () => {
  beforeEach(() => {
    repo.readSetting.mockResolvedValue({ available: false, row: null });
  });

  it("re-checks for the table once a minute, not at every cache expiry (each look is a failing query)", async () => {
    vi.useFakeTimers();
    try {
      await service.getPolicyState();
      await service.getPolicyState();
      vi.advanceTimersByTime(config.ai.policyCacheTtlMs + 1_000);
      await service.getPolicyState();
      expect(repo.readSetting).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      await service.getPolicyState();
      expect(repo.readSetting).toHaveBeenCalledTimes(2);
      // A save, and the settings page, always look again.
      await service.getPolicyState({ fresh: true });
      expect(repo.readSetting).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves the default policy — Claude and Gemini enabled, Claude primary, fallback on — and says that it cannot be changed", async () => {
    const state = await service.getPolicyState({ fresh: true });
    expect(state).toMatchObject({ version: 0, persisted: false, storage: "unavailable", updatedAt: null, updatedBy: null });
    expect(state.policy).toEqual(DEFAULT);
    expect(state.policy).toMatchObject({ primary: "anthropic", fallbackEnabled: true });

    const status = await service.getStatus();
    expect(status.storage).toBe("unavailable");
    expect(status.persisted).toBe(false);
    expect(status.version).toBe(0);
    expect(status.policy.providers.anthropic.enabled && status.policy.providers.gemini.enabled).toBe(true);
  });

  it("AI requests keep resolving through the default policy (nothing has a key here, so nothing can serve — and the pre-policy provider is the one reported)", async () => {
    const chain = await service.resolveChainFor({ companyId: 7, tenant: { provider: "gemini", model: "gemini-2.5-flash" } });
    expect(chain.candidates).toEqual([]);
    expect(chain.unavailable).toBe("none_configured");
    expect(chain.display).toEqual({ provider: "gemini", model: "gemini-2.5-flash" });
  });

  it("refuses a save with 503 AI_POLICY_STORAGE_UNAVAILABLE and writes nothing", async () => {
    const err = await rejection(service.updatePolicy(ACTOR, { policy: { ...DEFAULT, primary: "gemini" }, expectedVersion: 0, confirm: true }));
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe(service.AI_POLICY_STORAGE_UNAVAILABLE);
    expect(repo.writeSetting).not.toHaveBeenCalled();
  });

  it("no spending limit exists in the default policy, so no request is held or refused for one", async () => {
    await expect(service.admitPlatformSpend("anthropic", "claude-opus-5-5", "req-1")).resolves.toBe(false);
    expect(repo.monthSpendOfProvider).not.toHaveBeenCalled();
  });
});

describe("the table disappears between the read and the write", () => {
  it("the write reports it and the save is refused the same way", async () => {
    repo.readSetting.mockResolvedValue({ available: true, row: null });
    repo.writeSetting.mockResolvedValue({ status: "unavailable" });
    const err = await rejection(service.updatePolicy(ACTOR, { policy: { ...DEFAULT, alertThresholdPct: 50 }, expectedVersion: 0, confirm: true }));
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe(service.AI_POLICY_STORAGE_UNAVAILABLE);
  });
});

describe("the policy cannot be read", () => {
  const stored = { ...DEFAULT, providers: { ...DEFAULT.providers, anthropic: { ...DEFAULT.providers.anthropic, enabled: false } }, primary: "gemini" as const };
  const row = { key: "ai_providers", value: stored as unknown as Record<string, unknown>, version: 4, updatedBy: 1, updatedAt: new Date() };

  it("with nothing known to this process the request fails closed (503) — defaults are NOT assumed", async () => {
    repo.readSetting.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const err = await rejection(service.getPolicyState({ fresh: true }));
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("AI_POLICY_UNREADABLE");
    await expect(service.resolveChainFor({ companyId: 1, tenant: null })).rejects.toBeInstanceOf(AppError);
  });

  it("the last known policy stays in effect: a provider the owner disabled stays disabled through a database error", async () => {
    repo.readSetting.mockResolvedValueOnce({ available: true, row });
    const first = await service.getPolicyState({ fresh: true });
    expect(first.policy.providers.anthropic.enabled).toBe(false);

    repo.readSetting.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const again = await service.getPolicyState({ fresh: true });
    expect(again.version).toBe(4);
    expect(again.policy.providers.anthropic.enabled).toBe(false);
    const chain = await service.resolveChainFor({ companyId: 1, tenant: null });
    expect(chain.skipped).toContainEqual({ provider: "anthropic", why: "disabled" });
    expect(chain.candidates.map((c) => c.provider)).not.toContain("anthropic");
  });
});

describe("credential status — presence and what the provider said, never the key", () => {
  it("reports a missing key by the NAME of its variable only, and makes no call to find out", async () => {
    repo.readSetting.mockResolvedValue({ available: true, row: null });
    const status = await service.getStatus();
    const byProvider = Object.fromEntries(status.providers.map((p) => [p.provider, p.credentials]));
    expect(byProvider.anthropic).toEqual({ configured: false, state: "missing", checkedAt: null, envVar: "ANTHROPIC_API_KEY" });
    expect(byProvider.gemini).toEqual({ configured: false, state: "missing", checkedAt: null, envVar: "GEMINI_API_KEY" });
    expect(service.providerConfigured("anthropic")).toBe(false);
    expect(service.providerConfigured("gemini")).toBe(false);
  });

  it("an outcome on a test model is never taken as evidence about a real key", async () => {
    repo.readSetting.mockResolvedValue({ available: true, row: null });
    service.noteProviderOutcome("anthropic", "stub-model", "success");
    service.noteProviderOutcome("gemini", "stub-auth", "auth_rejected");
    const status = await service.getStatus();
    expect(status.providers.map((p) => p.credentials.state)).toEqual(["missing", "missing"]);
  });

  it("the selectable models are the configured ones — plus the test models, which exist outside production only", () => {
    expect(config.ai.enableStubProvider).toBe(true); // the test environment is not production
    const claude = service.catalog.modelsFor("anthropic");
    expect(claude.slice(0, 3)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(claude.slice(3).every((m) => m.startsWith("stub-"))).toBe(true);
    expect(service.catalog.modelsFor("gemini")[0]).toBe("gemini-2.5-flash");
    expect(service.catalog.defaultPrimary).toBe("anthropic");
  });
});

describe("spending limit admission", () => {
  const limited = (limit: number) => ({
    available: true,
    row: { key: "ai_providers", value: { ...DEFAULT, providers: { ...DEFAULT.providers, anthropic: { ...DEFAULT.providers.anthropic, monthlyLimitMicroUsd: limit } } } as unknown as Record<string, unknown>, version: 2, updatedBy: 1, updatedAt: new Date() },
  });

  it("admits below the limit, refuses at it with 503 AI_PLATFORM_LIMIT_REACHED, and never limits the other provider", async () => {
    repo.readSetting.mockResolvedValue(limited(1_000_000));
    repo.monthSpendOfProvider.mockResolvedValue(999_999);
    await expect(service.admitPlatformSpend("anthropic", "claude-opus-5-5", "a")).resolves.toBe(true);
    service.settlePlatformSpend("anthropic", "a", 1);
    const err = await rejection(service.admitPlatformSpend("anthropic", "claude-opus-5-5", "b"));
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe(service.AI_PLATFORM_LIMIT_REACHED);
    // A neutral sentence: it reaches every AI feature (and is stored with a failed draft),
    // so the capture hint is added on the capture paths only.
    expect(err.message).toBe("AI is not available right now: the platform's monthly AI spending limit has been reached.");
    await expect(service.admitPlatformSpend("gemini", "gemini-2.5-flash", "c")).resolves.toBe(false);
  });

  it("requests in flight count against the limit, so simultaneous requests cannot all slip under it", async () => {
    repo.readSetting.mockResolvedValue(limited(10_000));
    repo.monthSpendOfProvider.mockResolvedValue(0);
    // Each Claude Opus request holds its estimated cost while it runs.
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => service.admitPlatformSpend("anthropic", "claude-opus-5-5", `r${i}`)));
    const admitted = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter((r) => r.status === "rejected").length;
    expect(admitted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(admitted + refused).toBe(20);
    // Releasing the holds makes room again.
    for (let i = 0; i < 20; i++) service.settlePlatformSpend("anthropic", `r${i}`, 0);
    await expect(service.admitPlatformSpend("anthropic", "claude-opus-5-5", "later")).resolves.toBe(true);
  });

  it("a model without a price is refused where a cost budget or a spending limit applies, and allowed where neither does", async () => {
    repo.readSetting.mockResolvedValue({ available: true, row: null });
    await expect(service.assertPricedWhereCostIsEnforced("anthropic", "model-without-a-price", null)).resolves.toBeUndefined();
    const budget = await rejection(service.assertPricedWhereCostIsEnforced("anthropic", "model-without-a-price", 5_000_000));
    expect([budget.statusCode, budget.code]).toEqual([503, service.AI_MODEL_UNPRICED]);
    await expect(service.assertPricedWhereCostIsEnforced("anthropic", "claude-opus-5-5", 5_000_000)).resolves.toBeUndefined();

    service.invalidatePolicyCache();
    repo.readSetting.mockResolvedValue(limited(1_000_000));
    const limit = await rejection(service.assertPricedWhereCostIsEnforced("anthropic", "model-without-a-price", null));
    expect(limit.code).toBe(service.AI_MODEL_UNPRICED);
    // The client is told nothing about models or prices.
    expect(limit.message).not.toMatch(/price|model|anthropic|claude/i);
  });
});
