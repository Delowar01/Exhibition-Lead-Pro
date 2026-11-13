import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { pool } from "@workspace/db";
import {
  classifyDatabaseTarget,
  isLoopbackAddress,
  parseEnvironmentMarker,
  verifyDatabaseIdentity,
  type DatabaseIdentityFacts,
} from "../src/lib/db-target.js";
import { collectDatabaseIdentity } from "../src/lib/db-identity.js";

// Batch 42 — database IDENTITY verification for the backfill script. The URL
// guard (Batch 41) cannot see an SSH tunnel or a forwarded container port: a
// loopback URL may reach a database that is not local at all. The identity
// layer verifies what the CONNECTED server says about itself against the
// operator's explicit expectations and fails closed.

const localTarget = classifyDatabaseTarget("postgresql://u:p@localhost:5432/devdb");
const remoteTarget = classifyDatabaseTarget("postgresql://u:p@db.internal.example:5432/app");

const facts = (over: Partial<DatabaseIdentityFacts> = {}): DatabaseIdentityFacts => ({
  database: "devdb",
  serverAddr: "127.0.0.1",
  serverPort: 5432,
  systemIdentifier: "7000000000000000001",
  environmentMarker: null,
  serverVersion: "PostgreSQL 16",
  postmasterStartedAt: "2026-01-01T00:00:00.000Z",
  clusterName: null,
  ...over,
});

const base = { target: localTarget, apply: false, confirmProduction: false, allowForwarded: false, expectDatabase: undefined as string | undefined, expectSystemId: undefined as string | undefined, expectEnvironment: undefined as string | undefined };

function code(r: ReturnType<typeof verifyDatabaseIdentity>): string {
  return r.ok ? "OK" : r.code;
}

describe("pure helpers", () => {
  it("recognises loopback addresses in every form and nothing else", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "::ffff:127.0.0.1", "127.0.0.1/32", "LOCALHOST"]) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of ["10.0.0.5", "192.168.1.10", "172.17.0.2", "::ffff:10.0.0.5", "fe80::1", "", null, undefined]) expect(isLoopbackAddress(a), String(a)).toBe(false);
  });

  it("parses the environment marker from a database comment, case-insensitively, ignoring unrelated text", () => {
    expect(parseEnvironmentMarker("environment=production")).toBe("production");
    expect(parseEnvironmentMarker("Lead Capture Pro; Environment=Staging; owner=ops")).toBe("staging");
    expect(parseEnvironmentMarker("environment = local")).toBe("local");
    expect(parseEnvironmentMarker("my environment=prod-eu-1 cluster")).toBe("prod-eu-1");
    expect(parseEnvironmentMarker("production database")).toBeNull();
    expect(parseEnvironmentMarker("environment=")).toBeNull();
    expect(parseEnvironmentMarker("environment=../etc")).toBeNull();
    expect(parseEnvironmentMarker(null)).toBeNull();
    expect(parseEnvironmentMarker("")).toBeNull();
  });
});

describe("verifyDatabaseIdentity (fail closed)", () => {
  it("a local dry run without expectations passes but warns about the missing marker and the unreadable system id", () => {
    const r = verifyDatabaseIdentity({ ...base, facts: facts({ systemIdentifier: null }) });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/no environment marker/);
    expect(r.warnings.join(" ")).toMatch(/system identifier not readable/);
    expect(r.identity.forwarded).toBe(false);
  });

  it("--apply always requires --expect-database, and an expectation is always honoured", () => {
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts(), apply: true }))).toBe("EXPECT_DATABASE_REQUIRED");
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts(), apply: true, expectDatabase: "devdb" }))).toBe("OK");
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts(), expectDatabase: "production_db" }))).toBe("EXPECT_DATABASE_MISMATCH");
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts({ database: null }), expectDatabase: "devdb" }))).toBe("EXPECT_DATABASE_MISMATCH");
    // whitespace-only expectation = no expectation
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts(), expectDatabase: "   " }))).toBe("OK");
  });

  it("the system identifier is verified only when expected; an unreadable fact never matches", () => {
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts(), expectSystemId: "7000000000000000001" }))).toBe("OK");
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts(), expectSystemId: "7000000000000000002" }))).toBe("SYSTEM_ID_MISMATCH");
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts({ systemIdentifier: null }), expectSystemId: "7000000000000000001" }))).toBe("SYSTEM_ID_UNAVAILABLE");
  });

  it("environment markers: expectations are verified, a missing marker cannot satisfy one, and a marked database must be named explicitly to --apply", () => {
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts({ environmentMarker: "local" }), expectEnvironment: "local" }))).toBe("OK");
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts({ environmentMarker: "local" }), expectEnvironment: "LOCAL" }))).toBe("OK");
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts({ environmentMarker: "staging" }), expectEnvironment: "local" }))).toBe("ENVIRONMENT_MARKER_MISMATCH");
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts(), expectEnvironment: "local" }))).toBe("ENVIRONMENT_MARKER_MISSING");
    // marked database, apply without naming it
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts({ environmentMarker: "staging" }), apply: true, expectDatabase: "devdb" }))).toBe("ENVIRONMENT_EXPECTATION_REQUIRED");
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts({ environmentMarker: "staging" }), apply: true, expectDatabase: "devdb", expectEnvironment: "staging" }))).toBe("OK");
    // unmarked database: apply needs only the database name (unchanged local flow)
    expect(code(verifyDatabaseIdentity({ ...base, facts: facts(), apply: true, expectDatabase: "devdb" }))).toBe("OK");
  });

  it("a database that declares itself production refuses even a dry run without --confirm-production, and --apply without the explicit environment acknowledgement", () => {
    const prod = facts({ environmentMarker: "production", database: "leadcapture" });
    expect(code(verifyDatabaseIdentity({ ...base, facts: prod }))).toBe("PRODUCTION_CONFIRMATION_REQUIRED");
    expect(code(verifyDatabaseIdentity({ ...base, facts: prod, confirmProduction: true }))).toBe("OK");
    expect(code(verifyDatabaseIdentity({ ...base, facts: prod, confirmProduction: true, apply: true, expectDatabase: "leadcapture" }))).toBe("ENVIRONMENT_EXPECTATION_REQUIRED");
    expect(code(verifyDatabaseIdentity({ ...base, facts: prod, confirmProduction: true, apply: true, expectDatabase: "leadcapture", expectEnvironment: "production" }))).toBe("OK");
    // the operator believed it was local (expected marker local): mismatch wins before the production rule
    expect(code(verifyDatabaseIdentity({ ...base, facts: prod, expectEnvironment: "local" }))).toBe("ENVIRONMENT_MARKER_MISMATCH");
  });

  it("a forwarded connection (loopback URL, non-loopback server address) is refused unless acknowledged, and applying over it still needs --confirm-production", () => {
    const tunnel = facts({ serverAddr: "10.20.30.40" });
    const r = verifyDatabaseIdentity({ ...base, facts: tunnel });
    expect(code(r)).toBe("FORWARDED_CONNECTION_SUSPECTED");
    expect(r.identity.forwarded).toBe(true);
    expect(code(verifyDatabaseIdentity({ ...base, facts: tunnel, allowForwarded: true }))).toBe("OK");
    expect(code(verifyDatabaseIdentity({ ...base, facts: tunnel, allowForwarded: true, apply: true, expectDatabase: "devdb" }))).toBe("PRODUCTION_CONFIRMATION_REQUIRED");
    expect(code(verifyDatabaseIdentity({ ...base, facts: tunnel, allowForwarded: true, apply: true, expectDatabase: "devdb", confirmProduction: true }))).toBe("OK");
    // a Unix-socket connection (null address) and a loopback address are not forwarded
    expect(verifyDatabaseIdentity({ ...base, facts: facts({ serverAddr: null }) }).identity.forwarded).toBe(false);
    expect(verifyDatabaseIdentity({ ...base, facts: facts({ serverAddr: "::1" }) }).identity.forwarded).toBe(false);
    // a remote URL reaching a non-loopback address is consistent, not forwarded
    expect(verifyDatabaseIdentity({ ...base, target: remoteTarget, facts: facts({ database: "app", serverAddr: "10.20.30.40" }) }).identity.forwarded).toBe(false);
  });

  it("the worst case — a tunnel into a production database behind a loopback URL — is refused by three independent rules", () => {
    const tunnelToProd = facts({ database: "leadcapture", serverAddr: "10.0.0.9", environmentMarker: "production" });
    // operator believed it was the local dev database
    expect(code(verifyDatabaseIdentity({ ...base, facts: tunnelToProd, apply: true, expectDatabase: "devdb" }))).toBe("EXPECT_DATABASE_MISMATCH");
    // even with the right name, the marker demands confirmation
    expect(code(verifyDatabaseIdentity({ ...base, facts: tunnelToProd, apply: true, expectDatabase: "leadcapture" }))).toBe("PRODUCTION_CONFIRMATION_REQUIRED");
    // and with confirmation + environment, the forwarded connection still has to be acknowledged
    expect(code(verifyDatabaseIdentity({ ...base, facts: tunnelToProd, apply: true, expectDatabase: "leadcapture", confirmProduction: true, expectEnvironment: "production" }))).toBe("FORWARDED_CONNECTION_SUSPECTED");
  });

  it("the identity summary never carries credentials and the refusal messages never echo the URL", () => {
    const r = verifyDatabaseIdentity({ ...base, facts: facts(), expectDatabase: "other" });
    expect(JSON.stringify(r)).not.toMatch(/u:p@|secret|password/);
  });
});

describe("collectDatabaseIdentity against the isolated local database", () => {
  const url = process.env.DATABASE_URL;
  const target = classifyDatabaseTarget(url);

  it("reports the connected database name matching the URL, a loopback or socket server address, and a nullable system id", async () => {
    expect(target.class, "tests run only against a loopback database").toBe("local");
    const client = await pool.connect();
    try {
      const f = await collectDatabaseIdentity(async (sql) => (await client.query(sql)).rows);
      expect(f.database).toBe(target.database);
      expect(f.serverAddr === null || isLoopbackAddress(f.serverAddr)).toBe(true);
      expect(typeof f.serverVersion).toBe("string");
      expect(f.systemIdentifier === null || /^\d+$/.test(f.systemIdentifier)).toBe(true);
      const v = verifyDatabaseIdentity({ ...base, target, facts: f, apply: true, expectDatabase: target.database ?? "", expectEnvironment: f.environmentMarker ?? undefined });
      expect(v.ok, JSON.stringify(v)).toBe(true);
      expect(v.identity.forwarded).toBe(false);
    } finally {
      client.release();
    }
  });
});

describe("operator CLI identity guards (local database; nothing is applied)", () => {
  const cliDir = process.cwd();
  const target = classifyDatabaseTarget(process.env.DATABASE_URL);
  function cli(args: string[], env: Record<string, string | undefined> = {}) {
    try {
      const out = execFileSync("pnpm", ["exec", "tsx", "scripts/backfill-plan-versions.ts", ...args], { cwd: cliDir, env: { ...process.env, NODE_ENV: "development", ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
      return { code: 0, out };
    } catch (err: any) {
      return { code: typeof err.status === "number" ? err.status : -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  }

  it("a dry run prints the identity facts and honours --expect-database; --apply without it is refused before the backfill runs", () => {
    const wrong = cli(["--expect-database", "definitely_not_this_database"]);
    expect(wrong.code).toBe(2);
    expect(wrong.out).toMatch(/database identity: database=/);
    expect(wrong.out).toMatch(/EXPECT_DATABASE_MISMATCH/);
    expect(wrong.out).not.toMatch(/mode=dry-run/); // refused before any backfill evaluation
    const applyNoName = cli(["--apply"]);
    expect(applyNoName.code).toBe(2);
    expect(applyNoName.out).toMatch(/EXPECT_DATABASE_REQUIRED/);
    expect(applyNoName.out).not.toMatch(/mode=/);
    const sysId = cli(["--expect-system-id", "1"]);
    expect(sysId.code).toBe(2);
    expect(sysId.out).toMatch(/SYSTEM_ID_(MISMATCH|UNAVAILABLE)/);
    const ok = cli(["--expect-database", target.database ?? ""]);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toMatch(/database identity: database=\S+ serverAddr=\S+/);
    expect(ok.out).toMatch(/forwarded=false/);
    expect(ok.out).toMatch(/mode=dry-run verdict=DRY_RUN_OK/);
  });
});
