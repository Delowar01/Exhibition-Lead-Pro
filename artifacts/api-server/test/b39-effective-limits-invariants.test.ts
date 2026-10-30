import { describe, it, expect } from "vitest";
import { LIMIT_RESOURCES, resolveEffectiveLimits } from "../src/lib/billing/lifecycle.js";

// Batch 39 — pure invariants of the SINGLE entitlement resolver that every
// enforcement path, the tenant projection, the platform subscription detail and
// the new read-only plan preview share. These are the properties the versioned
// Plan Builder (PB-2) must preserve: a published plan version can only ever
// change a tenant's effective limits through this function's inputs, and a
// tenant override always shields the tenant from a plan-default change.

const nullPlan = { contactsLimit: null, eventsLimit: null, adminsLimit: null, employeesLimit: null, scansLimit: null, storageLimitMb: null };
const numericPlan = { contactsLimit: 100, eventsLimit: 10, adminsLimit: 2, employeesLimit: 20, scansLimit: 500, storageLimitMb: 1024 };
const byResource = (rows: ReturnType<typeof resolveEffectiveLimits>) => Object.fromEntries(rows.map((r) => [r.resource, r]));

describe("resolveEffectiveLimits — shape", () => {
  it("always returns exactly the six limit resources in catalog order", () => {
    for (const [plan, overrides] of [
      [nullPlan, null],
      [nullPlan, undefined],
      [numericPlan, {}],
      [null, { contacts: 1 }],
      [undefined, null],
    ] as const) {
      const rows = resolveEffectiveLimits(plan as any, overrides as any);
      expect(rows.map((r) => r.resource)).toEqual([...LIMIT_RESOURCES]);
      for (const r of rows) expect(["override", "plan", "unlimited"]).toContain(r.source);
    }
  });

  it("a missing plan row or all-null defaults with no override resolve to unlimited everywhere", () => {
    for (const rows of [resolveEffectiveLimits(nullPlan, null), resolveEffectiveLimits(null, {}), resolveEffectiveLimits(undefined, undefined)]) {
      for (const r of rows) expect(r).toEqual({ resource: r.resource, limit: null, source: "unlimited" });
    }
  });
});

describe("resolveEffectiveLimits — precedence", () => {
  it("plan defaults apply when no override exists (source = plan)", () => {
    const r = byResource(resolveEffectiveLimits(numericPlan, {}));
    expect(r.contacts).toEqual({ resource: "contacts", limit: 100, source: "plan" });
    expect(r.events).toEqual({ resource: "events", limit: 10, source: "plan" });
    expect(r.admins).toEqual({ resource: "admins", limit: 2, source: "plan" });
    expect(r.employees).toEqual({ resource: "employees", limit: 20, source: "plan" });
    expect(r.scans).toEqual({ resource: "scans", limit: 500, source: "plan" });
    expect(r.storageMb).toEqual({ resource: "storageMb", limit: 1024, source: "plan" });
  });

  it("a numeric override wins over any plan default — including 0, and including an unlimited plan", () => {
    const r = byResource(resolveEffectiveLimits(numericPlan, { contacts: 3, events: 0 }));
    expect(r.contacts).toEqual({ resource: "contacts", limit: 3, source: "override" });
    expect(r.events).toEqual({ resource: "events", limit: 0, source: "override" });
    expect(r.admins.source).toBe("plan");
    const u = byResource(resolveEffectiveLimits(nullPlan, { scans: 5 }));
    expect(u.scans).toEqual({ resource: "scans", limit: 5, source: "override" });
    expect(u.contacts).toEqual({ resource: "contacts", limit: null, source: "unlimited" });
  });

  it("a null override means 'no override' (falls back to the plan default) — it is not 'unlimited'", () => {
    const r = byResource(resolveEffectiveLimits(numericPlan, { contacts: null }));
    expect(r.contacts).toEqual({ resource: "contacts", limit: 100, source: "plan" });
  });

  it("malformed overrides and malformed plan defaults are ignored, never trusted (negative, NaN, Infinity, strings, fractions floored)", () => {
    const r = byResource(resolveEffectiveLimits(numericPlan, { contacts: -1, events: Number.NaN, admins: Number.POSITIVE_INFINITY, employees: "7" as any, scans: 4.9 }));
    expect(r.contacts).toEqual({ resource: "contacts", limit: 100, source: "plan" });
    expect(r.events).toEqual({ resource: "events", limit: 10, source: "plan" });
    expect(r.admins).toEqual({ resource: "admins", limit: 2, source: "plan" });
    expect(r.employees).toEqual({ resource: "employees", limit: 20, source: "plan" });
    expect(r.scans).toEqual({ resource: "scans", limit: 4, source: "override" });
    const p = byResource(resolveEffectiveLimits({ ...numericPlan, contactsLimit: -5, eventsLimit: Number.NaN, adminsLimit: 2.7 } as any, {}));
    expect(p.contacts).toEqual({ resource: "contacts", limit: null, source: "unlimited" });
    expect(p.events).toEqual({ resource: "events", limit: null, source: "unlimited" });
    expect(p.admins).toEqual({ resource: "admins", limit: 2, source: "plan" });
  });
});

describe("resolveEffectiveLimits — grandfathering and isolation properties the Plan Builder must keep", () => {
  it("is a pure function of (plan defaults, tenant overrides): identical inputs give identical outputs, and it mutates neither input", () => {
    const plan = { ...numericPlan };
    const overrides = { contacts: 3 as number | null };
    const a = resolveEffectiveLimits(plan, overrides);
    const b = resolveEffectiveLimits(plan, overrides);
    expect(a).toEqual(b);
    expect(plan).toEqual(numericPlan);
    expect(overrides).toEqual({ contacts: 3 });
  });

  it("changing a DIFFERENT plan object never changes a tenant's result (no shared or global state)", () => {
    const tenantPlan = { ...numericPlan };
    const otherPlan = { ...numericPlan };
    const before = resolveEffectiveLimits(tenantPlan, { contacts: 3 });
    otherPlan.eventsLimit = 1;
    otherPlan.contactsLimit = 1;
    const after = resolveEffectiveLimits(tenantPlan, { contacts: 3 });
    expect(after).toEqual(before);
    expect(byResource(resolveEffectiveLimits(otherPlan, {})).events.limit).toBe(1);
  });

  it("publishing stricter defaults for the tenant's plan cannot lower a resource the tenant overrides; it CAN lower a non-overridden resource (why PB-2 pins subscriptions to immutable versions)", () => {
    const v1 = { ...numericPlan };
    const v2 = { ...numericPlan, contactsLimit: 1, eventsLimit: 1 };
    const overrides = { contacts: 50 };
    const underV1 = byResource(resolveEffectiveLimits(v1, overrides));
    const underV2 = byResource(resolveEffectiveLimits(v2, overrides));
    expect(underV1.contacts).toEqual({ resource: "contacts", limit: 50, source: "override" });
    expect(underV2.contacts).toEqual({ resource: "contacts", limit: 50, source: "override" }); // shielded
    expect(underV1.events.limit).toBe(10);
    expect(underV2.events.limit).toBe(1); // NOT shielded — a version pin, not an override, is what keeps v1 for existing tenants
    // Keeping the tenant on v1 (what PB-2 pins) is exactly "same inputs → same outputs":
    expect(byResource(resolveEffectiveLimits(v1, overrides))).toEqual(underV1);
  });
});
