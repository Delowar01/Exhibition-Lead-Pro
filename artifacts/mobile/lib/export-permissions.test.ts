import { describe, expect, it } from "vitest";

import type { User } from "@workspace/api-client-react";

import { canExport } from "./export-permissions";

// `canExport` mirrors the server's export gate (primary_admin bypasses the
// tenant permission matrix; admin / employee need reports:view; platform_owner
// is blocked by requireTenantUser). The client must stay in lockstep with that
// rule, so each branch is pinned here.

function user(partial: Record<string, unknown>): User {
  return { id: 1, email: "person@example.test", role: "employee", ...partial } as unknown as User;
}

describe("canExport", () => {
  it("denies when nobody is signed in", () => {
    expect(canExport(null)).toBe(false);
  });

  it("allows primary_admin without consulting the permission matrix", () => {
    expect(canExport(user({ role: "primary_admin" }))).toBe(true);
    expect(canExport(user({ role: "primary_admin", permissions: {} }))).toBe(true);
    expect(canExport(user({ role: "primary_admin", permissions: { reports: [] } }))).toBe(true);
  });

  it("allows admin / employee only with reports:view", () => {
    expect(canExport(user({ role: "admin", permissions: { reports: ["view"] } }))).toBe(true);
    expect(canExport(user({ role: "employee", permissions: { reports: ["view", "export"] } }))).toBe(true);
    expect(canExport(user({ role: "admin", permissions: { reports: ["export"] } }))).toBe(false);
    expect(canExport(user({ role: "employee", permissions: { reports: [] } }))).toBe(false);
  });

  it("denies by default when the permission matrix is empty or missing", () => {
    expect(canExport(user({ role: "admin" }))).toBe(false);
    expect(canExport(user({ role: "admin", permissions: {} }))).toBe(false);
    expect(canExport(user({ role: "employee", permissions: null }))).toBe(false);
    expect(canExport(user({ role: "employee", permissions: { contacts: ["view"] } }))).toBe(false);
  });

  it("never offers export to a platform operator, even with reports:view", () => {
    expect(canExport(user({ role: "platform_owner", permissions: { reports: ["view"] } }))).toBe(false);
    expect(canExport(user({ role: "platform_owner" }))).toBe(false);
  });
});
