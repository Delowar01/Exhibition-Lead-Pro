// Batch 41 — database-target classification for operator scripts (PURE).
//
// A maintenance script must never infer "this is not production" from
// NODE_ENV alone: the variable is a runtime mode, not proof of which database a
// connection string points at. Scripts that write (backfills) classify the
// configured DATABASE_URL by its host and require an EXPLICIT, matching
// `--expect-host` for anything that is not a loopback address; applying changes
// to a remote host additionally requires the production confirmation flag.
// Nothing here reads process.env or opens a connection.

export type DatabaseTargetClass = "local" | "remote" | "invalid";

export interface DatabaseTarget {
  class: DatabaseTargetClass;
  host: string | null;
  database: string | null;
  // Never includes credentials: safe to print in a report.
  display: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function classifyDatabaseTarget(url: string | undefined | null): DatabaseTarget {
  if (!url || typeof url !== "string" || url.trim() === "") return { class: "invalid", host: null, database: null, display: "(unset)" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { class: "invalid", host: null, database: null, display: "(unparseable)" };
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return { class: "invalid", host: null, database: null, display: `(unsupported scheme ${parsed.protocol})` };
  const host = parsed.hostname.toLowerCase();
  if (!host) return { class: "invalid", host: null, database: null, display: "(no host)" };
  const database = parsed.pathname.replace(/^\//, "") || null;
  const display = `${host}${parsed.port ? `:${parsed.port}` : ""}/${database ?? ""}`;
  return { class: LOCAL_HOSTS.has(host) ? "local" : "remote", host, database, display };
}

export interface TargetGuardInput {
  url: string | undefined | null;
  nodeEnv: string | undefined;
  expectHost: string | undefined;
  confirmProduction: boolean;
  apply: boolean;
}

export type TargetGuardResult = { ok: true; target: DatabaseTarget } | { ok: false; target: DatabaseTarget; code: TargetGuardCode; message: string };

export type TargetGuardCode = "DATABASE_URL_INVALID" | "EXPECT_HOST_REQUIRED" | "EXPECT_HOST_MISMATCH" | "PRODUCTION_CONFIRMATION_REQUIRED";

// Decision table (fail closed):
//   invalid URL                                     → refuse
//   NODE_ENV=production without --confirm-production → refuse (never silently)
//   remote host (anything not loopback)
//       without --expect-host                        → refuse (explicit target required)
//       --expect-host ≠ actual host                  → refuse
//       --apply without --confirm-production         → refuse
//   local host with --expect-host ≠ actual host      → refuse (an explicit expectation is always honoured)
export function guardDatabaseTarget(input: TargetGuardInput): TargetGuardResult {
  const target = classifyDatabaseTarget(input.url);
  if (target.class === "invalid") return { ok: false, target, code: "DATABASE_URL_INVALID", message: `DATABASE_URL is not a usable postgres URL ${target.display}` };
  const expect = input.expectHost?.trim().toLowerCase();
  if (expect !== undefined && expect !== "" && expect !== target.host) {
    return { ok: false, target, code: "EXPECT_HOST_MISMATCH", message: `--expect-host "${expect}" does not match the configured database host "${target.host}"` };
  }
  if (input.nodeEnv === "production" && !input.confirmProduction) {
    return { ok: false, target, code: "PRODUCTION_CONFIRMATION_REQUIRED", message: "NODE_ENV=production: --confirm-production is required (owner authorization)" };
  }
  if (target.class === "remote") {
    if (!expect) return { ok: false, target, code: "EXPECT_HOST_REQUIRED", message: `the configured database host "${target.host}" is not a loopback address; pass --expect-host ${target.host} to confirm the target explicitly` };
    if (input.apply && !input.confirmProduction) {
      return { ok: false, target, code: "PRODUCTION_CONFIRMATION_REQUIRED", message: `applying changes to the non-local database host "${target.host}" requires --confirm-production (owner authorization); NODE_ENV is never taken as proof of a non-production database` };
    }
  }
  return { ok: true, target };
}
