import { describe, it, expect } from "vitest";
import { classifyDatabaseTarget, guardDatabaseTarget } from "../src/lib/db-target.js";

// Batch 41 — PURE database-target guard for operator scripts. The guard never
// takes NODE_ENV as proof of a non-production database: a non-loopback host
// always needs an explicit, matching --expect-host, and applying to it needs
// --confirm-production as well.

const local = "postgresql://user:secret@localhost:5432/dev";
const remote = "postgres://user:secret@db.internal.example:5432/leadcapture";

describe("classifyDatabaseTarget", () => {
  it("classifies loopback hosts as local, everything else as remote, and never echoes credentials", () => {
    expect(classifyDatabaseTarget(local)).toEqual({ class: "local", host: "localhost", database: "dev", display: "localhost:5432/dev" });
    expect(classifyDatabaseTarget("postgresql://u:p@127.0.0.1/x").class).toBe("local");
    expect(classifyDatabaseTarget("postgresql://u:p@[::1]:5432/x").class).toBe("local");
    const r = classifyDatabaseTarget(remote);
    expect(r).toMatchObject({ class: "remote", host: "db.internal.example", database: "leadcapture" });
    expect(r.display).not.toContain("secret");
    expect(r.display).not.toContain("user");
  });

  it("refuses unset, unparseable and non-postgres URLs", () => {
    expect(classifyDatabaseTarget(undefined).class).toBe("invalid");
    expect(classifyDatabaseTarget("").class).toBe("invalid");
    expect(classifyDatabaseTarget("not a url").class).toBe("invalid");
    expect(classifyDatabaseTarget("mysql://u:p@localhost/x").class).toBe("invalid");
    expect(classifyDatabaseTarget("postgresql:///nohost").class).toBe("invalid");
  });
});

describe("guardDatabaseTarget (fail closed)", () => {
  const base = { nodeEnv: undefined as string | undefined, expectHost: undefined as string | undefined, confirmProduction: false, apply: false };

  it("a local database runs without flags, for dry-run and apply", () => {
    expect(guardDatabaseTarget({ ...base, url: local }).ok).toBe(true);
    expect(guardDatabaseTarget({ ...base, url: local, apply: true }).ok).toBe(true);
    expect(guardDatabaseTarget({ ...base, url: local, expectHost: "localhost" }).ok).toBe(true);
    expect(guardDatabaseTarget({ ...base, url: local, expectHost: "LOCALHOST" }).ok).toBe(true);
  });

  it("an explicit expectation that does not match the configured host is always refused, even locally", () => {
    const r = guardDatabaseTarget({ ...base, url: local, expectHost: "db.internal.example" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("EXPECT_HOST_MISMATCH");
  });

  it("NODE_ENV=production is never silently accepted: --confirm-production is required even for a dry run on a local database", () => {
    const r = guardDatabaseTarget({ ...base, url: local, nodeEnv: "production" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PRODUCTION_CONFIRMATION_REQUIRED");
    expect(guardDatabaseTarget({ ...base, url: local, nodeEnv: "production", confirmProduction: true }).ok).toBe(true);
  });

  it("a non-loopback host requires an explicit matching --expect-host; NODE_ENV=development is NOT proof of a safe target", () => {
    const noExpect = guardDatabaseTarget({ ...base, url: remote, nodeEnv: "development" });
    expect(noExpect.ok).toBe(false);
    if (!noExpect.ok) expect(noExpect.code).toBe("EXPECT_HOST_REQUIRED");
    const wrong = guardDatabaseTarget({ ...base, url: remote, nodeEnv: "development", expectHost: "other.example" });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe("EXPECT_HOST_MISMATCH");
    expect(guardDatabaseTarget({ ...base, url: remote, nodeEnv: "development", expectHost: "db.internal.example" }).ok).toBe(true);
  });

  it("applying changes to a non-loopback host additionally requires --confirm-production", () => {
    const r = guardDatabaseTarget({ ...base, url: remote, expectHost: "db.internal.example", apply: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PRODUCTION_CONFIRMATION_REQUIRED");
    expect(guardDatabaseTarget({ ...base, url: remote, expectHost: "db.internal.example", apply: true, confirmProduction: true }).ok).toBe(true);
  });

  it("an invalid URL is refused before anything else", () => {
    const r = guardDatabaseTarget({ ...base, url: "nope", expectHost: "localhost", confirmProduction: true, apply: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DATABASE_URL_INVALID");
  });
});
