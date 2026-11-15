import { describe, expect, it } from "vitest";

import { assistantAllowed, featureAllowed, featureEnforcementOf } from "./entitlements";

// Batch 41 (PB-3): the mobile visibility model must mirror the server's
// decision exactly — deny only on an explicit `false`, never on absence.
const allowed = { "ai.assistant": true, "nfc.capture": true, documents: true };

function userWith(features: Record<string, boolean> | null, featureEnforcement: "legacy" | "enforced" | "invalid" = "enforced") {
  if (features === null) return { entitlements: null };
  return {
    entitlements: {
      planVersionId: 7,
      featureEnforcement,
      features,
      trialPolicy: { endOutcome: "blocked" as const, readOnlyGraceDays: 0, graceEndsAt: null },
    },
  };
}

describe("featureAllowed", () => {
  it("allows everything when the user carries no tenant entitlements (platform operator / legacy session)", () => {
    expect(featureAllowed(null, "nfc.capture")).toBe(true);
    expect(featureAllowed(undefined, "documents")).toBe(true);
    expect(featureAllowed(userWith(null), "ai.assistant")).toBe(true);
    expect(featureAllowed({}, "documents")).toBe(true);
  });

  it("allows a feature the server resolved as true", () => {
    const user = userWith(allowed, "legacy");
    expect(featureAllowed(user, "ai.assistant")).toBe(true);
    expect(featureAllowed(user, "nfc.capture")).toBe(true);
    expect(featureAllowed(user, "documents")).toBe(true);
  });

  it("denies only an explicit false (an enforced version that excludes the feature)", () => {
    const user = userWith({ ...allowed, "nfc.capture": false, documents: false });
    expect(featureAllowed(user, "nfc.capture")).toBe(false);
    expect(featureAllowed(user, "documents")).toBe(false);
    expect(featureAllowed(user, "ai.assistant")).toBe(true);
  });

  it("treats a key the server did not resolve as allowed (never invents a denial on the client)", () => {
    const user = userWith({ "ai.assistant": true });
    expect(featureAllowed(user, "workflow.intelligence")).toBe(true);
  });

  it("an invalid version reference denies every feature the server denied", () => {
    const user = userWith({ "ai.assistant": false, "nfc.capture": false, documents: false }, "invalid");
    expect(featureAllowed(user, "ai.assistant")).toBe(false);
    expect(featureEnforcementOf(user)).toBe("invalid");
  });

  it("exposes the enforcement mode (null without entitlements)", () => {
    expect(featureEnforcementOf(null)).toBeNull();
    expect(featureEnforcementOf(userWith(allowed, "legacy"))).toBe("legacy");
    expect(featureEnforcementOf(userWith(allowed))).toBe("enforced");
  });
});

// Release correction M4: the API gates the assistant routes on BOTH features
// (deny wins); the mobile entry points must reach the same answer.
describe("assistantAllowed", () => {
  it("needs both ai.assistant and ai.command_center — either explicit denial hides the assistant", () => {
    expect(assistantAllowed(userWith({ "ai.assistant": true, "ai.command_center": true }))).toBe(true);
    expect(assistantAllowed(userWith({ "ai.assistant": true, "ai.command_center": false }))).toBe(false);
    expect(assistantAllowed(userWith({ "ai.assistant": false, "ai.command_center": true }))).toBe(false);
    expect(assistantAllowed(userWith({ "ai.assistant": false, "ai.command_center": false }))).toBe(false);
  });

  it("a legacy tenant (every feature true) and a session without entitlements keep the assistant", () => {
    expect(assistantAllowed(userWith({ "ai.assistant": true, "ai.command_center": true }, "legacy"))).toBe(true);
    expect(assistantAllowed(userWith(null))).toBe(true);
    expect(assistantAllowed(null)).toBe(true);
    expect(assistantAllowed(undefined)).toBe(true);
  });

  it("never invents a denial for a key the server did not resolve", () => {
    expect(assistantAllowed(userWith({ "ai.assistant": true }))).toBe(true);
    expect(assistantAllowed(userWith({}))).toBe(true);
  });
});
