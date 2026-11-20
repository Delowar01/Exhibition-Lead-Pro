// Platform AI provider management — what the settings page is told about a provider's key,
// and when the Platform Owner is alerted (src/services/platform-ai.service.ts).
//
// The status is observational: it changes only with what a provider answered to a real
// request. Here a key is made to LOOK present (the provider registry is replaced, so no
// key exists and nothing can be called), and the outcomes are reported the way the
// execution seam reports them. The repository and the notification service are fakes.
import { describe, it, expect, vi, beforeEach } from "vitest";

const repo = vi.hoisted(() => ({
  readSetting: vi.fn(async () => ({ available: true, row: null })),
  writeSetting: vi.fn(),
  userNames: vi.fn(async () => new Map<number, string>()),
  companyNames: vi.fn(async () => new Map<number, string>()),
  monthUsageByProvider: vi.fn(async () => []),
  monthSpendOfProvider: vi.fn(async () => 0),
  activePlatformOwnerIds: vi.fn(async () => [11, 12]),
  platformAlertSent: vi.fn(async () => false),
  isUndefinedTable: vi.fn(() => false),
}));
const notifications = vi.hoisted(() => ({ createNotification: vi.fn(async (_n: Record<string, unknown>) => undefined) }));
vi.mock("../src/repositories/platform-settings.repository.js", () => repo);
vi.mock("../src/services/notifications.service.js", () => notifications);
// A key is "present" for both providers; nothing here can reach one.
vi.mock("../src/ai/providers/index.js", () => {
  const fake = (name: string) => ({ name, isConfigured: () => true, generate: async () => { throw new Error("no provider is callable in this test"); } });
  return {
    getProvider: (name: string) => fake(name),
    providerFor: (name: string) => fake(name),
    stubRegistered: () => false,
    isRealProvider: (n: unknown) => n === "anthropic" || n === "gemini",
    availableProviders: () => ["gemini", "anthropic"],
    REAL_PROVIDERS: ["anthropic", "gemini"],
  };
});

import * as service from "../src/services/platform-ai.service.js";

const credentials = async (p: "anthropic" | "gemini") => (await service.getStatus()).providers.find((x) => x.provider === p)!.credentials;
const flush = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  vi.clearAllMocks();
  repo.platformAlertSent.mockResolvedValue(false);
  service.invalidatePolicyCache();
  // Start each test from "no evidence": a success clears every recorded problem.
  service.noteProviderOutcome("anthropic", "claude-opus-5-5", "success");
  service.noteProviderOutcome("gemini", "gemini-2.5-flash", "success");
});

describe("credential status follows what the provider actually answered", () => {
  it("a key is 'verified' after an accepted request, 'rejected' after a 401/403, and verified again after the next accepted request", async () => {
    expect((await credentials("anthropic")).state).toBe("verified");
    service.noteProviderOutcome("anthropic", "claude-opus-5-5", "auth_rejected");
    const rejected = await credentials("anthropic");
    expect(rejected.state).toBe("rejected");
    expect(rejected.checkedAt).toBeTruthy();
    expect((await credentials("gemini")).state).toBe("verified"); // per provider
    service.noteProviderOutcome("anthropic", "claude-opus-5-5", "success");
    expect((await credentials("anthropic")).state).toBe("verified");
  });

  it("a billing stop or account spend cap is shown as 'account_stopped' — not as a healthy key — until a request is accepted again", async () => {
    service.noteProviderOutcome("anthropic", "claude-opus-5-5", "account_stopped");
    expect((await credentials("anthropic")).state).toBe("account_stopped");
    service.noteProviderOutcome("anthropic", "claude-sonnet-5-5", "success");
    expect((await credentials("anthropic")).state).toBe("verified");
  });

  it("the most recent problem is the one shown", async () => {
    service.noteProviderOutcome("gemini", "gemini-2.5-flash", "account_stopped");
    await flush();
    service.noteProviderOutcome("gemini", "gemini-2.5-flash", "auth_rejected");
    expect((await credentials("gemini")).state).toBe("rejected");
  });

  it("the status never carries a key: only presence, state, a time and the variable's name", async () => {
    const c = await credentials("anthropic");
    expect(Object.keys(c).sort()).toEqual(["checkedAt", "configured", "envVar", "state"]);
    expect(c.envVar).toBe("ANTHROPIC_API_KEY");
  });
});

describe("the Platform Owner is alerted when a provider rejects the key or stops the account", () => {
  it("a rejected key notifies every active platform owner once, with a link to the settings and nothing about any tenant", async () => {
    service.noteProviderOutcome("anthropic", "claude-opus-5-5", "auth_rejected");
    await flush();
    expect(repo.platformAlertSent).toHaveBeenCalledWith("ai_provider_problem", "key_rejected", "anthropic", expect.any(Date));
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
    const sent = notifications.createNotification.mock.calls.map((c) => c[0]);
    expect(sent.map((n) => n.userId)).toEqual([11, 12]);
    for (const n of sent) {
      expect(n).toMatchObject({ companyId: null, category: "ai", link: "/platform/settings", metadata: { kind: "ai_provider_problem", subkind: "key_rejected", provider: "anthropic" } });
      expect(String(n.title)).toBe("Claude rejected the AI provider key");
      expect(String(n.body)).toMatch(/ANTHROPIC_API_KEY/); // the variable's NAME — where to fix it
      expect(String(n.body)).not.toMatch(/sk-ant-/);
    }
  });

  it("a stopped account says that requests are not moved to the other provider", async () => {
    service.noteProviderOutcome("gemini", "gemini-2.5-flash", "account_stopped");
    await flush();
    const sent = notifications.createNotification.mock.calls.map((c) => c[0]);
    expect(sent).toHaveLength(2);
    expect(String(sent[0].title)).toBe("Gemini account stopped by the provider");
    expect(String(sent[0].body)).toMatch(/not moved to the other provider/);
    expect(sent[0].metadata).toMatchObject({ kind: "ai_provider_problem", subkind: "account_stopped", provider: "gemini" });
  });

  it("is sent once per provider and kind per day, however many requests fail", async () => {
    repo.platformAlertSent.mockResolvedValue(true); // already sent today
    for (let i = 0; i < 5; i++) service.noteProviderOutcome("anthropic", "claude-opus-5-5", "auth_rejected");
    await flush();
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it("nothing is recorded or sent for a test model — it says nothing about a real key", async () => {
    service.noteProviderOutcome("anthropic", "stub-auth", "auth_rejected");
    service.noteProviderOutcome("anthropic", "stub-quota", "account_stopped");
    service.noteProviderOutcome("stub", "stub-model", "auth_rejected");
    await flush();
    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect((await credentials("anthropic")).state).toBe("verified");
  });
});
